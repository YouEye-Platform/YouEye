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
	TargetPath          string            `json:"target_path"`
	Passphrase          string            `json:"passphrase"`
	UseStoredPassphrase bool              `json:"use_stored_passphrase"`
	Containers          []string          `json:"containers"`      // containers to quiesce/snapshot (from CP)
	VolumeMapping       []VolumeMapping   `json:"volume_mappings"` // exact source/archive mappings
	IncusRuntimes       []IncusRuntimeRef `json:"incus_runtimes"`
	IncusVolumes        []IncusVolumeRef  `json:"incus_volumes"`
	StagingDir          string            `json:"staging_dir"` // shared YE-DATA staging directory
	Hostname            string            `json:"hostname"`
	BackupType          string            `json:"backup_type"` // "app" or "core"
	AppID               string            `json:"app_id"`      // for per-app backups
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
	if err := validateIncusPlan(cfg.IncusRuntimes, cfg.IncusVolumes); err != nil {
		return "", err
	}
	backupID := generateBackupID()

	// Resolve structured output directory based on backup type
	targetPath := resolveTargetPath(cfg.TargetPath, cfg.BackupType, cfg.AppID)
	cfg.TargetPath = targetPath

	// Ensure target path exists
	if err := os.MkdirAll(cfg.TargetPath, 0755); err != nil {
		return "", fmt.Errorf("target path not writable: %w", err)
	}

	// Build stages for the live, point-in-time backup pipeline.
	stages := []string{}
	if len(cfg.Containers) > 0 || len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		stages = append(stages, "snapshot-containers")
	}
	if len(cfg.VolumeMapping) > 0 {
		stages = append(stages, "export-volumes")
	}
	if len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		stages = append(stages, "export-incus")
	}
	stages = append(stages, "archive", "encrypt", "write-target")
	if len(cfg.Containers) > 0 || len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		stages = append(stages, "cleanup-snapshots")
	}

	Start(backupID, stages)

	go runPipeline(backupID, cfg, stages)

	return backupID, nil
}

// resolveTargetPath returns the structured output directory for backups.
// Per-app: {target}/youeye/apps/{appId}/
// Core:    {target}/youeye/core/
func resolveTargetPath(basePath, backupType, appID string) string {
	switch backupType {
	case "app":
		if appID != "" {
			return filepath.Join(basePath, "youeye", "apps", appID)
		}
		return filepath.Join(basePath, "youeye", "apps")
	case "core":
		return filepath.Join(basePath, "youeye", "core")
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
	default:
		return fmt.Sprintf("youeye-backup-%s.tar", timestamp)
	}
}

