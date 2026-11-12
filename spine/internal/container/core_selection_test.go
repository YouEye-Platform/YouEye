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
	image := appliance.Manifest{ReleaseSet: &appliance.ReleaseSet{}}
	for i := range release.Members {
		m := &release.Members[i]
		switch m.Role {
		case "appliance":
			image.ImageVersion, image.SourceTree = m.BuildVersion, m.SourceTree
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
	if err := verifyExistingControlVersion(expected, image, root); err != nil {
		t.Fatal(err)
	}
	for _, wrong := range []string{image.ReleaseSet.ControlPanel.Version, "unknown", "0.5.99"} {
		if err := verifyExistingControlVersion(wrong, image, root); err == nil {
			t.Fatalf("adopted mismatched CP %q", wrong)
		}
	}
	image.ReleaseSet.Spine.ArtifactSHA256 = strings.Repeat("f", 64)
	if err := verifyExistingControlVersion(expected, image, root); err == nil {
		t.Fatal("accepted mismatched baked Spine")
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
		t.Fatal("missing selection with a core policy fell back to legacy")
	}
}

func TestControlReconciliationLegacyAndMissingSelection(t *testing.T) {
	root := t.TempDir()
	image := appliance.Manifest{ReleaseSet: &appliance.ReleaseSet{ControlPanel: appliance.ComponentRelease{Version: "0.5.36"}}}
	if err := verifyExistingControlVersion("0.5.36", image, root); err != nil {
		t.Fatal(err)
	}
	if err := verifyExistingControlVersion("0.5.37", image, root); err == nil {
		t.Fatal("legacy mismatch accepted")
	}
	// A retained new-format policy cannot become a legacy fallback after loss of
	// its release document, even when the installed version matches the image.
	policy := fmt.Sprintf(`{"schema":"youeye.release-policy.v1","repository":"https://github.com/YouEye-Platform/YouEye","channel":"stable","core_manifest_sha256":"%s"}`, strings.Repeat("a", 64))
	if err := os.WriteFile(filepath.Join(root, "release-policy.json"), []byte(policy), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := systemupdate.LoadReleasePolicy(filepath.Join(root, "release-policy.json")); err != nil {
		t.Fatal(err)
	}
	if err := verifyExistingControlVersion("0.5.36", image, root); err == nil {
		t.Fatal("missing required selection accepted")
	}
}
