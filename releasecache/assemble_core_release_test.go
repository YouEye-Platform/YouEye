package releasecache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var assembledNames = []string{"youeye-installer-linux-amd64", "youeye-appliance-amd64.iso", "appliance-manifest.json", "system-update-manifest.json", "build-inputs.json", "system-root.img.zst", "system-a.efi", "system-b.efi", "youeye-system-updater-linux-amd64", "internal-recovery.img.zst", "recovery.efi", "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar"}

func assemble(t *testing.T, dir, version, tree, sequence string, extra ...string) ([]byte, error) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		// Never skipped: these tests are the only check of the script that
		// writes every published release document.
		t.Fatalf("python3 is required on every build and test host: %v", err)
	}
	args := append([]string{"../scripts/assemble-core-release.py", "--version", version, "--source-tree", tree, "--sequence", sequence, "--minimum-release", "0.6.12", "--artifacts", dir}, extra...)
	return exec.Command(python, args...).CombinedOutput()
}

func writeAssembledFixtures(t *testing.T, dir string, content func(name string) string, names ...string) {
	t.Helper()
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content(name)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// devNameOutsideLocations returns the places in a core-release.json that
// name a dev build, except the version and tag (allowed when allowName) and
// the blob "release" fields, which are file locations: an alpha document
// names the Forgejo dev release that holds its files (Plan 12 E4).
func devNameOutsideLocations(t *testing.T, raw []byte, allowName bool) []string {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	dev := regexp.MustCompile(`-dev\.`)
	var found []string
	var walk func(path string, value any)
	walk = func(path string, value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				walk(path+"."+key, child)
			}
		case []any:
			for i, child := range v {
				walk(fmt.Sprintf("%s[%d]", path, i), child)
			}
		case string:
			if !dev.MatchString(v) {
				return
			}
			if strings.HasSuffix(path, ".artifact.release") || strings.HasSuffix(path, ".build_inputs.release") {
				return
			}
			if allowName && (path == ".version" || path == ".tag") {
				return
			}
			found = append(found, path+"="+v)
		}
	}
	walk("", document)
	return found
}

// The repository's release assembly script and this reader must not drift.
func TestAssembleCoreReleaseScriptOutputParses(t *testing.T) {
	dir := t.TempDir()
	writeAssembledFixtures(t, dir, func(name string) string { return "fixture " + name + "\n" }, assembledNames...)
	tree := strings.Repeat("1", 40)
	if out, err := assemble(t, dir, "0.6.13-dev.3", tree, "1795200000"); err != nil {
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
	if r.Authority != CoreReleaseAuthority || r.Tag != "youeye-v0.6.13-dev.3" || r.SourceTree != tree || len(r.Members) != 13 {
		t.Fatalf("unexpected identity %+v", r)
	}
	// The clean shape (Plan 12 E2): no build names, reader 2, a line as the floor.
	if r.Build != "" || r.MinimumReader != 2 || r.Compatibility.MinimumRelease != "0.6.12" || r.Sequence != 1795200000 {
		t.Fatalf("not the clean shape: %+v", r)
	}
	for _, forbidden := range []string{`"build"`, `"build_version"`, "source\"", "branch", "channel", "source_commit", "url", "https://"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("field %q in assembled document", forbidden)
		}
	}
	for _, m := range r.Members {
		file, err := os.ReadFile(filepath.Join(dir, m.Artifact.Name))
		h := sha256.Sum256(file)
		if err != nil || m.Artifact.SHA256 != hex.EncodeToString(h[:]) || m.Artifact.SizeBytes != int64(len(file)) || m.SourceTree != tree || m.BuildVersion != "" {
			t.Fatalf("%s artifact binding is wrong", m.Role)
		}
	}
	// The same inputs give the payload of the frozen fixture without build
	// names (TestPayloadDigestIsFrozen), whatever the document is called.
	if got := r.PayloadSHA256(); got != "28a2bdddb2965a86e281b47ec6a1d4f37d4b43ee44fd1e22a1e471be383351f5" {
		t.Errorf("assembled payload %s differs from the frozen fixture's", got)
	}
	sums, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if err != nil || !strings.Contains(string(sums), digest+"  core-release.json\n") || strings.Count(string(sums), "\n") != len(assembledNames)+1 {
		t.Fatalf("SHA256SUMS is incomplete: %s %v", sums, err)
	}
	os.Remove(filepath.Join(dir, "ui-standalone.tar"))
	if out, err := assemble(t, dir, "0.6.13-dev.3", tree, "3"); err == nil {
		t.Fatalf("missing artifact accepted: %s", out)
	}
}

