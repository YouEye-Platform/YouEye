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
	TargetPath string   `json:"target_path"`
	Passphrase string   `json:"passphrase"`
	Containers []string `json:"containers"` // containers to stop/export (from CP)
	VolumePaths []string `json:"volume_paths"` // host-side volume paths to copy
	StagingDir  string   `json:"staging_dir"`  // where CP placed dumps/configs
	Hostname    string   `json:"hostname"`
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

	// Ensure target path exists
	if err := os.MkdirAll(cfg.TargetPath, 0755); err != nil {
		return "", fmt.Errorf("target path not writable: %w", err)
	}

	// Build stages list
	stages := []string{}
	if len(cfg.Containers) > 0 {
		stages = append(stages, "stop-containers")
	}
	if len(cfg.VolumePaths) > 0 {
		stages = append(stages, "export-volumes")
	}
	stages = append(stages, "archive", "encrypt", "write-target")
	if len(cfg.Containers) > 0 {
		stages = append(stages, "restart-containers")
	}

	Start(backupID, stages)

	go runPipeline(backupID, cfg, stages)

	return backupID, nil
}

func runPipeline(backupID string, cfg BackupConfig, stages []string) {
	stepIndex := 0

	// Helper to advance the step counter
	nextStep := func(status, stage, message string, progress int) {
		stepIndex++
		Emit(backupID, status, stage, message, progress, stepIndex, len(stages))
	}

	// Ensure containers are restarted even on failure
	defer func() {
		if len(cfg.Containers) > 0 {
			nextStep(StatusRestarting, "restart-containers", "Restarting containers...", 85)
			for _, c := range cfg.Containers {
				restartContainer(c)
			}
		}
	}()

	// 1. Stop containers (if any)
	if len(cfg.Containers) > 0 {
		nextStep(StatusStopping, "stop-containers", "Stopping containers...", 5)
		for _, c := range cfg.Containers {
			Emit(backupID, StatusStopping, "stop-containers",
				fmt.Sprintf("Stopping %s...", c), 5, stepIndex, len(stages))
			if err := stopContainer(c); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to stop container %s: %v", c, err))
				return
			}
			// Poll until stopped
			if err := waitContainerStopped(c, 60*time.Second); err != nil {
				Fail(backupID, fmt.Sprintf("Container %s did not stop in time: %v", c, err))
				return
			}
		}
	}

	// 2. Export volumes (filesystem copy)
	if len(cfg.VolumePaths) > 0 {
		nextStep(StatusExporting, "export-volumes", "Exporting volumes...", 20)
		for _, volPath := range cfg.VolumePaths {
			if _, err := os.Stat(volPath); os.IsNotExist(err) {
				// Skip non-existent volume paths (app may not have data yet)
				continue
			}
			destDir := filepath.Join(cfg.StagingDir, "volumes", filepath.Base(volPath))
			if err := os.MkdirAll(filepath.Dir(destDir), 0755); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to create volume dest dir: %v", err))
				return
			}
			Emit(backupID, StatusExporting, "export-volumes",
				fmt.Sprintf("Copying %s...", volPath), 25, stepIndex, len(stages))
			// Use cp -a to preserve permissions and symlinks
			cmd := exec.Command("cp", "-a", volPath, destDir)
			if out, err := cmd.CombinedOutput(); err != nil {
				Fail(backupID, fmt.Sprintf("Volume copy failed for %s: %v\n%s", volPath, err, string(out)))
				return
			}
		}
	}

	// 3. Archive staging dir as tar (NOT tar.gz — encrypt the raw tar per task brief)
	nextStep(StatusArchiving, "archive", "Creating archive...", 50)
	timestamp := time.Now().Format("20060102-150405")
	hostname := cfg.Hostname
	if hostname == "" {
		hostname = "youeye"
	}
	archiveName := fmt.Sprintf("youeye-backup-%s-%s.tar", hostname, timestamp)
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

	// Remove unencrypted tar
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

	// Move encrypted archive to target
	if err := moveOrCopy(encPath, finalEncPath); err != nil {
		Fail(backupID, fmt.Sprintf("Failed to write archive to target: %v", err))
		return
	}
	// Copy RESTORE.txt
	moveOrCopy(filepath.Join(cfg.StagingDir, "RESTORE.txt"), finalRestorePath)

	// Get final archive size
	var archiveSize int64
	if info, err := os.Stat(finalEncPath); err == nil {
		archiveSize = info.Size()
	}

	Complete(backupID, finalEncPath, archiveSize)
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
