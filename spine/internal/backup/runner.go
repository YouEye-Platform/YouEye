package backup

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// BackupConfig is the request body for POST /api/backup/run.
type BackupConfig struct {
	TargetPath  string   `json:"target_path"`
	Passphrase  string   `json:"passphrase"`
	Containers  []string `json:"containers"`   // containers to stop/export (from CP)
	VolumePaths []string `json:"volume_paths"`  // host-side volume paths to copy
	StagingDir  string   `json:"staging_dir"`   // where CP placed dumps/configs
	Hostname    string   `json:"hostname"`
	Mode        string   `json:"mode"`          // "live" (default) or "stop"
	BackupType  string   `json:"backup_type"`   // "app", "core", or "full"
	AppID       string   `json:"app_id"`        // for per-app backups
}

// BackupResult is returned upon completion.
type BackupResult struct {
	BackupID    string `json:"backup_id"`
	ArchivePath string `json:"archive_path"`
	ArchiveSize int64  `json:"archive_size"`
}

// generateBackupID creates a short random backup ID.
func generateBackupID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Run executes the backup pipeline in the background.
// CP orchestrates the sequence; Spine handles host-level operations.
func Run(cfg BackupConfig) (string, error) {
	backupID := generateBackupID()

	// Default mode to "live" if not specified
	if cfg.Mode == "" {
		cfg.Mode = "live"
	}

	// Resolve structured output directory based on backup type
	targetPath := resolveTargetPath(cfg.TargetPath, cfg.BackupType, cfg.AppID)
	cfg.TargetPath = targetPath

	// Ensure target path exists
	if err := os.MkdirAll(cfg.TargetPath, 0755); err != nil {
		return "", fmt.Errorf("target path not writable: %w", err)
	}

	// Build stages list based on mode
	stages := []string{}
	if len(cfg.Containers) > 0 {
		if cfg.Mode == "live" {
			stages = append(stages, "snapshot-containers")
		} else {
			stages = append(stages, "stop-containers")
		}
	}
	if len(cfg.VolumePaths) > 0 {
		stages = append(stages, "export-volumes")
	}
	stages = append(stages, "archive", "encrypt", "write-target")
	if len(cfg.Containers) > 0 && cfg.Mode == "stop" {
		stages = append(stages, "restart-containers")
	}
	if len(cfg.Containers) > 0 && cfg.Mode == "live" {
		stages = append(stages, "cleanup-snapshots")
	}

	Start(backupID, stages)

	go runPipeline(backupID, cfg, stages)

	return backupID, nil
}

// resolveTargetPath returns the structured output directory for backups.
// Per-app: {target}/youeye/apps/{appId}/
// Core:    {target}/youeye/core/
// Full:    {target}/youeye/full/
func resolveTargetPath(basePath, backupType, appID string) string {
	switch backupType {
	case "app":
		if appID != "" {
			return filepath.Join(basePath, "youeye", "apps", appID)
		}
		return filepath.Join(basePath, "youeye", "apps")
	case "core":
		return filepath.Join(basePath, "youeye", "core")
	case "full":
		return filepath.Join(basePath, "youeye", "full")
	default:
		return basePath
	}
}

// resolveArchiveName returns the archive filename based on backup type.
func resolveArchiveName(backupType, appID, timestamp string) string {
	switch backupType {
	case "app":
		if appID != "" {
			return fmt.Sprintf("%s-%s.tar", appID, timestamp)
		}
		return fmt.Sprintf("app-%s.tar", timestamp)
	case "core":
		return fmt.Sprintf("core-%s.tar", timestamp)
	case "full":
		return fmt.Sprintf("full-%s.tar", timestamp)
	default:
		return fmt.Sprintf("youeye-backup-%s.tar", timestamp)
	}
}

