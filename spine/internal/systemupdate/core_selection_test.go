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
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	source := "https://forge.example/owner/YouEye"
	r.Source, r.Branch, r.Channel, r.Version, r.Tag = source, "Team/Fix", "feature", "0.5.38-worker-abcd.1", "youeye-v0.5.38-worker-abcd.1"
	raw, _ = json.Marshal(r)
	digest := fmt.Sprintf("%x", sha256.Sum256(raw))
	root := t.TempDir()
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "custom", ReleasesAPI: "https://forge.example/api/v1/repos/owner/YouEye/releases", Mode: "track", Track: "branch", Branch: "Team/Fix", CoreManifestSHA256: digest, Freshness: "require-current", ServiceSelection: "current"}
	writeCoreSelectionFixture(t, root, raw, policy)
	selection, actual, err := ReadCoreSelection(root)
	if err != nil || actual != digest {
		t.Fatal(actual, err)
	}
	if err := ValidateCorePolicy(policy, selection, digest); err != nil {
		t.Fatal(err)
	}
	policy.Branch = "team/fix"
	if err := ValidateCorePolicy(policy, selection, digest); err == nil {
		t.Fatal("case-folded policy selected another branch")
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
	policy = ReleasePolicy{Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: "youeye-v0.5.38", ManifestSHA256: strings.Repeat("a", 64), Freshness: "require-current"}
	if err := policy.Validate(); err == nil {
		t.Fatal("core exact selection lacks its separate manifest digest")
	}
	policy.CoreManifestSHA256 = digest
	if err := policy.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestCoreFreshMediaSeparatesSharedReleaseFromReusedImage(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	original := r.Source
	r.Source = "https://forge.example/owner/YouEye"
	for i := range r.Members {
		m := &r.Members[i]
		m.Source = r.Source
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, m.BuildInputs} {
			if b != nil {
				b.URL = strings.Replace(b.URL, original, r.Source, 1)
			}
		}
	}
	image := testApplianceManifest("0.5.37", r.SourceCommit)
	image.ReleaseSet = &appliance.ReleaseSet{Source: r.Source, Branch: "main", Fallback: []string{}}
	for _, m := range r.Members {
		c := appliance.ComponentRelease{Version: m.BuildVersion, Tag: m.Tag, SourceCommit: m.SourceCommit, ArtifactSHA256: m.Artifact.SHA256}
		switch m.Role {
		case "spine":
			image.ReleaseSet.Spine = c
		case "cp":
			image.ReleaseSet.ControlPanel = c
		case "ui":
			image.ReleaseSet.UI = c
		}
	}
	bundle, _ := json.Marshal(exactBundleManifest{Schema: "youeye.appliance.manifest.v1", ImageVersion: image.ImageVersion, SourceCommit: image.SourceCommit, ReleaseSet: *image.ReleaseSet})
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
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "custom", ReleasesAPI: "https://forge.example/api/v1/repos/owner/YouEye/releases", Mode: "exact", ExactTag: r.Tag, ManifestSHA256: fmt.Sprintf("%x", sha256.Sum256(bundle)), CoreManifestSHA256: digest, Freshness: "require-current"}
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
	if err != nil || result.SelectedTag != "youeye-v0.5.38" || result.CurrentImage != "0.5.37" {
		t.Fatal(result, err)
	}
	if err := os.WriteFile(filepath.Join(root, "bundle.json"), append(bundle, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := check(); err == nil {
		t.Fatal("tampered installed bundle accepted")
	}
}
