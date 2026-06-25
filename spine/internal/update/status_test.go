package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func setupTestDir(t *testing.T) func() {
	t.Helper()
	origDir := statusDir
	tmpDir := t.TempDir()
	statusDir = tmpDir
	return func() {
		statusDir = origDir
	}
}

func TestWriteAndReadStatus(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	input := StatusFile{
		Component:     "spine",
		Status:        StatusDownloading,
		Progress:      50,
		Message:       "Downloading update...",
		VersionBefore: "0.2.5",
	}

	if err := WriteStatus(input); err != nil {
		t.Fatalf("WriteStatus() error: %v", err)
	}

	got := ReadStatus()
	if got.Component != "spine" {
		t.Errorf("Component = %q, want %q", got.Component, "spine")
	}
	if got.Status != StatusDownloading {
		t.Errorf("Status = %q, want %q", got.Status, StatusDownloading)
	}
	if got.Progress != 50 {
		t.Errorf("Progress = %d, want 50", got.Progress)
	}
	if got.Message != "Downloading update..." {
		t.Errorf("Message = %q", got.Message)
	}
	if got.UpdatedAt == "" {
		t.Error("UpdatedAt should be set")
	}
}

func TestReadStatusNoFile(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	got := ReadStatus()
	if got.Status != StatusIdle {
		t.Errorf("ReadStatus() with no file = %q, want %q", got.Status, StatusIdle)
	}
}

func TestClearStatus(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	WriteStatus(StatusFile{
		Component: "spine",
		Status:    StatusCompleted,
		Progress:  100,
	})

	ClearStatus()

	got := ReadStatus()
	if got.Status != StatusIdle {
		t.Errorf("after ClearStatus(), Status = %q, want %q", got.Status, StatusIdle)
	}
}

func TestStart(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	Start("spine", "0.2.5")

	got := ReadStatus()
	if got.Component != "spine" {
		t.Errorf("Component = %q, want %q", got.Component, "spine")
	}
	if got.Status != StatusChecking {
		t.Errorf("Status = %q, want %q", got.Status, StatusChecking)
	}
	if got.VersionBefore != "0.2.5" {
		t.Errorf("VersionBefore = %q, want %q", got.VersionBefore, "0.2.5")
	}
	if got.StartedAt == "" {
		t.Error("StartedAt should be set")
	}
}

func TestComplete(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	Start("spine", "0.2.5")
	Complete("spine", "0.2.5", "0.2.6")

	got := ReadStatus()
	if got.Status != StatusCompleted {
		t.Errorf("Status = %q, want %q", got.Status, StatusCompleted)
	}
	if got.Progress != 100 {
		t.Errorf("Progress = %d, want 100", got.Progress)
	}
	if got.VersionAfter != "0.2.6" {
		t.Errorf("VersionAfter = %q, want %q", got.VersionAfter, "0.2.6")
	}
}

func TestFail(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	Start("spine", "0.2.5")
	Fail("spine", "0.2.5", "download failed")

	got := ReadStatus()
	if got.Status != StatusFailed {
		t.Errorf("Status = %q, want %q", got.Status, StatusFailed)
	}
	if got.Error != "download failed" {
		t.Errorf("Error = %q, want %q", got.Error, "download failed")
	}
	if got.Progress != 0 {
		t.Errorf("Progress = %d, want 0", got.Progress)
	}
}

func TestEmit(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	Start("spine", "0.2.5")
	Emit("spine", StatusInstalling, 75, "Installing files...")

	got := ReadStatus()
	if got.Status != StatusInstalling {
		t.Errorf("Status = %q, want %q", got.Status, StatusInstalling)
	}
	if got.Progress != 75 {
		t.Errorf("Progress = %d, want 75", got.Progress)
	}
	if got.VersionBefore != "0.2.5" {
		t.Errorf("VersionBefore = %q, want %q (should be preserved from Start)", got.VersionBefore, "0.2.5")
	}
}

func TestAtomicWrite(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	WriteStatus(StatusFile{
		Component: "spine",
		Status:    StatusCompleted,
		Progress:  100,
	})

	// Verify the file is valid JSON
	data, err := os.ReadFile(filepath.Join(statusDir, statusFile))
	if err != nil {
		t.Fatalf("ReadFile error: %v", err)
	}

	var s StatusFile
	if err := json.Unmarshal(data, &s); err != nil {
		t.Errorf("file is not valid JSON: %v", err)
	}

	// Verify no temp file left behind
	tmpPath := filepath.Join(statusDir, statusFile+".tmp")
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Error("temp file should not exist after successful write")
	}
}

func TestConcurrentWrites(t *testing.T) {
	cleanup := setupTestDir(t)
	defer cleanup()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			WriteStatus(StatusFile{
				Component: "spine",
				Status:    StatusDownloading,
				Progress:  n * 5,
				Message:   "concurrent write",
			})
		}(i)
	}
	wg.Wait()

	// Should be able to read valid status after concurrent writes
	got := ReadStatus()
	if got.Component != "spine" {
		t.Errorf("after concurrent writes, Component = %q, want %q", got.Component, "spine")
	}
	if got.Status != StatusDownloading {
		t.Errorf("after concurrent writes, Status = %q, want %q", got.Status, StatusDownloading)
	}
}

func TestStatusConstants(t *testing.T) {
	// Ensure constants are distinct
	statuses := []string{
		StatusIdle, StatusChecking, StatusDownloading, StatusVerifying,
		StatusInstalling, StatusRestarting, StatusCompleted, StatusFailed,
	}

	seen := make(map[string]bool)
	for _, s := range statuses {
		if seen[s] {
			t.Errorf("duplicate status constant: %q", s)
		}
		seen[s] = true
	}

	if len(statuses) != 8 {
		t.Errorf("expected 8 status constants, got %d", len(statuses))
	}
}