func runPipeline(backupID string, cfg BackupConfig, stages []string) {
	stepIndex := 0

	// Helper to advance the step counter
	nextStep := func(status, stage, message string, progress int) {
		stepIndex++
		Emit(backupID, status, stage, message, progress, stepIndex, len(stages))
	}

	// Track snapshot names for cleanup
	var snapshotNames []string

	if cfg.Mode == "stop" {
		// Stop mode: ensure containers are restarted even on failure
		defer func() {
			if len(cfg.Containers) > 0 {
				nextStep(StatusRestarting, "restart-containers", "Restarting containers...", 85)
				for _, c := range cfg.Containers {
					restartContainer(c)
				}
			}
		}()
	} else {
		// Live mode: ensure cleanup happens even on failure
		defer func() {
			driver := DetectStorageDriver()
			if driver == "zfs" {
				// Clean up snapshots
				for _, c := range cfg.Containers {
					deleteSnapshot(c, "backup-temp")
				}
			} else {
				// Unfreeze any frozen containers
				for _, c := range cfg.Containers {
					unfreezeContainer(c)
				}
			}
		}()
	}

	// 1. Prepare containers based on mode
	if len(cfg.Containers) > 0 {
		if cfg.Mode == "stop" {
			// Legacy stop mode
			nextStep(StatusStopping, "stop-containers", "Stopping containers...", 5)
			for _, c := range cfg.Containers {
				Emit(backupID, StatusStopping, "stop-containers",
					fmt.Sprintf("Stopping %s...", c), 5, stepIndex, len(stages))
				if err := stopContainer(c); err != nil {
					Fail(backupID, fmt.Sprintf("Failed to stop container %s: %v", c, err))
					return
				}
				if err := waitContainerStopped(c, 60*time.Second); err != nil {
					Fail(backupID, fmt.Sprintf("Container %s did not stop in time: %v", c, err))
					return
				}
			}
		} else {
			// Live mode
			driver := DetectStorageDriver()
			if driver == "zfs" {
				nextStep(StatusExporting, "snapshot-containers", "Creating ZFS snapshots...", 5)
				for _, c := range cfg.Containers {
					Emit(backupID, StatusExporting, "snapshot-containers",
						fmt.Sprintf("Snapshotting %s...", c), 5, stepIndex, len(stages))
					if err := createSnapshot(c, "backup-temp"); err != nil {
						Fail(backupID, fmt.Sprintf("Failed to snapshot container %s: %v", c, err))
						return
					}
					snapshotNames = append(snapshotNames, c)
				}
			} else {
				// Dir backend: freeze containers
				nextStep(StatusExporting, "snapshot-containers", "Freezing containers...", 5)
				for _, c := range cfg.Containers {
					Emit(backupID, StatusExporting, "snapshot-containers",
						fmt.Sprintf("Freezing %s...", c), 5, stepIndex, len(stages))
					if err := freezeContainer(c); err != nil {
						Fail(backupID, fmt.Sprintf("Failed to freeze container %s: %v", c, err))
						return
					}
				}
			}
		}
	}

	// 2. Export volumes (filesystem copy)
	if len(cfg.VolumePaths) > 0 {
		nextStep(StatusExporting, "export-volumes", "Exporting volumes...", 20)
		for _, volPath := range cfg.VolumePaths {
			if _, err := os.Stat(volPath); os.IsNotExist(err) {
				continue
			}
			destDir := filepath.Join(cfg.StagingDir, "volumes", filepath.Base(volPath))
			if err := os.MkdirAll(filepath.Dir(destDir), 0755); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to create volume dest dir: %v", err))
				return
			}
			Emit(backupID, StatusExporting, "export-volumes",
				fmt.Sprintf("Copying %s...", volPath), 25, stepIndex, len(stages))
			cmd := exec.Command("cp", "-a", volPath, destDir)
			if out, err := cmd.CombinedOutput(); err != nil {
				Fail(backupID, fmt.Sprintf("Volume copy failed for %s: %v\n%s", volPath, err, string(out)))
				return
			}
		}
	}

	// In live mode, release containers now that volumes are copied
	if cfg.Mode == "live" && len(cfg.Containers) > 0 {
		driver := DetectStorageDriver()
		if driver == "zfs" {
			nextStep(StatusExporting, "cleanup-snapshots", "Cleaning up snapshots...", 35)
			for _, c := range snapshotNames {
				deleteSnapshot(c, "backup-temp")
			}
			// Clear so deferred cleanup doesn't double-delete
			snapshotNames = nil
		} else {
			nextStep(StatusExporting, "cleanup-snapshots", "Unfreezing containers...", 35)
			for _, c := range cfg.Containers {
				if err := unfreezeContainer(c); err != nil {
					Fail(backupID, fmt.Sprintf("Failed to unfreeze container %s: %v", c, err))
					return
				}
			}
		}
	}

	// 3. Archive staging dir as tar
	nextStep(StatusArchiving, "archive", "Creating archive...", 50)
	timestamp := time.Now().Format("20060102-150405")
	hostname := cfg.Hostname
	if hostname == "" {
		hostname = "youeye"
	}

	var archiveName string
	if cfg.BackupType != "" {
		archiveName = resolveArchiveName(cfg.BackupType, cfg.AppID, timestamp)
	} else {
		archiveName = fmt.Sprintf("youeye-backup-%s-%s.tar", hostname, timestamp)
	}
	tarPath := filepath.Join(cfg.StagingDir, archiveName)

	tarCmd := exec.Command("tar", "-cf", tarPath, "-C", cfg.StagingDir, ".")
	if out, err := tarCmd.CombinedOutput(); err != nil {
		Fail(backupID, fmt.Sprintf("Archive creation failed: %v\n%s", err, string(out)))
		return
	}

	// 4. Encrypt with AES-256-CBC
	nextStep(StatusEncrypting, "encrypt", "Encrypting archive...", 65)
	encPath := tarPath + ".enc"
	encCmd := exec.Command("openssl", "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
		"-in", tarPath, "-out", encPath, "-pass", "pass:"+cfg.Passphrase)
	if out, err := encCmd.CombinedOutput(); err != nil {
		Fail(backupID, fmt.Sprintf("Encryption failed: %v\n%s", err, string(out)))
		return
	}

	os.Remove(tarPath)

	// Write RESTORE.txt alongside
	restoreContent := fmt.Sprintf(
		"# YouEye Backup Restore Instructions\n\n"+
			"Backup created: %s\n"+
			"Hostname: %s\n\n"+
			"## Decrypt\n\n"+
			"openssl enc -d -aes-256-cbc -pbkdf2 -in %s -out backup.tar -pass pass:YOUR_PASSPHRASE\n\n"+
			"## Extract\n\n"+
			"mkdir restore && tar -xf backup.tar -C restore\n\n"+
			"## Contents\n\n"+
			"- configs/     — platform configuration files\n"+
			"- databases/   — PostgreSQL dump files (.sql)\n"+
			"- volumes/     — application data volumes\n",
		timestamp, hostname, filepath.Base(encPath),
	)
	os.WriteFile(filepath.Join(cfg.StagingDir, "RESTORE.txt"), []byte(restoreContent), 0644)

	// 5. Write to target path
	nextStep(StatusWriting, "write-target", "Writing to target...", 80)
	finalEncName := strings.Replace(archiveName, ".tar", ".tar.enc", 1)
	finalEncPath := filepath.Join(cfg.TargetPath, finalEncName)
	finalRestorePath := filepath.Join(cfg.TargetPath, "RESTORE.txt")

	if err := moveOrCopy(encPath, finalEncPath); err != nil {
		Fail(backupID, fmt.Sprintf("Failed to write archive to target: %v", err))
		return
	}
	moveOrCopy(filepath.Join(cfg.StagingDir, "RESTORE.txt"), finalRestorePath)

	var archiveSize int64
	if info, err := os.Stat(finalEncPath); err == nil {
		archiveSize = info.Size()
	}

	// Update backup index
	if cfg.BackupType != "" {
		entry := BackupEntry{
			Timestamp:   timestamp,
			ArchivePath: finalEncPath,
			ArchiveSize: archiveSize,
			Version:     "", // populated by CP if needed
		}
		// Use the base target path (strip structured subdirectory) for the index
		baseTarget := cfg.TargetPath
		if cfg.BackupType == "app" && cfg.AppID != "" {
			baseTarget = filepath.Dir(filepath.Dir(filepath.Dir(cfg.TargetPath)))
		} else if cfg.BackupType == "core" || cfg.BackupType == "full" {
			baseTarget = filepath.Dir(filepath.Dir(cfg.TargetPath))
		}
		AddEntry(baseTarget, cfg.BackupType, cfg.AppID, entry)
	}

	Complete(backupID, finalEncPath, archiveSize)
}

