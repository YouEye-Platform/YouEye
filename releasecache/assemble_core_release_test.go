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
	names := []string{"youeye-installer-linux-amd64", "youeye-appliance-amd64.iso", "appliance-manifest.json", "system-update-manifest.json", "build-inputs.json", "system-root.img.zst", "system-a.efi", "system-b.efi", "youeye-system-updater-linux-amd64", "internal-recovery.img.zst", "recovery.efi", "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tree := strings.Repeat("a", 40)
	run := func(version string) ([]byte, error) {
		return exec.Command(python, "../scripts/assemble-core-release.py", "--version", version, "--source-tree", tree, "--sequence", "3", "--minimum-release", "0.6.1-dev.1", "--artifacts", dir).CombinedOutput()
	}
	if out, err := run("0.6.1-dev.3"); err != nil {
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
	if r.Authority != CoreReleaseAuthority || r.Tag != "youeye-v0.6.1-dev.3" || r.SourceTree != tree || len(r.Members) != 13 {
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
	if out, err := run("0.6.1-dev.3"); err == nil {
		t.Fatalf("missing artifact accepted: %s", out)
	}
}

// A Spine/CP/UI release reuses the previous release's image members unchanged.
func TestAssembleCoreReleaseReusesImage(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	full, services := t.TempDir(), t.TempDir()
	names := []string{"youeye-installer-linux-amd64", "youeye-appliance-amd64.iso", "appliance-manifest.json", "system-update-manifest.json", "build-inputs.json", "system-root.img.zst", "system-a.efi", "system-b.efi", "youeye-system-updater-linux-amd64", "internal-recovery.img.zst", "recovery.efi", "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(full, name), []byte("v1 "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar"} {
		if err := os.WriteFile(filepath.Join(services, name), []byte("new "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run := func(dir, version, tree string, extra ...string) {
		args := append([]string{"../scripts/assemble-core-release.py", "--version", version, "--source-tree", tree, "--sequence", "5", "--minimum-release", "0.6.1-dev.1", "--artifacts", dir}, extra...)
		if out, err := exec.Command(python, args...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	run(full, "0.6.1-dev.3", strings.Repeat("a", 40))
	run(services, "0.6.1-dev.4", strings.Repeat("b", 40), "--reuse", filepath.Join(full, "core-release.json")+"=image")
	raw, err := os.ReadFile(filepath.Join(services, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range r.Members {
		service := m.Role == "spine" || m.Role == "cp" || m.Role == "ui"
		if service && (m.BuildVersion != "0.6.1-dev.4" || m.Artifact.Release != "" || m.SourceTree != strings.Repeat("b", 40)) {
			t.Fatalf("%s should be built fresh: %+v", m.Role, m)
		}
		if !service && (m.BuildVersion != "0.6.1-dev.3" || m.Artifact.Release != "youeye-v0.6.1-dev.3" || m.SourceTree != strings.Repeat("a", 40)) {
			t.Fatalf("%s should be reused from rc.3: %+v", m.Role, m)
		}
	}
	if app, _ := r.Member("appliance"); app.BuildInputs == nil || app.BuildInputs.Release != "youeye-v0.6.1-dev.3" {
		t.Fatal("appliance build inputs not reused")
	}
	if AssetURL("https://x.test/o/YouEye", "", r.Tag, mustMember(t, r, "media").Artifact) != "https://x.test/o/YouEye/releases/download/youeye-v0.6.1-dev.3/youeye-appliance-amd64.iso" {
		t.Fatal("reused media not located in its own release")
	}
}

func mustMember(t *testing.T, r CoreRelease, role string) CoreMember {
	m, ok := r.Member(role)
	if !ok {
		t.Fatal("missing", role)
	}
	return m
}
