package systemupdate

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
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
	if err := VerifyCorePayload(root, index); err != nil {
		t.Fatal(err)
	}
	verifyNode := func(want bool) {
		t.Helper()
		if _, err := exec.LookPath("node"); err != nil {
			t.Skip("native Node runtime not installed")
		}
		raw, _ := json.Marshal(index)
		cmd := exec.Command("node", "-e", corePayloadVerifier, root)
		cmd.Stdin = bytes.NewReader(raw)
		out, err := cmd.Output()
		if want != (err == nil && string(out) == "verified\n") {
			t.Fatalf("Node verifier result=%q error=%v wanted=%v", out, err, want)
		}
	}
	verifyNode(true)
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("fixture runtime config"), 0600); err != nil {
		t.Fatal(err)
	}
	// The parent directory belongs to the payload; a cache can only appear
	// inside that recorded directory, never replace executable structure.
	if err := VerifyCorePayload(root, index); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(root, "extra.js")
	if err := os.WriteFile(overlay, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCorePayload(root, index); err == nil {
		t.Fatal("extra executable not detected")
	}
	verifyNode(false)
	if err := os.Remove(overlay); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "server.js"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCorePayload(root, index); err == nil {
		t.Fatal("executable mode change not detected")
	}
	if err := os.Chmod(filepath.Join(root, "server.js"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "server.js"), []byte("tampered"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCorePayload(root, index); err == nil {
		t.Fatal("modified code not detected")
	}
	verifyNode(false)
}
