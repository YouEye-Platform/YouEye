package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFirstDeployProgressIsAtomicMonotonicAndSafe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.json")
	t.Setenv("YOUEYE_FIRST_DEPLOY_ATTEMPT", "3")
	if err := writeFirstDeployProgress(path, "storage", "Preparing\nstorage", 36); err != nil {
		t.Fatal(err)
	}
	if err := writeFirstDeployProgress(path, "incus", "Starting Incus", 20); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	record, err := decodeFirstDeployProgress(raw)
	if err != nil {
		t.Fatal(err)
	}
	if record.Schema != firstDeployProgressSchema || record.Percent != 36 || record.Attempt != 3 || strings.Contains(record.Detail, "\n") {
		t.Fatalf("unexpected safe progress record: %+v", record)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("progress mode is not protected: info=%v err=%v", info, err)
	}
}

func TestFirstDeployProgressRejectsUnknownStageAndUnsafePath(t *testing.T) {
	if err := writeFirstDeployProgress(filepath.Join(t.TempDir(), "progress.json"), "password", "unsafe", 50); err == nil {
		t.Fatal("unknown progress stage was accepted")
	}
	if err := writeFirstDeployProgress("relative/progress.json", "storage", "safe", 1); err == nil {
		t.Fatal("relative progress path was accepted")
	}
}

func TestResumeReconcilesControlPanelBeforeInfrastructure(t *testing.T) {
	raw, err := os.ReadFile("deploy.go")
	if err != nil {
		t.Fatal(err)
	}
	resume := strings.Index(string(raw), "if resumeDeployment")
	control := strings.Index(string(raw), "if err := installControl(); err != nil")
	infrastructure := strings.Index(string(raw), "return resumeExistingDeployment()")
	if resume < 0 || control < resume || infrastructure < control {
		t.Fatal("resume path does not reconcile Control Panel identity before infrastructure")
	}
}
