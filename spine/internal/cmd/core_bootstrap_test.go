package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreBootstrapRuntimeOverrideLifecycle(t *testing.T) {
	if !strings.HasPrefix(coreBootstrapDropIn, "/run/systemd/system/") {
		t.Fatal("bootstrap must not write the immutable host")
	}
	root := t.TempDir()
	path := filepath.Join(root, coreBootstrapDropIn)
	binary := "/var/lib/youeye-state/core-update/bootstrap/" + strings.Repeat("a", 64) + "/youeye"
	if err := writeCoreBootstrapOverrideFile(path, binary); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreBootstrapOverrideFile(path, binary); err != nil {
		t.Fatalf("same request replay: %v", err)
	}
	if err := writeCoreBootstrapOverrideFile(path, binary+"-other"); err == nil {
		t.Fatal("replaced another coordinator")
	}
	if err := removeCoreBootstrapOverrideFile(path, binary+"-other"); err == nil {
		t.Fatal("removed another coordinator")
	}
	if err := removeCoreBootstrapOverrideFile(path, binary); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
	if err := removeCoreBootstrapOverrideFile(path, binary); err != nil {
		t.Fatalf("completion after reboot lost /run: %v", err)
	}
	if err := writeCoreBootstrapOverrideFile(path, binary); err != nil {
		t.Fatalf("explicit old-host re-entry: %v", err)
	}
}

func TestCoreBootstrapOverrideRejectsUnsafeDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "unsafe")
	if err := os.Mkdir(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreBootstrapOverrideFile(filepath.Join(dir, "override.conf"), "/signed/youeye"); err == nil {
		t.Fatal("accepted writable directory")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreBootstrapOverrideFile(filepath.Join(link, "override.conf"), "/signed/youeye"); err == nil {
		t.Fatal("accepted symlink directory")
	}
}
