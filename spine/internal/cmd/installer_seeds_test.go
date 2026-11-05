package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSeedFixture(t *testing.T, root, relativePath, contents string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestPreserveInstallerSeedsAcrossDataMount(t *testing.T) {
	root := filepath.Join(t.TempDir(), "var-lib-youeye")
	fixtures := map[string]struct {
		contents string
		mode     os.FileMode
	}{
		filepath.Join("config", "config.yaml"): {"releases:\n  repo_url: https://forge.example/YouEye\n", 0o600},
		filepath.Join("config", "youeye.yaml"): {"release:\n  branch: f-installer-deploy-recovery\n", 0o600},
		"market-source.json":                   {`{"repo":"YE-AppMarket"}`, 0o640},
		"market-sources.json":                  {`[{"repo":"YE-AppMarket"}]`, 0o644},
	}
	for relativePath, fixture := range fixtures {
		writeSeedFixture(t, root, relativePath, fixture.contents, fixture.mode)
	}
	writeSeedFixture(t, root, "unrelated-state", "must not migrate", 0o600)

	hiddenRoot := root + "-before-mount"
	err := preserveInstallerSeedsAcrossDataMount(root, func() error {
		if err := os.Rename(root, hiddenRoot); err != nil {
			return err
		}
		return os.MkdirAll(root, 0o755)
	})
	if err != nil {
		t.Fatalf("preserve seeds: %v", err)
	}

	for relativePath, fixture := range fixtures {
		path := filepath.Join(root, relativePath)
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read restored %s: %v", relativePath, err)
		}
		if string(contents) != fixture.contents {
			t.Errorf("restored %s contents = %q, want %q", relativePath, contents, fixture.contents)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat restored %s: %v", relativePath, err)
		}
		if got := info.Mode().Perm(); got != fixture.mode {
			t.Errorf("restored %s mode = %o, want %o", relativePath, got, fixture.mode)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "unrelated-state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unrelated pre-mount state migrated into new dataset: %v", err)
	}
}

func TestPreserveInstallerSeedsRestoresAfterMountError(t *testing.T) {
	root := filepath.Join(t.TempDir(), "var-lib-youeye")
	writeSeedFixture(t, root, "market-source.json", "source", 0o600)

	mountFailure := errors.New("mount verification failed")
	err := preserveInstallerSeedsAcrossDataMount(root, func() error {
		if err := os.RemoveAll(root); err != nil {
			return err
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			return err
		}
		return mountFailure
	})
	if !errors.Is(err, mountFailure) {
		t.Fatalf("error = %v, want mount failure", err)
	}
	contents, readErr := os.ReadFile(filepath.Join(root, "market-source.json"))
	if readErr != nil || string(contents) != "source" {
		t.Fatalf("seed not restored after mount error: contents=%q err=%v", contents, readErr)
	}
}

func TestPreserveInstallerSeedsNeverOverwritesPersistentOwnerConfiguration(t *testing.T) {
	root := filepath.Join(t.TempDir(), "var-lib-youeye")
	writeSeedFixture(t, root, filepath.Join("config", "youeye.yaml"), "setup_completed: false\n", 0o600)

	hiddenRoot := root + "-sealed-image"
	err := preserveInstallerSeedsAcrossDataMount(root, func() error {
		if err := os.Rename(root, hiddenRoot); err != nil {
			return err
		}
		writeSeedFixture(t, root, filepath.Join("config", "youeye.yaml"),
			"site_name: Owner Server\ndomain: owner.test\nsetup_completed: true\n", 0o640)
		return nil
	})
	if err != nil {
		t.Fatalf("preserve seeds: %v", err)
	}

	path := filepath.Join(root, "config", "youeye.yaml")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "site_name: Owner Server\ndomain: owner.test\nsetup_completed: true\n" {
		t.Fatalf("persistent owner config was replaced: %q", contents)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("persistent owner config mode = %o, want 640", info.Mode().Perm())
	}
}

func TestCaptureInstallerSeedsRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	writeSeedFixture(t, root, "target", "source", 0o600)
	if err := os.Symlink(target, filepath.Join(root, "market-source.json")); err != nil {
		t.Fatal(err)
	}

	_, err := captureInstallerSeeds(root)
	if err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("symlink error = %v", err)
	}
}
