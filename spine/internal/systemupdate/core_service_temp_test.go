package systemupdate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// YE-42: a core state write cut short removes its temp, and a temp an earlier attempt left is written again instead of
// refused ("interrupted core state differs; paired recovery required" needed a person before).

func coreStateDir(t *testing.T) (string, *os.File) {
	t.Helper()
	path := t.TempDir()
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dir.Close() })
	return path, dir
}

func cutCoreTempWrites(t *testing.T) {
	t.Helper()
	sync := syncCoreTemp
	syncCoreTemp = func(*os.File) error { return errors.New("input/output error") }
	t.Cleanup(func() { syncCoreTemp = sync })
}

func TestWriteCoreContainerFileRemovesTempOnFailure(t *testing.T) {
	path, dir := coreStateDir(t)
	target := filepath.Join(path, "core-release.json")
	if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	cutCoreTempWrites(t)
	if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err == nil {
		t.Fatal("a failed write reported success")
	}
	if _, err := os.Lstat(filepath.Join(path, ".stage.core-release.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the failed write left its temp", err)
	}
	if raw, _ := os.ReadFile(target); string(raw) != "old" {
		t.Fatal("the target changed", string(raw))
	}
	// The next attempt writes it.
	syncCoreTemp = func(file *os.File) error { return file.Sync() }
	if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(target); string(raw) != "new" {
		t.Fatal("not written", string(raw))
	}
}

func TestWriteCoreContainerFileReplacesStaleTemp(t *testing.T) {
	for _, stale := range []struct {
		name  string
		write func(string) error
	}{
		{"other content", func(p string) error { return os.WriteFile(p, []byte("half of an earlier document"), 0600) }},
		{"empty after a power loss", func(p string) error { return os.WriteFile(p, nil, 0600) }},
		{"wrong mode", func(p string) error { return os.WriteFile(p, []byte("new"), 0644) }},
		{"a symbolic link", func(p string) error { return os.Symlink("/etc/passwd", p) }},
	} {
		t.Run(stale.name, func(t *testing.T) {
			path, dir := coreStateDir(t)
			target := filepath.Join(path, "core-release.json")
			if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
				t.Fatal(err)
			}
			temp := filepath.Join(path, ".stage.core-release.json")
			if err := stale.write(temp); err != nil {
				t.Fatal(err)
			}
			if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err != nil {
				t.Fatal(err)
			}
			if raw, _ := os.ReadFile(target); string(raw) != "new" {
				t.Fatal("not written", string(raw))
			}
			if _, err := os.Lstat(temp); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("temp left after the rename", err)
			}
			if raw, _ := os.ReadFile("/etc/passwd"); len(raw) == 0 {
				t.Fatal("followed the link")
			}
		})
	}
	// A complete temp of the same data (the rename was cut short) is renamed as it is.
	path, dir := coreStateDir(t)
	if err := os.WriteFile(filepath.Join(path, ".stage.core-release.json"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(path, "core-release.json")); string(raw) != "new" {
		t.Fatal("not renamed", string(raw))
	}
	// A directory in the temp's place is never removed: the write refuses.
	path, dir = coreStateDir(t)
	if err := os.Mkdir(filepath.Join(path, ".stage.core-release.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err == nil {
		t.Fatal("replaced a directory")
	}
	// The target already holds the data: nothing is touched, a stray temp included.
	path, dir = coreStateDir(t)
	if err := os.WriteFile(filepath.Join(path, "core-release.json"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, ".stage.core-release.json"), []byte("other"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeCoreContainerFileAt(dir, "core-release.json", ".stage.core-release.json", []byte("new"), 1024); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(path, ".stage.core-release.json")); string(raw) != "other" {
		t.Fatal("touched a temp although the target was already written")
	}
}

func TestCoreComponentMarkerReplacesStaleTempAndCleansUpOnFailure(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "etc", "youeye")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	old := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "cp", RequestID: "install-baseline", ManifestSHA256: checksum([]byte("baseline")), ArtifactSHA256: checksum([]byte("old"))}
	raw, _ := json.Marshal(old)
	if err := os.WriteFile(filepath.Join(dir, "core-component.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	j := CoreJournal{RequestID: "update-1", ManifestSHA256: checksum([]byte("new manifest"))}
	r := CoreServiceStage{Role: "cp", StageName: ".youeye-core-fixture", Phase: "swapped", PreviousSHA256: old.ArtifactSHA256, ArtifactSHA256: checksum([]byte("new"))}
	held, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	save := func(CoreServiceStage) error { return nil }
	temp := filepath.Join(dir, r.StageName+".marker")
	// A cut-short write removes its temp; the marker stays the old one.
	cutCoreTempWrites(t)
	if err = installCoreComponentMarker(held, j, &r, save); err == nil {
		t.Fatal("a failed marker write reported success")
	}
	if _, err = os.Lstat(temp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the failed write left its temp", err)
	}
	syncCoreTemp = func(file *os.File) error { return file.Sync() }
	// A temp of another marker (an earlier attempt) is written again, not refused.
	foreign := old
	foreign.RequestID = "update-0"
	other, _ := json.Marshal(foreign)
	if err = os.WriteFile(temp, other, 0600); err != nil {
		t.Fatal(err)
	}
	if err = installCoreComponentMarker(held, j, &r, save); err != nil || r.MarkerState != "installed" {
		t.Fatal(r.MarkerState, err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "core-component.json"))
	var marker coreComponentMarker
	if json.Unmarshal(after, &marker) != nil || marker.RequestID != j.RequestID || marker.ArtifactSHA256 != r.ArtifactSHA256 {
		t.Fatal("incorrect marker", string(after))
	}
}