// DetectStorageDriver checks the Incus default storage pool driver.
// Returns "zfs" or "dir" (fallback).
func DetectStorageDriver() string {
	out, err := exec.Command("incus", "storage", "show", "default").CombinedOutput()
	if err != nil {
		return "dir"
	}
	output := string(out)
	if strings.Contains(output, "driver: zfs") {
		return "zfs"
	}
	return "dir"
}

// freezeContainer freezes an Incus container (pauses without stopping).
func freezeContainer(name string) error {
	cmd := exec.Command("incus", "pause", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "already frozen") {
			return nil
		}
		return fmt.Errorf("freeze %s: %s: %s", name, err, string(out))
	}
	return nil
}

// unfreezeContainer unfreezes a frozen Incus container.
func unfreezeContainer(name string) error {
	// Incus uses "start" on a frozen container to unfreeze, but the correct
	// approach is the state API with action=unfreeze. Since we're using CLI,
	// we can use "incus start" which will unfreeze a frozen container.
	out, err := exec.Command("incus", "list", name, "--format", "csv", "-c", "s").Output()
	if err != nil {
		return fmt.Errorf("check state %s: %v", name, err)
	}
	status := strings.ToLower(strings.TrimSpace(string(out)))
	if status == "frozen" {
		cmd := exec.Command("incus", "start", name)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("unfreeze %s: %s: %s", name, err, string(out))
		}
	}
	return nil
}

