package container

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestControlReconciliationUsesAcceptedSparseMember(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	release, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	// The image has its own identity, bound through the release's bundle
	// manifest (recorded on State), not through a build name.
	image := appliance.Manifest{ImageVersion: "0.6.0-dev.7", BuildID: "appliance-111111111111-1", ReleaseSet: &appliance.ReleaseSet{}}
	for i := range release.Members {
		m := &release.Members[i]
		switch m.Role {
		case "appliance":
			image.SourceTree = m.SourceTree
			bindFixtureImage(t, m.Artifact.SHA256, image)
		case "spine":
			image.ReleaseSet.Spine = appliance.ComponentRelease{Version: m.BuildVersion, SourceTree: m.SourceTree, ArtifactSHA256: m.Artifact.SHA256}
		case "cp":
			image.ReleaseSet.ControlPanel.Version = "0.5.36"
		}
	}
	root := t.TempDir()
	raw, err = json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	policy := fmt.Sprintf(`{"schema":"youeye.release-policy.v1","repository":"https://forge.example/owner/YouEye","channel":"stable","core_manifest_sha256":"%x"}`, sha256.Sum256(raw))
	for name, contents := range map[string][]byte{"core-release.json": raw, "release-policy.json": []byte(policy)} {
		if err := os.WriteFile(filepath.Join(root, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	expected := ""
	for _, m := range release.Members {
		if m.Role == "cp" {
			expected = m.BuildVersion
		}
	}
	if expected == image.ReleaseSet.ControlPanel.Version {
		t.Fatal("fixture must have reused media")
	}
	// A Control Panel built before 0.6.12 says only its version: it is the
	// member's when that is the member's build name.
	if err := verifyExistingControlVersion(InstalledIdentity{Version: expected}, image, root); err != nil {
		t.Fatal(err)
	}
	for _, wrong := range []string{image.ReleaseSet.ControlPanel.Version, "unknown", "0.5.99", ""} {
		if err := verifyExistingControlVersion(InstalledIdentity{Version: wrong}, image, root); err == nil {
			t.Fatalf("adopted mismatched CP %q", wrong)
		}
	}
	// One that says its git tree is judged by the tree alone.
	cp, _ := release.Member("cp")
	if err := verifyExistingControlVersion(InstalledIdentity{Version: "0.6.99", SourceTree: cp.SourceTree}, image, root); err != nil {
		t.Fatal("the member's own tree was refused:", err)
	}
	if err := verifyExistingControlVersion(InstalledIdentity{Version: expected, SourceTree: strings.Repeat("9", 40)}, image, root); err == nil {
		t.Fatal("another tree was adopted under the member's build name")
	}
	// The baked Spine is only the seed; the release's Spine is selected on
	// State, so a different baked Spine does not block reconciliation.
	image.ReleaseSet.Spine.ArtifactSHA256 = strings.Repeat("f", 64)
	if err := verifyExistingControlVersion(InstalledIdentity{Version: expected}, image, root); err != nil {
		t.Fatalf("baked seed Spine blocked reconciliation: %v", err)
	}
	// Another image build is not the release's image, whatever it is called.
	other := image
	other.BuildID = "appliance-111111111111-2"
	if err := verifyExistingControlVersion(InstalledIdentity{Version: expected}, other, root); err == nil {
		t.Fatal("another image build was reconciled")
	}
	raw[len(raw)-2] ^= 1
	if err := os.WriteFile(filepath.Join(root, "core-release.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := optionalCoreSelection(root); err == nil {
		t.Fatal("accepted modified selection")
	}
	if err := os.Remove(filepath.Join(root, "core-release.json")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := optionalCoreSelection(root); err == nil {
		t.Fatal("missing selection with a core policy was accepted")
	}
}

func TestControlReconciliationRequiresSelection(t *testing.T) {
	root := t.TempDir()
	image := appliance.Manifest{ReleaseSet: &appliance.ReleaseSet{ControlPanel: appliance.ComponentRelease{Version: "0.5.36"}}}
	if err := verifyExistingControlVersion(InstalledIdentity{Version: "0.5.36"}, image, root); err == nil {
		t.Fatal("reconciliation without a System selection accepted the image's CP version")
	}
	// A retained policy cannot fall back to the image's CP version after loss
	// of its release document, even when the installed version matches it.
	policy := fmt.Sprintf(`{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable","core_manifest_sha256":"%s"}`, strings.Repeat("a", 64))
	if err := os.WriteFile(filepath.Join(root, "release-policy.json"), []byte(policy), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := systemupdate.LoadReleasePolicy(filepath.Join(root, "release-policy.json")); err != nil {
		t.Fatal(err)
	}
	if err := verifyExistingControlVersion(InstalledIdentity{Version: "0.5.36"}, image, root); err == nil {
		t.Fatal("missing required selection accepted")
	}
}

// bindFixtureImage records that the appliance member with this digest stands
// for image, as a box does once it has seen the release's bundle manifest.
func bindFixtureImage(t *testing.T, applianceSHA256 string, image appliance.Manifest) {
	t.Helper()
	root := t.TempDir()
	old := systemupdate.InstalledCoreImageBinder
	systemupdate.InstalledCoreImageBinder = func() systemupdate.CoreImageBinder { return systemupdate.CoreImageBinder{Root: root} }
	t.Cleanup(func() { systemupdate.InstalledCoreImageBinder = old })
	raw, _ := json.Marshal(map[string]string{"schema": "youeye.core-image-binding.v1", "appliance_sha256": applianceSHA256,
		"image_version": image.ImageVersion, "build_id": image.BuildID, "source_tree": image.SourceTree})
	if err := os.MkdirAll(filepath.Join(root, "image-bindings"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "image-bindings", applianceSHA256+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestParseInstalledIdentity(t *testing.T) {
	tree := strings.Repeat("a", 40)
	for raw, want := range map[string]InstalledIdentity{
		`{"version":"0.6.12-dev.3","source_tree":"` + tree + `"}`: {Version: "0.6.12-dev.3", SourceTree: tree},
		`{"version":"0.6.11-dev.6"}`:                              {Version: "0.6.11-dev.6"},
		`{"version":" 0.6.13 ","source_tree":"not a tree","x":1}`: {Version: "0.6.13"},
		`{"version":"0.6.13","source_tree":"` + tree[:39] + `"}`:  {Version: "0.6.13"},
		`not json`: {},
		`{}`:       {},
	} {
		if got := ParseInstalledIdentity([]byte(raw)); got != want {
			t.Errorf("%s: %+v", raw, got)
		}
	}
}
