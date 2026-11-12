package systemupdate

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
)

func writeCoreSelectionFixture(t *testing.T, root string, raw []byte, policy ReleasePolicy) {
	t.Helper()
	policyRaw, _ := json.Marshal(policy)
	for name, data := range map[string][]byte{"core-release.json": raw, "release-policy.json": policyRaw} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCoreSelectionBindsAcceptedDigestAndExactPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Version, r.Tag = "0.6.1-rc.2", "youeye-v0.6.1-rc.2"
	raw, _ = json.Marshal(r)
	digest := fmt.Sprintf("%x", sha256.Sum256(raw))
	root := t.TempDir()
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Repository: "https://forge.example/owner/YouEye", Channel: "dev", CoreManifestSHA256: digest, ServiceSelection: "current"}
	writeCoreSelectionFixture(t, root, raw, policy)
	selection, actual, err := ReadCoreSelection(root)
	if err != nil || actual != digest {
		t.Fatal(actual, err)
	}
	if err := ValidateCorePolicy(policy, selection, digest); err != nil {
		t.Fatal(err)
	}
	other := policy
	other.CoreManifestSHA256 = strings.Repeat("a", 64)
	if err := ValidateCorePolicy(other, selection, digest); err == nil {
		t.Fatal("policy for another document accepted")
	}
	// Any change to the recorded document breaks the accepted digest.
	r.Members[0].Artifact.SHA256 = strings.Repeat("f", 64)
	tampered, _ := json.Marshal(r)
	if err := os.WriteFile(filepath.Join(root, "core-release.json"), tampered, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadCoreSelection(root); err == nil || !strings.Contains(err.Error(), "accepted release digest") {
		t.Fatal("tampered selection accepted", err)
	}
}

func TestCoreFreshMediaSeparatesSharedReleaseFromReusedImage(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	media, _ := r.Member("appliance")
	image := testApplianceManifest(media.BuildVersion, r.SourceTree)
	image.ReleaseSet = &appliance.ReleaseSet{}
	for _, m := range r.Members {
		c := appliance.ComponentRelease{Version: m.BuildVersion, SourceTree: m.SourceTree, ArtifactSHA256: m.Artifact.SHA256}
		switch m.Role {
		case "spine":
			image.ReleaseSet.Spine = c
		case "cp":
			image.ReleaseSet.ControlPanel = c
		case "ui":
			image.ReleaseSet.UI = c
		}
	}
	bundle, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, SourceTree: image.SourceTree, ReleaseSet: *image.ReleaseSet})
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			m := &r.Members[i]
			m.Artifact.SHA256, m.Artifact.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(bundle)), int64(len(bundle))
		}
	}
	raw, _ = json.Marshal(r)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Repository: "https://forge.example/owner/YouEye", Channel: "stable", CoreManifestSHA256: digest}
	writeCoreSelectionFixture(t, root, raw, policy)
	imageRaw, _ := json.Marshal(image)
	for name, bytes := range map[string][]byte{"image.json": imageRaw, "bundle.json": bundle} {
		if err := os.WriteFile(filepath.Join(root, name), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	check := func() (ConvergenceResult, error) {
		return VerifyCoreInstalledMedia(policy, root, filepath.Join(root, "image.json"), filepath.Join(root, "bundle.json"))
	}
	result, err := check()
	if err != nil || result.SelectedTag != r.Tag || result.CurrentImage != media.BuildVersion {
		t.Fatal(result, err)
	}
	if err := os.WriteFile(filepath.Join(root, "bundle.json"), append(bundle, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := check(); err == nil {
		t.Fatal("tampered installed bundle accepted")
	}
}
