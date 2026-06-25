package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Backup status constants
const (
	StatusIdle       = "idle"
	StatusStarting   = "starting"
	StatusStopping   = "stopping"
	StatusDumping    = "dumping"
	StatusExporting  = "exporting"
	StatusArchiving  = "archiving"
	StatusEncrypting = "encrypting"
	StatusWriting    = "writing"
	StatusRestarting = "restarting"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
)

// StatusFile represents the persistent backup status written to disk.
type StatusFile struct {
	BackupID    string   `json:"backup_id"`
	Status      string   `json:"status"`
	Progress    int      `json:"progress"`
	Message     string   `json:"message"`
	Stage       string   `json:"stage,omitempty"`
	Stages      []string `json:"stages,omitempty"`
	CurrentStep int      `json:"current_step"`
	TotalSteps  int      `json:"total_steps"`
	ArchivePath string   `json:"archive_path,omitempty"`
	ArchiveSize int64    `json:"archive_size,omitempty"`
	Error       string   `json:"error,omitempty"`
	StartedAt   string   `json:"started_at,omitempty"`
	UpdatedAt   string   `json:"updated_at"`
}

var (
	statusDir  = "/var/lib/youeye"
	statusFile = "backup-status.json"
	mu         sync.Mutex
)

func statusPath() string {
	return filepath.Join(statusDir, statusFile)
}

// WriteStatus atomically writes the backup status to disk.
func WriteStatus(s StatusFile) error {
	mu.Lock()
	defer mu.Unlock()

	s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	// Atomic write: write to temp file, then rename
	tmpPath := statusPath() + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, statusPath())
}

// ReadStatus reads the current backup status from disk.
// Returns an idle status if no file exists.
func ReadStatus() StatusFile {
	mu.Lock()
	defer mu.Unlock()

	data, err := os.ReadFile(statusPath())
	if err != nil {
		return StatusFile{Status: StatusIdle}
	}

	var s StatusFile
	if err := json.Unmarshal(data, &s); err != nil {
		return StatusFile{Status: StatusIdle}
	}
	return s
}

// ClearStatus removes the status file (sets back to idle).
func ClearStatus() {
	mu.Lock()
	defer mu.Unlock()
	os.Remove(statusPath())
}

// Emit writes a progress update for the backup operation.
func Emit(backupID, status, stage, message string, progress, currentStep, totalSteps int) {
	existing := ReadStatus()
	sf := StatusFile{
		BackupID:    backupID,
		Status:      status,
		Progress:    progress,
		Message:     message,
		Stage:       stage,
		Stages:      existing.Stages,
		CurrentStep: currentStep,
		TotalSteps:  totalSteps,
		ArchivePath: existing.ArchivePath,
		ArchiveSize: existing.ArchiveSize,
		StartedAt:   existing.StartedAt,
	}
	WriteStatus(sf)
}

// Start initializes a new backup session.
func Start(backupID string, stages []string) {
	WriteStatus(StatusFile{
		BackupID:    backupID,
		Status:      StatusStarting,
		Progress:    0,
		Message:     "Starting backup...",
		Stages:      stages,
		CurrentStep: 0,
		TotalSteps:  len(stages),
		StartedAt:   time.Now().UTC().Format(time.RFC3339),
	})
}

// Complete marks the backup as completed.
func Complete(backupID, archivePath string, archiveSize int64) {
	existing := ReadStatus()
	WriteStatus(StatusFile{
		BackupID:    backupID,
		Status:      StatusCompleted,
		Progress:    100,
		Message:     "Backup completed successfully",
		Stages:      existing.Stages,
		CurrentStep: existing.TotalSteps,
		TotalSteps:  existing.TotalSteps,
		ArchivePath: archivePath,
		ArchiveSize: archiveSize,
		StartedAt:   existing.StartedAt,
	})
}

// Fail marks the backup as failed.
func Fail(backupID, errMsg string) {
	existing := ReadStatus()
	WriteStatus(StatusFile{
		BackupID:    backupID,
		Status:      StatusFailed,
		Progress:    existing.Progress,
		Message:     "Backup failed",
		Stages:      existing.Stages,
		CurrentStep: existing.CurrentStep,
		TotalSteps:  existing.TotalSteps,
		Error:       errMsg,
		StartedAt:   existing.StartedAt,
	})
}