// createSnapshot creates an Incus snapshot for a container.
func createSnapshot(name, snapshotName string) error {
	cmd := exec.Command("incus", "snapshot", "create", name, snapshotName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("snapshot %s/%s: %s: %s", name, snapshotName, err, string(out))
	}
	return nil
}

// deleteSnapshot removes an Incus snapshot from a container.
func deleteSnapshot(name, snapshotName string) error {
	cmd := exec.Command("incus", "snapshot", "delete", name, snapshotName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Not an error if snapshot doesn't exist
		if strings.Contains(string(out), "not found") {
			return nil
		}
		return fmt.Errorf("delete snapshot %s/%s: %s: %s", name, snapshotName, err, string(out))
	}
	return nil
}

// stopContainer stops an Incus container.
func stopContainer(name string) error {
	cmd := exec.Command("incus", "stop", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Already stopped is not an error
		if strings.Contains(string(out), "already stopped") ||
			strings.Contains(string(out), "The instance is already stopped") {
			return nil
		}
		return fmt.Errorf("%s: %s", err, string(out))
	}
	return nil
}

// restartContainer starts an Incus container.
func restartContainer(name string) {
	exec.Command("incus", "start", name).Run()
}

// waitContainerStopped polls until the container reports STOPPED status.
func waitContainerStopped(name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := exec.Command("incus", "list", name, "--format", "csv", "-c", "s").Output()
		if err != nil {
			return err
		}
		status := strings.ToLower(strings.TrimSpace(string(out)))
		if status == "stopped" {
			return nil
		}
		time.Sleep(1 * time.Second)
	}
	// Force stop as last resort
	exec.Command("incus", "stop", name, "--force").Run()
	return nil
}

// moveOrCopy moves a file, falling back to streaming copy if cross-device.
func moveOrCopy(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// Cross-device: stream copy then remove
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}

	os.Remove(src)
	return nil
}
