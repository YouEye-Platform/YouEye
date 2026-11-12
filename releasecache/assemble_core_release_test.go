package releasecache

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The repository's release assembly script and this reader must not drift.
func TestAssembleCoreReleaseScriptOutputParses(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	dir := t.TempDir()
	names := []string{"youeye-installer-linux-amd64", "youeye-appliance-amd64.iso", "appliance-manifest.json", "system-update-manifest.json", "build-inputs.json", "system-root.img.zst", "system-a.efi", "system-b.efi", "youeye-system-updater-linux-amd64", "internal-recovery.img.zst", "recovery.efi", "youeye-system-update-bootstrap", "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tree := strings.Repeat("a", 40)
	run := func(version string) ([]byte, error) {
		return exec.Command(python, "../scripts/assemble-core-release.py", "--version", version, "--source-tree", tree, "--sequence", "3", "--minimum-release", "0.6.1-rc.1", "--artifacts", dir).CombinedOutput()
	}
	if out, err := run("0.6.1-rc.3"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	r, digest, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal("assembled document rejected:", err)
	}
	if r.Authority != CoreReleaseAuthority || r.Tag != "youeye-v0.6.1-rc.3" || r.SourceTree != tree || len(r.Members) != 14 {
		t.Fatalf("unexpected identity %+v", r)
	}
	for _, forbidden := range []string{"source\"", "branch", "channel", "source_commit", "url", "https://"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("host-specific field %q in assembled document", forbidden)
		}
	}
	for _, m := range r.Members {
		file, err := os.ReadFile(filepath.Join(dir, m.Artifact.Name))
		h := sha256.Sum256(file)
		if err != nil || m.Artifact.SHA256 != hex.EncodeToString(h[:]) || m.Artifact.SizeBytes != int64(len(file)) || m.SourceTree != tree {
			t.Fatalf("%s artifact binding is wrong", m.Role)
		}
	}
	sums, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if err != nil || !strings.Contains(string(sums), digest+"  core-release.json\n") || strings.Count(string(sums), "\n") != len(names)+1 {
		t.Fatalf("SHA256SUMS is incomplete: %s %v", sums, err)
	}
	os.Remove(filepath.Join(dir, "ui-standalone.tar"))
	if out, err := run("0.6.1-rc.3"); err == nil {
		t.Fatalf("missing artifact accepted: %s", out)
	}
}
