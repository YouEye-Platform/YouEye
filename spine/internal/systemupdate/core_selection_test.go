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
	r.Version, r.Build, r.Tag = "0.6.1-dev.2", "0.6.1-dev.2", "youeye-v0.6.1-dev.2"
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
	// The image has its own identity; the document's build names (here those
	// of the fixture, another build) are not compared with it.
	image.ImageVersion, image.BuildID = "0.6.0-dev.9", "appliance-0123456789ab-1"
	bundle, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, BuildID: image.BuildID, SourceTree: image.SourceTree, ReleaseSet: *image.ReleaseSet})
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
	state := t.TempDir()
	root := filepath.Join(state, "bootstrap")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
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
	if err != nil || result.SelectedTag != r.Tag || result.CurrentImage != "0.6.0-dev.9" {
		t.Fatal(result, err)
	}
	// The verified media's image is kept for the release, next to the release
	// records, so later checks need neither the bundle nor a build name.
	if err := (CoreImageBinder{Root: filepath.Join(state, "core-update")}).Bind(r, image); err != nil {
		t.Fatal("fresh media did not record its image binding:", err)
	}
	// A running image that is another build of the same version and tree is
	// not the installed bundle's image.
	other := image
	other.BuildID = "appliance-0123456789ab-2"
	otherRaw, _ := json.Marshal(other)
	if err := os.WriteFile(filepath.Join(root, "image.json"), otherRaw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := check(); err == nil {
		t.Fatal("another image build passed as the installed bundle's image")
	}
	if err := os.WriteFile(filepath.Join(root, "image.json"), imageRaw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bundle.json"), append(bundle, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := check(); err == nil {
		t.Fatal("tampered installed bundle accepted")
	}
}
