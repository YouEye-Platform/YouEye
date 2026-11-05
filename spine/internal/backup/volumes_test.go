package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVolumeMappingRejectsBackupRecursionAndPathEscape(t *testing.T) {
	for _, candidate := range []VolumeMapping{
		{Source: "/var/lib/youeye/backups", ArchivePath: "volumes/backups"},
		{Source: "/etc/shadow", ArchivePath: "volumes/shadow"},
		{Source: "/var/lib/youeye/config", ArchivePath: "../config"},
		{Source: "/var/lib/youeye/config", ArchivePath: "/volumes/config"},
	} {
		if _, err := validateVolumeMapping(candidate); err == nil {
			t.Fatalf("accepted unsafe volume mapping: %+v", candidate)
		}
	}
}

func TestVolumeMappingAcceptsPersistentData(t *testing.T) {
	got, err := validateVolumeMapping(VolumeMapping{
		Source:      "/var/lib/youeye/apps/notes",
		ArchivePath: "volumes/apps-notes",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != "/var/lib/youeye/apps/notes" || got.ArchivePath != "volumes/apps-notes" {
		t.Fatalf("unexpected normalized mapping: %+v", got)
	}
}

func TestApplyVolumesRejectsUnprotectedStaging(t *testing.T) {
	if _, err := ApplyVolumes(t.TempDir()); err == nil {
		t.Fatal("accepted staging outside the protected YE-DATA backup workspace")
	}
}

func TestValidateVolumeTreeAllowsContainedRelativeSymlink(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "snapshots", "current"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "blobs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../blobs/model", filepath.Join(root, "snapshots", "current", "model")); err != nil {
		t.Fatal(err)
	}
	if err := validateVolumeTree(root); err != nil {
		t.Fatal(err)
	}
}

func TestValidateVolumeTreeRejectsEscapingAndAbsoluteSymlinks(t *testing.T) {
	for _, target := range []string{"../../outside", "/etc/shadow"} {
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "nested"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(root, "nested", "link")); err != nil {
			t.Fatal(err)
		}
		if err := validateVolumeTree(root); err == nil {
			t.Fatalf("accepted unsafe symlink target %q", target)
		}
	}
}
