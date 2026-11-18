package systemupdate

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func corePayloadFixture(t *testing.T, extra ...tar.Header) (string, string) {
	t.Helper()
	var data bytes.Buffer
	tw := tar.NewWriter(&data)
	body := []byte("console.log('signed executable');\n")
	if err := tw.WriteHeader(&tar.Header{Name: "./server.js", Mode: 0644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	for i := range extra {
		if err := tw.WriteHeader(&extra[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "core.tar")
	if err := os.WriteFile(archive, data.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return archive, checksum(data.Bytes())
}

func TestCorePayloadRejectsUnsafeArchiveBeforeExtraction(t *testing.T) {
	for _, header := range []tar.Header{
		{Name: "../outside", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: "/absolute", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: "server.js", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: ".env", Typeflag: tar.TypeReg, Mode: 0600},
		{Name: ".next/cache/code.js", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: ".next/server/route-cache/code.js", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: "root-shell", Typeflag: tar.TypeReg, Mode: 04755},
		{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../../outside"},
		{Name: "pipe", Typeflag: tar.TypeFifo, Mode: 0600},
		{Name: "missing-hardlink", Typeflag: tar.TypeLink, Linkname: "absent"},
	} {
		t.Run(header.Name, func(t *testing.T) {
			archive, digest := corePayloadFixture(t, header)
			if _, err := IndexCorePayload(archive, digest); err == nil {
				t.Fatal("accepted unsafe signed archive")
			}
		})
	}
	archive, digest := corePayloadFixture(t,
		tar.Header{Name: "node_modules", Typeflag: tar.TypeSymlink, Linkname: "."},
		tar.Header{Name: "node_modules/code.js", Typeflag: tar.TypeReg, Mode: 0644})
	if _, err := IndexCorePayload(archive, digest); err == nil {
		t.Fatal("archive could write through symlink")
	}
}

func TestCorePayloadTruthDetectsOverlaysWithoutTreatingRuntimeDataAsCode(t *testing.T) {
	archive, digest := corePayloadFixture(t,
		tar.Header{Name: "lib/module.js", Typeflag: tar.TypeReg, Mode: 0644},
		tar.Header{Name: "module", Typeflag: tar.TypeSymlink, Linkname: "lib/module.js"},
		tar.Header{Name: "server-copy.js", Typeflag: tar.TypeLink, Linkname: "server.js"})
	index, err := IndexCorePayload(archive, digest)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "lib"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "lib/module.js"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "server.js"), []byte("console.log('signed executable');\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(root, "server.js"), filepath.Join(root, "server-copy.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("lib/module.js", filepath.Join(root, "module")); err != nil {
		t.Fatal(err)
	}
	strict := func() (CorePayloadFindings, error) { return VerifyCorePayload(root, index, CorePayloadStrict) }
	if found, err := strict(); err != nil || found.Summary() != "verified" {
		t.Fatal(found, err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("fixture runtime config"), 0600); err != nil {
		t.Fatal(err)
	}
	// Runtime configuration is not part of the payload.
	if found, err := strict(); err != nil || found.Summary() != "verified" {
		t.Fatal(found, err)
	}
	// A file we did not ship is counted and reported, never refused: the strict
	// check is about the files this release wrote.
	overlay := filepath.Join(root, "extra.js")
	if err := os.WriteFile(overlay, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if found, err := strict(); err != nil || found.Unrecorded != 1 || found.Summary() != "verified, 1 extra file" {
		t.Fatal("extra file not counted, or refused", found, err)
	}
	if err := os.Remove(overlay); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "server.js"), 0755); err != nil {
		t.Fatal(err)
	}
	// server.js and its hardlink share one inode, so both recorded paths changed.
	if found, err := strict(); err == nil || found.Changed != 2 || found.Reasons["changed-mode"] != 2 {
		t.Fatal("executable mode change not detected", found, err)
	}
	if err := os.Chmod(filepath.Join(root, "server.js"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "server.js"), []byte("tampered"), 0644); err != nil {
		t.Fatal(err)
	}
	if found, err := strict(); err == nil || found.Changed != 2 || found.Reasons["changed-bytes"] != 2 {
		t.Fatal("modified code not detected", found, err)
	}
	if found, err := VerifyCorePayload(root, index, CorePayloadRecord); err != nil || found.Summary() != "modified (2 changed, 0 missing)" {
		t.Fatal("record mode refused or miscounted a modified tree", found, err)
	}
}
