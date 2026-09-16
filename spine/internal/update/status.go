package update

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	StatusIdle        = "idle"
	StatusChecking    = "checking"
	StatusDownloading = "downloading"
	StatusVerifying   = "verifying"
	StatusInstalling  = "installing"
	StatusRestarting  = "restarting"
	StatusCompleted   = "completed"
	StatusFailed      = "failed"
)

// StatusFile represents the persistent update status written to disk.
type StatusFile struct {
	AttemptID     string `json:"attempt_id,omitempty"`
	Authority     string `json:"authority,omitempty"`
	Component     string `json:"component"`
	Status        string `json:"status"`
	Progress      int    `json:"progress"`
	Message       string `json:"message"`
	VersionBefore string `json:"version_before,omitempty"`
	VersionAfter  string `json:"version_after,omitempty"`
	Error         string `json:"error,omitempty"`
	StartedAt     string `json:"started_at,omitempty"`
	UpdatedAt     string `json:"updated_at"`
}

var (
	statusDir  = "/var/lib/youeye"
	statusFile = "update-status.json"
	mu         sync.Mutex
)

func statusPath() string {
	return filepath.Join(statusDir, statusFile)
}

// WriteStatus atomically writes the update status to disk.
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

// ReadStatus reads the current update status from disk.
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

// Emit is a convenience method to write a progress update for a component.
func Emit(component, status string, progress int, message string) {
	existing := ReadStatus()
	sf := StatusFile{
		AttemptID:     existing.AttemptID,
		Authority:     existing.Authority,
		Component:     component,
		Status:        status,
		Progress:      progress,
		Message:       message,
		VersionBefore: existing.VersionBefore,
		VersionAfter:  existing.VersionAfter,
		StartedAt:     existing.StartedAt,
	}
	WriteStatus(sf)
}

func newAttemptID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("update-%d", time.Now().UTC().UnixNano())
	}
	return hex.EncodeToString(raw)
}

// Start initializes a new update session for a component.
func Start(component, versionBefore string) {
	WriteStatus(StatusFile{
		AttemptID:     newAttemptID(),
		Authority:     "spine",
		Component:     component,
		Status:        StatusChecking,
		Progress:      0,
		Message:       "Checking for updates...",
		VersionBefore: versionBefore,
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
	})
}

// Complete marks the update as completed with the new version.
func Complete(component, versionBefore, versionAfter string) {
	existing := ReadStatus()
	WriteStatus(StatusFile{
		AttemptID:     existing.AttemptID,
		Authority:     "spine",
		Component:     component,
		Status:        StatusCompleted,
		Progress:      100,
		Message:       "Update completed successfully",
		VersionBefore: versionBefore,
		VersionAfter:  versionAfter,
		StartedAt:     existing.StartedAt,
	})
}

// NoOp records a legitimate already-current result as a terminal attempt.
func NoOp(component, version string) {
	Start(component, version)
	existing := ReadStatus()
	WriteStatus(StatusFile{
		AttemptID:     existing.AttemptID,
		Authority:     "spine",
		Component:     component,
		Status:        StatusCompleted,
		Progress:      100,
		Message:       "Already up to date",
		VersionBefore: version,
		VersionAfter:  version,
		StartedAt:     existing.StartedAt,
	})
}

// Fail marks the update as failed with an error message.
func Fail(component, versionBefore, errMsg string) {
	existing := ReadStatus()
	WriteStatus(StatusFile{
		AttemptID:     existing.AttemptID,
		Authority:     "spine",
		Component:     component,
		Status:        StatusFailed,
		Progress:      0,
		Message:       "Update failed",
		VersionBefore: versionBefore,
		Error:         errMsg,
		StartedAt:     existing.StartedAt,
	})
}
