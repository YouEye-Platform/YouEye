package installer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyApplianceBundleRequiresSignatureAndEveryArtifactIdentity(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	verified, err := verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath)
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

	if err := os.WriteFile(bundle.signaturePath, make([]byte, 64), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature rejection, got %v", err)
	}
}

func TestVerifyApplianceBundleRejectsCorruptPayload(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	rootPath := filepath.Join(filepath.Dir(bundle.manifestPath), "system-root.img")
	if err := os.WriteFile(rootPath, []byte("corrupt payload!\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath); err == nil || !strings.Contains(err.Error(), "artifact system-root") {
		t.Fatalf("expected corrupt payload rejection, got %v", err)
	}
}

func TestParseApplianceManifestRejectsFallbackAndPathEscape(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ReleaseSet.Fallback = []string{"stable"}
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "fallback") {
		t.Fatalf("expected fallback rejection, got %v", err)
	}
	if _, err := applianceAssetPath(filepath.Dir(bundle.manifestPath), "../escape"); err == nil {
		t.Fatal("expected escaped artifact path rejection")
	}
}

func TestApplianceManifestAcceptsOnlySafeMultiSegmentReleaseBranches(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ReleaseSet.Branch = "codex/phase1-repository-builds"
	if err := validateApplianceBundleManifest(manifest); err != nil {
		t.Fatalf("safe multi-segment branch was rejected: %v", err)
	}
	for _, branch := range []string{"codex//escape", "../escape", "codex/bad.lock", "codex/bad~ref"} {
		manifest.ReleaseSet.Branch = branch
		if err := validateApplianceBundleManifest(manifest); err == nil {
			t.Fatalf("unsafe release branch %q was accepted", branch)
		}
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
	manifest.ReleaseSet.Spine.SourceCommit = strings.Repeat("c", 40)
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
		t.Fatalf("signed target minimum = %d GiB, want 32 GiB", manifest.DiskLayout.TargetMinGiB)
	}
	manifest.DiskLayout.TargetMinGiB = 96
	if err := validateApplianceBundleManifest(manifest); err == nil || !strings.Contains(err.Error(), "disk layout") {
		t.Fatalf("obsolete 96 GiB signed contract was accepted: %v", err)
	}
}
