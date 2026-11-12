package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyApplianceBundleRequiresEveryArtifactIdentity(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	verified, err := verifyApplianceBundle(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if verified.ManifestSHA256 != bundle.manifestSHA {
		t.Fatalf("manifest SHA=%s want %s", verified.ManifestSHA256, bundle.manifestSHA)
	}
	wantRoles := []string{"internal-recovery", "recovery-uki", "system-a-uki", "system-b-uki", "system-root"}
	if got := applianceArtifactRoles(verified.Assets); strings.Join(got, ",") != strings.Join(wantRoles, ",") {
		t.Fatalf("roles=%v want %v", got, wantRoles)
	}

	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundle.manifestPath, []byte(strings.Replace(string(raw), `"schema"`, `"trust": {}, "schema"`, 1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyApplianceBundle(bundle.manifestPath); err == nil {
		t.Fatal("manifest with a removed trust key was accepted")
	}
}

func TestVerifyApplianceBundleRejectsCorruptPayload(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	rootPath := filepath.Join(filepath.Dir(bundle.manifestPath), "system-root.img")
	if err := os.WriteFile(rootPath, []byte("corrupt payload!\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyApplianceBundle(bundle.manifestPath); err == nil || !strings.Contains(err.Error(), "artifact system-root") {
		t.Fatalf("expected corrupt payload rejection, got %v", err)
	}
}

func TestParseApplianceManifestRejectsRemovedReleaseKeysAndPathEscape(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseApplianceBundleManifest(raw); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{`"fallback": ["stable"], `, `"branch": "dev", `, `"source": "custom", `} {
		mutated := strings.Replace(string(raw), `"release_set": {`, `"release_set": {`+removed, 1)
		if mutated == string(raw) {
			t.Fatal("test manifest has no release_set")
		}
		if _, err := parseApplianceBundleManifest([]byte(mutated)); err == nil {
			t.Fatalf("manifest with removed release_set key %s accepted", removed)
		}
	}
	if _, err := parseApplianceBundleManifest([]byte(strings.Replace(string(raw), `"source_tree"`, `"source_commit": "x", "source_tree"`, 1))); err == nil {
		t.Fatal("manifest with removed source_commit accepted")
	}
	if _, err := applianceAssetPath(filepath.Dir(bundle.manifestPath), "../escape"); err == nil {
		t.Fatal("expected escaped artifact path rejection")
	}
}

func TestValidateApplianceManifestRequiresStrictVersion(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ImageVersion = "0.6.0-dev.01"
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("malformed image version result = %v", err)
	}
}

func TestValidateApplianceManifestRejectsIncompatibleRuntimeContract(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}

	manifest.StateSchemaMin = applianceStateSchema - 1
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "state schema") {
		t.Fatalf("incompatible state schema result = %v", err)
	}
	manifest.StateSchemaMin = applianceStateSchema
	manifest.KernelCompatibility = ">=99"
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "runtime compatibility") {
		t.Fatalf("incompatible runtime result = %v", err)
	}
	manifest.KernelCompatibility = applianceKernelCompatibility
	manifest.ReleaseSet.Spine.SourceTree = strings.Repeat("c", 40)
	if err := validateApplianceBundleManifest(manifest); err != nil {
		t.Fatalf("independent exact appliance and Spine source identities were rejected: %v", err)
	}
}

func TestValidateApplianceManifestRequiresThirtyTwoGiBTargetContract(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.DiskLayout.TargetMinGiB != 32 {
		t.Fatalf("target minimum = %d GiB, want 32 GiB", manifest.DiskLayout.TargetMinGiB)
	}
	manifest.DiskLayout.TargetMinGiB = 96
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "disk layout") {
		t.Fatalf("obsolete 96 GiB contract was accepted: %v", err)
	}
}