// The assembler refuses what a clean document cannot carry.
func TestAssembleCoreReleaseRefusesNames(t *testing.T) {
	dir := t.TempDir()
	writeAssembledFixtures(t, dir, func(name string) string { return "fixture " + name + "\n" }, assembledNames...)
	tree := strings.Repeat("a", 40)
	for _, version := range []string{"0.6.13", "0.6.13-alpha.1", "0.6.13-beta.1"} {
		if out, err := assemble(t, dir, version, tree, "3"); err == nil {
			t.Fatalf("release name %s assembled as a build: %s", version, out)
		}
	}
	python, _ := exec.LookPath("python3")
	for _, minimum := range []string{"0.6.5-dev.2", "0.6", "v0.6.12"} {
		out, err := exec.Command(python, "../scripts/assemble-core-release.py", "--version", "0.6.13-dev.1", "--source-tree", tree, "--minimum-release", minimum, "--artifacts", dir).CombinedOutput()
		if err == nil || !strings.Contains(string(out), "release line") {
			t.Fatalf("minimum release %s accepted: %s", minimum, out)
		}
	}
}

// Plan 12 E4 for what the assembler writes: a dev document names its build
// only in version and tag, and once promoted (a new version and tag for the
// same payload, as Tools/release/promote writes it) it names no dev build
// outside the file locations. The image manifests (decision 9) and binary
// artifacts are outside the document.
func TestAssembledReleaseNamesNoBuildOncePromoted(t *testing.T) {
	full, services := t.TempDir(), t.TempDir()
	writeAssembledFixtures(t, full, func(name string) string { return "v1 " + name }, assembledNames...)
	writeAssembledFixtures(t, services, func(name string) string { return "new " + name }, "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar")
	if out, err := assemble(t, full, "0.6.13-dev.1", strings.Repeat("a", 40), "5"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out, err := assemble(t, services, "0.6.13-dev.2", strings.Repeat("b", 40), "6", "--reuse", filepath.Join(full, "core-release.json")+"=image"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	for _, dir := range []string{full, services} {
		raw, err := os.ReadFile(filepath.Join(dir, "core-release.json"))
		if err != nil {
			t.Fatal(err)
		}
		if found := devNameOutsideLocations(t, raw, true); len(found) != 0 {
			t.Fatalf("the dev document names a build outside version, tag and file locations: %v", found)
		}
		dev, _, err := ParseCoreRelease(raw)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"0.6.13-alpha.1", "0.6.13-beta.1", "0.6.13"} {
			var document map[string]any
			if err := json.Unmarshal(raw, &document); err != nil {
				t.Fatal(err)
			}
			document["version"], document["tag"] = name, "youeye-v"+name
			promotedRaw, _ := json.MarshalIndent(document, "", "  ")
			if found := devNameOutsideLocations(t, promotedRaw, false); len(found) != 0 {
				t.Fatalf("%s names a dev build: %v", name, found)
			}
			promoted, _, err := ParseCoreRelease(promotedRaw)
			if err != nil {
				t.Fatal(err)
			}
			if promoted.PayloadSHA256() != dev.PayloadSHA256() || CompareReleases(promoted.Key(), dev.Key()) != 0 {
				t.Fatalf("%s is not the same release as %s", name, dev.Version)
			}
		}
		sums, _ := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
		if strings.Contains(string(sums), "-dev.") {
			t.Fatalf("SHA256SUMS names a build: %s", sums)
		}
	}
}

// A Spine/CP/UI release reuses the previous release's image members: their
// tree, input hash and files, located in the release that holds them.
func TestAssembleCoreReleaseReusesImage(t *testing.T) {
	full, services := t.TempDir(), t.TempDir()
	writeAssembledFixtures(t, full, func(name string) string { return "v1 " + name }, assembledNames...)
	writeAssembledFixtures(t, services, func(name string) string { return "new " + name }, "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar")
	if out, err := assemble(t, full, "0.6.13-dev.3", strings.Repeat("a", 40), "5"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out, err := assemble(t, services, "0.6.13-dev.4", strings.Repeat("b", 40), "6", "--reuse", filepath.Join(full, "core-release.json")+"=image"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(services, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := ParseCoreRelease(mustRead(t, filepath.Join(full, "core-release.json")))
	for _, m := range r.Members {
		service := m.Role == "spine" || m.Role == "cp" || m.Role == "ui"
		if service && (m.Artifact.Release != "" || m.SourceTree != strings.Repeat("b", 40)) {
			t.Fatalf("%s should be built fresh: %+v", m.Role, m)
		}
		if !service {
			earlier := mustMember(t, first, m.Role)
			if m.Artifact.Release != "youeye-v0.6.13-dev.3" || m.SourceTree != strings.Repeat("a", 40) || m.InputSHA256 != earlier.InputSHA256 || m.Artifact.SHA256 != earlier.Artifact.SHA256 {
				t.Fatalf("%s should be reused from dev.3: %+v", m.Role, m)
			}
		}
	}
	if app, _ := r.Member("appliance"); app.BuildInputs == nil || app.BuildInputs.Release != "youeye-v0.6.13-dev.3" {
		t.Fatal("appliance build inputs not reused")
	}
	if AssetURL("https://x.test/o/YouEye", "", r.Tag, mustMember(t, r, "media").Artifact) != "https://x.test/o/YouEye/releases/download/youeye-v0.6.13-dev.3/youeye-appliance-amd64.iso" {
		t.Fatal("reused media not located in its own release")
	}
}

// Members reused from an old-shape (0.6.12) document come over as they are,
// minus their build_version: the same tree, input hash and file, located in
// the 0.6.12 release.
func TestAssembleCoreReleaseReusesOldShapeMembers(t *testing.T) {
	old := t.TempDir()
	if err := os.WriteFile(filepath.Join(old, "core-release.json"), mustRead(t, "testdata/core-release.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	previous, _, err := ParseCoreRelease(mustRead(t, "testdata/core-release.json"))
	if err != nil || previous.Build == "" {
		t.Fatalf("the old-shape fixture: %+v %v", previous, err)
	}
	services := t.TempDir()
	writeAssembledFixtures(t, services, func(name string) string { return "new " + name }, "spine-linux-amd64", "cp-standalone.tar", "ui-standalone.tar")
	if out, err := assemble(t, services, "0.6.13-dev.1", strings.Repeat("b", 40), "1795200000", "--reuse", filepath.Join(old, "core-release.json")+"=image"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	raw := mustRead(t, filepath.Join(services, "core-release.json"))
	if strings.Contains(string(raw), "build_version") || strings.Contains(string(raw), `"build"`) {
		t.Fatalf("an old-shape field came over: %s", raw)
	}
	r, _, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range r.Members {
		if m.Role == "spine" || m.Role == "cp" || m.Role == "ui" {
			continue
		}
		earlier := mustMember(t, previous, m.Role)
		if m.BuildVersion != "" || m.SourceTree != earlier.SourceTree || m.InputSHA256 != earlier.InputSHA256 || m.Artifact.SHA256 != earlier.Artifact.SHA256 ||
			m.Artifact.SizeBytes != earlier.Artifact.SizeBytes || m.Artifact.Release != previous.Tag {
			t.Fatalf("%s not reused as it was: %+v", m.Role, m)
		}
	}
	if found := devNameOutsideLocations(t, raw, true); len(found) != 0 {
		t.Fatalf("names a build outside version, tag and file locations: %v", found)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mustMember(t *testing.T, r CoreRelease, role string) CoreMember {
	m, ok := r.Member(role)
	if !ok {
		t.Fatal("missing", role)
	}
	return m
}
