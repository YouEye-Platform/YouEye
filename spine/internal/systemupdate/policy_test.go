package systemupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReleasePolicyStrictValidationAndSelection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"branch","branch":"f-test","freshness":"require-current"}`), 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadReleasePolicy(path)
	if err != nil {
		t.Fatal(err)
	}
	selection := policy.Selection()
	if selection.Channel != "branch" || selection.Branch != "f-test" || selection.Provider != "github" {
		t.Fatalf("unexpected policy selection: %+v", selection)
	}
	policy.Branch = "codex/phase1-repository-builds"
	if err := policy.Validate(); err != nil {
		t.Fatalf("safe multi-segment signed branch was rejected: %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","freshness":"require-current","unknown":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReleasePolicy(path); err == nil {
		t.Fatal("unknown release-policy field was accepted")
	}
}

func TestConvergenceIntentPinsFinalSignedBundleAndExcludesNewerRace(t *testing.T) {
	digest := strings.Repeat("a", 64)
	intent := convergenceIntent{
		Schema: convergenceIntentSchema, SelectedTag: "appliance-dev-v1.2.3",
		ManifestSHA256: digest, TargetImage: "1.2.3", ReleaseBranch: "dev",
		Bridges: []string{"appliance-dev-v1.2.2"}, UpdatedAt: "2026-08-16T00:00:00Z",
	}
	options := []SourceOptions{
		{ReleaseTag: "appliance-dev-v1.2.4"},
		{ReleaseTag: "appliance-dev-v1.2.3"},
		{ReleaseTag: "appliance-dev-v1.2.2"},
	}
	pinned, err := pinConvergenceCandidates(options, intent)
	if err != nil {
		t.Fatal(err)
	}
	if len(pinned) != 2 || pinned[0].ReleaseTag != intent.SelectedTag || pinned[0].ExpectedManifestSHA256 != digest {
		t.Fatalf("unexpected pinned candidates: %+v", pinned)
	}
	path := filepath.Join(t.TempDir(), "convergence-intent.json")
	if err := writeConvergenceIntent(path, intent); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadConvergenceIntent(path)
	if err != nil || !reflect.DeepEqual(loaded, intent) {
		t.Fatalf("durable convergence intent did not round trip: loaded=%+v err=%v", loaded, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("convergence intent is not protected: %v", err)
	}
}

func TestVerifyExactInstalledBindsTagDigestSignatureAndRunningReleaseSet(t *testing.T) {
	dir := t.TempDir()
	current := testApplianceManifest("0.6.0-dev.26", baselineCommit)
	currentRaw, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	currentPath := filepath.Join(dir, "appliance-release")
	if err := os.WriteFile(currentPath, currentRaw, 0444); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyID, err := publicKeyID(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	bundle := exactBundleManifest{
		Schema: "youeye.appliance.manifest.v1", ImageVersion: current.ImageVersion,
		SourceCommit: current.SourceCommit, Trust: Trust{Class: TrustClassDev, KeyID: keyID}, ReleaseSet: *current.ReleaseSet,
	}
	bundleRaw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(dir, "appliance-manifest.json")
	signaturePath := bundlePath + ".sig"
	trustPath := filepath.Join(dir, "trust.pub")
	if err := os.WriteFile(bundlePath, bundleRaw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, ed25519.Sign(privateKey, bundleRaw), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(trustPath, []byte(base64.StdEncoding.EncodeToString(publicKey)), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bundleRaw)
	policy := ReleasePolicy{
		Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", Freshness: "require-current",
		ExactTag: "appliance-dev-v" + current.ImageVersion, ManifestSHA256: hex.EncodeToString(digest[:]),
	}
	result, err := VerifyExactInstalled(policy, currentPath, bundlePath, signaturePath, trustPath)
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "exact-media-current" || result.TargetImage != current.ImageVersion {
		t.Fatalf("unexpected exact convergence: %+v", result)
	}
	policy.ManifestSHA256 = strings.Repeat("0", 64)
	if _, err := VerifyExactInstalled(policy, currentPath, bundlePath, signaturePath, trustPath); err == nil {
		t.Fatal("wrong Exact appliance-manifest digest was accepted")
	}
}
