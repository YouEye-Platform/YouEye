package backup

import (
	"archive/tar"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type testTarEntry struct {
	header  *tar.Header
	content []byte
}

func writeTestTarEntries(t *testing.T, entries ...testTarEntry) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "archive.tar")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	for _, entry := range entries {
		if err := writer.WriteHeader(entry.header); err != nil {
			t.Fatal(err)
		}
		if len(entry.content) > 0 {
			if _, err := writer.Write(entry.content); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func writeTestTar(t *testing.T, header *tar.Header, content []byte) string {
	t.Helper()
	return writeTestTarEntries(t, testTarEntry{header: header, content: content})
}

func TestValidateRestoreTarRejectsTraversalAndLinks(t *testing.T) {
	staging := t.TempDir()
	for _, header := range []*tar.Header{
		{Name: "../escape", Typeflag: tar.TypeReg, Mode: 0600, Size: 1},
		{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc/shadow", Mode: 0777},
	} {
		content := []byte(nil)
		if header.Size > 0 {
			content = []byte("x")
		}
		if err := validateRestoreTar(writeTestTar(t, header, content), staging); err == nil {
			t.Fatalf("accepted unsafe tar header: %+v", header)
		}
	}
}

func TestValidateRestoreTarAcceptsRegularBackupFiles(t *testing.T) {
	header := &tar.Header{Name: "youeye/core/core.tar.enc", Typeflag: tar.TypeReg, Mode: 0600, Size: 2}
	if err := validateRestoreTar(writeTestTar(t, header, []byte("ok")), t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRestoreTarAllowsContainedVolumeSymlink(t *testing.T) {
	document, err := json.Marshal(volumeMapDocument{
		Schema: "youeye.backup.volume-map.v1",
		Volumes: []VolumeMapping{{
			Source:      "/var/lib/youeye/app-open-webui/data",
			ArchivePath: "volumes/app-open-webui/data",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	archive := writeTestTarEntries(t,
		testTarEntry{header: &tar.Header{Name: "volume-map.json", Typeflag: tar.TypeReg, Mode: 0600, Size: int64(len(document))}, content: document},
		testTarEntry{header: &tar.Header{Name: "volumes/app-open-webui/data/snapshots/current/model", Typeflag: tar.TypeSymlink, Linkname: "../../blobs/model", Mode: 0777}},
	)
	if err := validateRestoreTar(archive, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRestoreTarRejectsLinkEscapingItsVolume(t *testing.T) {
	document, err := json.Marshal(volumeMapDocument{
		Schema: "youeye.backup.volume-map.v1",
		Volumes: []VolumeMapping{{
			Source:      "/var/lib/youeye/app-open-webui/data",
			ArchivePath: "volumes/app-open-webui/data",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	archive := writeTestTarEntries(t,
		testTarEntry{header: &tar.Header{Name: "volume-map.json", Typeflag: tar.TypeReg, Mode: 0600, Size: int64(len(document))}, content: document},
		testTarEntry{header: &tar.Header{Name: "volumes/app-open-webui/data/snapshots/current/model", Typeflag: tar.TypeSymlink, Linkname: "../../../../outside", Mode: 0777}},
	)
	if err := validateRestoreTar(archive, t.TempDir()); err == nil {
		t.Fatal("accepted symlink that escapes its declared volume")
	}
}
