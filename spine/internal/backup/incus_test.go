package backup

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestIncusInstanceImportArgsOverridesSourceNetwork(t *testing.T) {
	request := IncusInstanceImportRequest{
		ArchivePath: "/var/lib/youeye/backups/.staging/restore/app-search.tar.gz",
		Name:        "app-search",
		Pool:        "default",
		Network:     "yeapp1",
	}
	got, err := incusInstanceImportArgs(request)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"import", request.ArchivePath, request.Name,
		"--storage", request.Pool,
		"--device", "eth0,network=yeapp1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("import args = %#v, want %#v", got, want)
	}
}

func TestIncusInstanceImportArgsRejectsUnsafeNetwork(t *testing.T) {
	_, err := incusInstanceImportArgs(IncusInstanceImportRequest{
		ArchivePath: "/var/lib/youeye/backups/.staging/restore/app-search.tar.gz",
		Name:        "app-search",
		Pool:        "default",
		Network:     "../source-network",
	})
	if err == nil {
		t.Fatal("unsafe target network accepted")
	}
}

func TestValidateIncusPlan(t *testing.T) {
	valid := []IncusRuntimeRef{{Name: "app-immich-server", Type: "oci"}, {Name: "app-notes", Type: "lxd"}}
	volumes := []IncusVolumeRef{{Pool: "default", Name: "ye-immich-server-upload"}, {Pool: "media", Name: "ye-shared-media"}}
	if err := validateIncusPlan(valid, volumes); err != nil {
		t.Fatalf("valid plan rejected: %v", err)
	}

	badRuntimes := [][]IncusRuntimeRef{
		{{Name: "../escape", Type: "oci"}},
		{{Name: "app-ok", Type: "vm"}},
		{{Name: "app-ok", Type: "oci"}, {Name: "app-ok", Type: "oci"}},
	}
	for _, candidate := range badRuntimes {
		if err := validateIncusPlan(candidate, nil); err == nil {
			t.Fatalf("unsafe runtime plan accepted: %+v", candidate)
		}
	}

	badVolumes := [][]IncusVolumeRef{
		{{Pool: "../default", Name: "safe"}},
		{{Pool: "default", Name: "bad/name"}},
		{{Pool: "default", Name: "same"}, {Pool: "default", Name: "same"}},
	}
	for _, candidate := range badVolumes {
		if err := validateIncusPlan(nil, candidate); err == nil {
			t.Fatalf("unsafe volume plan accepted: %+v", candidate)
		}
	}
}

func TestRemoveStaleCustomVolumeMountpoint(t *testing.T) {
	root := t.TempDir()
	empty := filepath.Join(root, "media", "custom", "default_ye-app-data")
	if err := os.MkdirAll(empty, 0700); err != nil {
		t.Fatal(err)
	}
	if err := removeStaleCustomVolumeMountpoint(root, "media", "ye-app-data"); err != nil {
		t.Fatalf("empty mountpoint rejected: %v", err)
	}
	if _, err := os.Lstat(empty); !os.IsNotExist(err) {
		t.Fatalf("empty mountpoint remains: %v", err)
	}

	nonEmpty := filepath.Join(root, "media", "custom", "default_ye-app-data")
	if err := os.MkdirAll(nonEmpty, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nonEmpty, "data"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeStaleCustomVolumeMountpoint(root, "media", "ye-app-data"); err == nil {
		t.Fatal("non-empty mountpoint was removed")
	}
	if _, err := os.Stat(filepath.Join(nonEmpty, "data")); err != nil {
		t.Fatalf("non-empty mountpoint content changed: %v", err)
	}

	symlink := filepath.Join(root, "media", "custom", "default_ye-link")
	if err := os.Symlink(t.TempDir(), symlink); err != nil {
		t.Fatal(err)
	}
	if err := removeStaleCustomVolumeMountpoint(root, "media", "ye-link"); err == nil {
		t.Fatal("symlink mountpoint was accepted")
	}
	if err := removeStaleCustomVolumeMountpoint(root, "../media", "ye-app-data"); err == nil {
		t.Fatal("unsafe pool identity was accepted")
	}
}

func TestTemporaryIncusVolumeName(t *testing.T) {
	first, err := temporaryIncusVolumeName()
	if err != nil {
		t.Fatal(err)
	}
	second, err := temporaryIncusVolumeName()
	if err != nil {
		t.Fatal(err)
	}
	if !incusNamePattern.MatchString(first) {
		t.Fatalf("temporary name is not a safe Incus name: %q", first)
	}
	if first == second {
		t.Fatalf("temporary names unexpectedly collided: %q", first)
	}
}

func TestExportedIncusImageFingerprintUsesImportOrder(t *testing.T) {
	root := t.TempDir()
	metadata := filepath.Join(root, "image")
	rootfs := filepath.Join(root, "image.root")
	if err := os.WriteFile(metadata, []byte("metadata"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rootfs, []byte("rootfs"), 0600); err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256([]byte("metadatarootfs"))
	actual, err := exportedIncusImageFingerprint([]string{metadata, rootfs})
	if err != nil {
		t.Fatal(err)
	}
	if actual != fmt.Sprintf("%x", expected) {
		t.Fatalf("unexpected exported image fingerprint: %s", actual)
	}
}