func runPipeline(backupID string, cfg BackupConfig, stages []string) {
	stepIndex := 0
	mappings, err := prepareVolumeMappings(cfg.StagingDir, cfg.VolumeMapping)
	if err != nil {
		Fail(backupID, fmt.Sprintf("Invalid volume plan: %v", err))
		return
	}

	// Helper to advance the step counter
	nextStep := func(status, stage, message string, progress int) {
		stepIndex++
		Emit(backupID, status, stage, message, progress, stepIndex, len(stages))
	}

	// Track native-instance, custom-volume, and protected host-data snapshots
	// independently so every success/failure path releases exact ownership.
	var snapshotNames []string
	var incusVolumeSnapshots []IncusVolumeRef
	var dataSnapshots []zfsDataSnapshot
	containersFrozen := false
	snapshotName := "backup-temp-" + backupID

	// Cleanup and unfreeze even when a later stage fails.
	defer func() {
		for _, volume := range incusVolumeSnapshots {
			deleteIncusVolumeSnapshot(volume, snapshotName)
		}
		for _, snapshot := range dataSnapshots {
			deleteDataSnapshot(snapshot)
		}
		for _, c := range snapshotNames {
			deleteSnapshot(c, snapshotName)
		}
		if containersFrozen {
			for _, c := range cfg.Containers {
				_ = unfreezeContainer(c)
			}
		}
	}()

	// 1. Freeze every running app instance while taking the point-in-time native
	// root, custom-volume, and protected host-metadata boundaries.
	if len(cfg.Containers) > 0 || len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		nextStep(StatusExporting, "snapshot-containers", "Quiescing services for a consistent snapshot...", 5)
		for _, c := range cfg.Containers {
			if err := freezeContainer(c); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to quiesce container %s: %v", c, err))
				return
			}
		}
		containersFrozen = true

		driver := DetectStorageDriver()
		snapshotTargets := []string{}
		for _, runtime := range cfg.IncusRuntimes {
			if runtime.Type == "lxd" {
				snapshotTargets = append(snapshotTargets, runtime.Name)
			}
		}
		if len(cfg.IncusRuntimes) == 0 && driver == "zfs" {
			snapshotTargets = append(snapshotTargets, cfg.Containers...)
		}
		for _, c := range snapshotTargets {
			Emit(backupID, StatusExporting, "snapshot-containers",
				fmt.Sprintf("Snapshotting %s...", c), 5, stepIndex, len(stages))
			if err := createSnapshot(c, snapshotName); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to snapshot container %s: %v", c, err))
				return
			}
			snapshotNames = append(snapshotNames, c)
		}
		if len(cfg.IncusVolumes) > 0 {
			incusVolumeSnapshots, err = createIncusVolumeSnapshots(cfg.IncusVolumes, snapshotName)
			if err != nil {
				Fail(backupID, fmt.Sprintf("Failed to snapshot custom app storage: %v", err))
				return
			}
		}
		if driver == "zfs" {
			var snapshotErr error
			dataSnapshots, snapshotErr = createDataSnapshots(mappings, snapshotName)
			if snapshotErr != nil {
				Fail(backupID, fmt.Sprintf("Failed to snapshot persistent YouEye data: %v", snapshotErr))
				return
			}
		}
		for _, c := range cfg.Containers {
			if err := unfreezeContainer(c); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to resume container %s after snapshot: %v", c, err))
				return
			}
		}
		containersFrozen = false
	}

	// 2. Export volumes (filesystem copy)
	if len(cfg.VolumeMapping) > 0 {
		nextStep(StatusExporting, "export-volumes", "Exporting volumes...", 20)
		for _, mapping := range mappings {
			snapshotSource := dataSnapshotSource(mapping.Source, dataSnapshots)
			if _, err := os.Stat(snapshotSource); os.IsNotExist(err) {
				continue
			}
			if err := validateVolumeTree(snapshotSource); err != nil {
				Fail(backupID, fmt.Sprintf("Volume validation failed: %v", err))
				return
			}
			destination := filepath.Join(cfg.StagingDir, filepath.FromSlash(mapping.ArchivePath))
			if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
				Fail(backupID, fmt.Sprintf("Failed to create volume destination: %v", err))
				return
			}
			Emit(backupID, StatusExporting, "export-volumes",
				fmt.Sprintf("Copying %s...", mapping.Source), 25, stepIndex, len(stages))
			cmd := exec.Command("cp", "-a", "--", snapshotSource, destination)
			if out, err := cmd.CombinedOutput(); err != nil {
				Fail(backupID, fmt.Sprintf("Volume copy failed for %s: %v\n%s", mapping.Source, err, string(out)))
				return
			}
		}
	}

	if len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		nextStep(StatusExporting, "export-incus", "Exporting exact app runtime and storage...", 35)
		if err := exportIncusAssets(cfg.StagingDir, backupID, snapshotName, cfg.IncusRuntimes, cfg.IncusVolumes); err != nil {
			Fail(backupID, fmt.Sprintf("Incus recovery export failed: %v", err))
			return
		}
	}

	// Release temporary immutable snapshots after all exports complete.
	if len(cfg.Containers) > 0 || len(cfg.IncusRuntimes) > 0 || len(cfg.IncusVolumes) > 0 {
		if containersFrozen {
			nextStep(StatusExporting, "cleanup-snapshots", "Unfreezing containers...", 35)
			for _, c := range cfg.Containers {
				if err := unfreezeContainer(c); err != nil {
					Fail(backupID, fmt.Sprintf("Failed to unfreeze container %s: %v", c, err))
					return
				}
			}
			containersFrozen = false
		} else {
			nextStep(StatusExporting, "cleanup-snapshots", "Releasing temporary snapshots...", 35)
		}
		for _, snapshot := range dataSnapshots {
			deleteDataSnapshot(snapshot)
		}
		dataSnapshots = nil
		for _, c := range snapshotNames {
			deleteSnapshot(c, snapshotName)
		}
		snapshotNames = nil
		for _, volume := range incusVolumeSnapshots {
			deleteIncusVolumeSnapshot(volume, snapshotName)
		}
		incusVolumeSnapshots = nil
	}

	// 3. Archive staging dir as tar
	nextStep(StatusArchiving, "archive", "Creating archive...", 50)
	timestamp := time.Now().Format("20060102-150405")
	hostname := cfg.Hostname
	if hostname == "" {
		hostname = "youeye"
	}

	archiveName := resolveArchiveName(cfg.BackupType, cfg.AppID, timestamp)
	tarFile, err := os.CreateTemp(filepath.Dir(cfg.StagingDir), ".youeye-backup-*.tar")
	if err != nil {
		Fail(backupID, fmt.Sprintf("Create archive staging file: %v", err))
		return
	}
	tarPath := tarFile.Name()
	tarFile.Close()
	defer os.Remove(tarPath)

	tarCmd := exec.Command("tar", "--numeric-owner", "-cf", tarPath, "-C", cfg.StagingDir, ".")
	if out, err := tarCmd.CombinedOutput(); err != nil {
		Fail(backupID, fmt.Sprintf("Archive creation failed: %v\n%s", err, string(out)))
		return
	}

	// 4. Encrypt with AES-256-CBC
	nextStep(StatusEncrypting, "encrypt", "Encrypting archive...", 65)
	encPath := tarPath + ".enc"
	defer os.Remove(encPath)
	encCmd := opensslWithPassphrase(cfg.Passphrase, "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
		"-in", tarPath, "-out", encPath)
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
			"Keep every .tar.enc file beside its .hmac file. Restore through YouEye "+
			"Settings, the youeye CLI, or first-browser Recovery so ciphertext "+
			"authentication, path validation, service quiescing, and health checks run.\n",
		timestamp, hostname,
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
	if err := writeArchiveMAC(finalEncPath, cfg.Passphrase); err != nil {
		os.Remove(finalEncPath)
		Fail(backupID, fmt.Sprintf("Failed to authenticate archive: %v", err))
		return
	}
	moveOrCopy(filepath.Join(cfg.StagingDir, "RESTORE.txt"), finalRestorePath)

	var archiveSize int64
	if info, err := os.Stat(finalEncPath); err == nil {
		archiveSize = info.Size()
	}

	Complete(backupID, finalEncPath, archiveSize)
}

