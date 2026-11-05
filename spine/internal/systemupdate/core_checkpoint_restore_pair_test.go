package systemupdate

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pairedRestoreFixture(t *testing.T) (NativeCoreCheckpoint, CoreJournal, *int) {
	t.Helper()
	p, j, _, _ := databaseCheckpointFixture(t)
	if _, err := p.CaptureDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	j = activatePairedRecoveryFixture(t, p, j)
	p.RestoreStream = func(context.Context, io.Reader, string, ...string) error { return nil }
	if _, err := p.RestoreDatabases(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(p.DataRoot, ".zfs", "snapshot", coreCheckpointSnapshot(j.RequestID), "ui-data")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	for path, value := range map[string]string{
		filepath.Join(source, "image.png"):                    "original-image",
		filepath.Join(p.DataRoot, "ui-data", "image.png"):     "changed-image",
		filepath.Join(p.DataRoot, "control", ".bridge_token"): "current-authority",
		filepath.Join(p.DataRoot, "config", "config.yaml"):    "current-owner-source",
	} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	native := p.Capture
	roots := 0
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "rsync" {
			return captureCoreNative(ctx, program, args...)
		}
		if program == "incus" && len(args) == 4 && args[0] == "snapshot" && args[1] == "restore" {
			if (args[2] != "youeye-control" && args[2] != "youeye-ui") || args[3] != coreCheckpointSnapshot(j.RequestID) {
				t.Fatal("unowned root restore")
			}
			roots++
			return nil, nil
		}
		return native(ctx, program, args...)
	}
	return p, j, &roots
}

func TestCorePairedRestoreKeepsCurrentAuthorityAndRestoresOnlyCoreRoots(t *testing.T) {
	p, j, roots := pairedRestoreFixture(t)
	record, err := p.RestoreFiles(context.Background(), j)
	if err != nil || record.Phase != "files-restored" {
		t.Fatal(record.Phase, err)
	}
	for path, want := range map[string]string{
		filepath.Join(p.DataRoot, "ui-data", "image.png"):     "original-image",
		filepath.Join(p.DataRoot, "control", ".bridge_token"): "current-authority",
		filepath.Join(p.DataRoot, "config", "config.yaml"):    "current-owner-source",
	} {
		raw, err := os.ReadFile(path)
		if err != nil || string(raw) != want {
			t.Fatal("incorrect paired data/authority", err)
		}
	}
	record, err = p.RestoreRoots(context.Background(), j)
	if err != nil || record.Phase != "paired-restored" || *roots != 2 {
		t.Fatal(record.Phase, *roots, err)
	}
	if _, err := p.RestoreRoots(context.Background(), j); err != nil || *roots != 2 {
		t.Fatal("root restoration repeated", *roots, err)
	}
}

func TestCorePortableCopyReconcilesLostAcknowledgementButRootRestoreDoesNotReplay(t *testing.T) {
	p, j, roots := pairedRestoreFixture(t)
	native := p.Capture
	lost := true
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		raw, err := native(ctx, program, args...)
		if program == "rsync" && lost {
			lost = false
			return nil, fmt.Errorf("copy acknowledgement lost")
		}
		return raw, err
	}
	if _, err := p.RestoreFiles(context.Background(), j); err == nil {
		t.Fatal("lost copy acknowledgement accepted")
	}
	if _, err := p.RestoreFiles(context.Background(), j); err != nil {
		t.Fatal("exact idempotent data copy did not reconcile", err)
	}
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		raw, err := native(ctx, program, args...)
		if program == "incus" && args[0] == "snapshot" && args[1] == "restore" {
			return nil, fmt.Errorf("restore acknowledgement lost")
		}
		return raw, err
	}
	if _, err := p.RestoreRoots(context.Background(), j); err == nil || *roots != 1 {
		t.Fatal("unknown root outcome accepted", err)
	}
	p.Capture = native
	if _, err := p.RestoreRoots(context.Background(), j); err == nil || *roots != 1 {
		t.Fatal("unknown provider restore repeated", err)
	}
}

func TestCorePortableRecoveryRefusesLinksAndChangedRestoredData(t *testing.T) {
	p, j, _ := pairedRestoreFixture(t)
	path := filepath.Join(p.DataRoot, "ui-data", "image.png")
	if _, err := p.RestoreFiles(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("later-owner-data"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.RestoreFiles(context.Background(), j); err == nil {
		t.Fatal("overwrote newer data after verified restore")
	}
	p, j, _ = pairedRestoreFixture(t)
	source := filepath.Join(p.DataRoot, ".zfs", "snapshot", coreCheckpointSnapshot(j.RequestID), "ui-data", "external")
	if err := os.Symlink("/outside-fixture", source); err != nil {
		t.Fatal(err)
	}
	if _, err := p.RestoreFiles(context.Background(), j); err == nil || !strings.Contains(err.Error(), "unsupported core data") {
		t.Fatal("unsafe snapshot tree admitted", err)
	}
}