type zfsDataSnapshot struct {
	Dataset    string
	Mountpoint string
	Name       string
}

func zfsDatasets() ([]zfsDataSnapshot, error) {
	output, err := exec.Command("zfs", "list", "-H", "-o", "name,mountpoint", "-t", "filesystem").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("list ZFS datasets: %w: %s", err, strings.TrimSpace(string(output)))
	}
	var datasets []zfsDataSnapshot
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.SplitN(line, "\t", 2)
		if len(fields) != 2 || fields[1] == "none" || fields[1] == "legacy" || !filepath.IsAbs(fields[1]) {
			continue
		}
		datasets = append(datasets, zfsDataSnapshot{Dataset: fields[0], Mountpoint: filepath.Clean(fields[1])})
	}
	return datasets, nil
}

func createDataSnapshots(mappings []VolumeMapping, snapshotName string) ([]zfsDataSnapshot, error) {
	datasets, err := zfsDatasets()
	if err != nil {
		return nil, err
	}
	selected := make(map[string]zfsDataSnapshot)
	for _, mapping := range mappings {
		var best zfsDataSnapshot
		for _, dataset := range datasets {
			if pathWithin(dataset.Mountpoint, mapping.Source) && len(dataset.Mountpoint) > len(best.Mountpoint) {
				best = dataset
			}
		}
		if best.Dataset == "" {
			return nil, fmt.Errorf("persistent path %s is not covered by a ZFS dataset", mapping.Source)
		}
		best.Name = snapshotName
		selected[best.Dataset] = best
	}
	created := make([]zfsDataSnapshot, 0, len(selected))
	for _, snapshot := range selected {
		output, snapshotErr := exec.Command("zfs", "snapshot", snapshot.Dataset+"@"+snapshot.Name).CombinedOutput()
		if snapshotErr != nil {
			for _, existing := range created {
				deleteDataSnapshot(existing)
			}
			return nil, fmt.Errorf("snapshot %s: %w: %s", snapshot.Dataset, snapshotErr, strings.TrimSpace(string(output)))
		}
		created = append(created, snapshot)
	}
	return created, nil
}

func dataSnapshotSource(source string, snapshots []zfsDataSnapshot) string {
	for _, snapshot := range snapshots {
		if pathWithin(snapshot.Mountpoint, source) {
			relative, err := filepath.Rel(snapshot.Mountpoint, source)
			if err == nil {
				return filepath.Join(snapshot.Mountpoint, ".zfs", "snapshot", snapshot.Name, relative)
			}
		}
	}
	return source
}

func deleteDataSnapshot(snapshot zfsDataSnapshot) {
	_ = exec.Command("zfs", "destroy", snapshot.Dataset+"@"+snapshot.Name).Run()
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
