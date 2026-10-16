package systemupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func TestCoreReusedPublicMemberResolvesItsOriginalScopedKey(t *testing.T) {
	stable, _, _ := ed25519.GenerateKey(rand.Reader)
	beta, _, _ := ed25519.GenerateKey(rand.Reader)
	pemKey := func(key ed25519.PublicKey) string {
		der, _ := x509.MarshalPKIXPublicKey(key)
		return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	}
	old := publicReleaseTrustJSON
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": pemKey(stable), "beta": pemKey(beta)}})
	t.Cleanup(func() { publicReleaseTrustJSON = old })
	member := releasecache.CoreMember{Source: releasecache.OfficialRepository, Branch: "main", BuildVersion: "0.5.37", Role: "ui"}
	got, err := CoreMemberKey(member, "beta", "unused")
	if err != nil || !bytes.Equal(got, stable) {
		t.Fatal("assembly replaced original Stable member key", err)
	}
	member.Branch, member.BuildVersion = "beta", "0.5.38-beta.1"
	got, err = CoreMemberKey(member, "stable", "unused")
	if err != nil || !bytes.Equal(got, beta) {
		t.Fatal("assembly replaced original Beta member key", err)
	}
	member.Branch = "dev"
	if _, err = CoreMemberKey(member, "stable", "unused"); err == nil {
		t.Fatal("public member crossed private authority")
	}
}

func TestCoreAlphaAuthorityIsIndependentOfPublicImageAndRevocationWins(t *testing.T) {
	alpha, alphaPrivate, _ := ed25519.GenerateKey(rand.Reader)
	stable, stablePrivate, _ := ed25519.GenerateKey(rand.Reader)
	pemKey := func(key ed25519.PublicKey) []byte {
		der, _ := x509.MarshalPKIXPublicKey(key)
		return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	}
	previous, previousLookup, previousPublic := coreDevelopmentTrustPEM, coreTrustLookup, publicReleaseTrustJSON
	t.Cleanup(func() {
		coreDevelopmentTrustPEM, coreTrustLookup, publicReleaseTrustJSON = previous, previousLookup, previousPublic
	})
	coreDevelopmentTrustPEM = pemKey(alpha)
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": string(pemKey(stable))}})
	policy := updatetrust.Policy{Schema: updatetrust.Schema}
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		return policy.Lookup(source, branch, scope)
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Source, r.Branch, r.Channel, r.Version, r.Tag = "https://forge.example/team/YouEye", "main", "alpha", "0.5.41-alpha.1", "youeye-v0.5.41-alpha.1"
	der, _ := x509.MarshalPKIXPublicKey(alpha)
	r.SignerSHA256 = fmt.Sprintf("%x", sha256.Sum256(der))
	raw, _ = json.Marshal(r)
	if _, _, err = VerifyCoreSelection(raw, ed25519.Sign(alphaPrivate, raw), CoreDevelopmentTrustPath); err != nil {
		t.Fatal("public-built image cannot accept provisioned Alpha authority", err)
	}
	if _, _, err = VerifyCoreSelection(raw, ed25519.Sign(stablePrivate, raw), CoreDevelopmentTrustPath); err == nil {
		t.Fatal("factory image signer replaced Alpha authority")
	}
	member := releasecache.CoreMember{Source: releasecache.OfficialRepository, Branch: "main", BuildVersion: "0.5.40", Role: "appliance"}
	key, err := CoreMemberKey(member, "alpha", CoreDevelopmentTrustPath)
	if err != nil || !bytes.Equal(key, stable) {
		t.Fatal("Alpha label changed original public member authority", err)
	}
	policy.Grants = []updatetrust.Grant{{Publisher: "Owner", Repository: r.Source, Branch: "main", Scope: "appliance", PublicKey: string(pemKey(alpha)), Revoked: true}}
	if _, _, err = VerifyCoreSelection(raw, ed25519.Sign(alphaPrivate, raw), CoreDevelopmentTrustPath); err == nil {
		t.Fatal("revocation fell back to compiled Alpha authority")
	}
}

func TestCoreDevelopmentAuthorityMatchesInstallerAndComponentProvisioning(t *testing.T) {
	for _, path := range []string{"../../../installer/internal/installer/appliance-development.pub", "../releases/release-development.pub"} {
		raw, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(bytes.TrimSpace(raw), bytes.TrimSpace(coreDevelopmentTrustPEM)) {
			t.Fatalf("development authorities drifted at %s: %v", path, err)
		}
	}
}

func TestCoreSelectionRechecksRoleRevocationAndExactPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	r.SignerSHA256 = fmt.Sprintf("%x", sha256.Sum256(der))
	source := "https://forge.example/owner/YouEye"
	r.Source, r.Branch, r.Channel, r.Version, r.Tag = source, "Team/Fix", "feature", "0.5.38-worker-abcd.1", "youeye-v0.5.38-worker-abcd.1"
	// Retained members may come from a different source under development
	// assembly policy. Every member must still resolve its own authority.
	p := updatetrust.Policy{Schema: updatetrust.Schema, Grants: []updatetrust.Grant{{Publisher: "Fixture", Repository: source, Branch: r.Branch, Scope: "appliance", PublicKey: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}}}
	previous := coreTrustLookup
	coreTrustLookup = p.Lookup
	t.Cleanup(func() { coreTrustLookup = previous })
	raw, _ = json.Marshal(r)
	signature := ed25519.Sign(private, raw)
	root := t.TempDir()
	for name, data := range map[string][]byte{"core-release.json": raw, "core-release.json.sig": signature} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	selection, digest, err := ReadCoreSelection(root, "unused-baked-key")
	if err != nil {
		t.Fatal(err)
	}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "custom", ReleasesAPI: "https://forge.example/api/v1/repos/owner/YouEye/releases", Mode: "track", Track: "branch", Branch: "Team/Fix", CoreManifestSHA256: digest, Freshness: "require-current", ServiceSelection: "current"}
	if err := ValidateCorePolicy(policy, selection, digest); err != nil {
		t.Fatal(err)
	}
	policy.Branch = "team/fix"
	if err := ValidateCorePolicy(policy, selection, digest); err == nil {
		t.Fatal("case-folded policy selected another branch")
	}
	if _, err := CoreRoleKey(source, r.Branch, r.Channel, "cp", "missing-baked-key"); err == nil {
		t.Fatal("assembly enrollment granted CP authority")
	}
	p.Grants[0].Revoked = true
	if _, _, err := ReadCoreSelection(root, "unused-baked-key"); err == nil {
		t.Fatal("revoked selected assembly was accepted")
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
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	keyID := fmt.Sprintf("%x", sha256.Sum256(der))
	original := r.Source
	r.Source, r.SignerSHA256 = "https://forge.example/owner/YouEye", keyID
	for i := range r.Members {
		m := &r.Members[i]
		m.Source, m.KeyID = r.Source, keyID
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
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
	bundleSig := ed25519.Sign(private, bundle)
	for i := range r.Members {
		if r.Members[i].Role == "appliance" {
			m := &r.Members[i]
			m.Artifact.SHA256, m.Artifact.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(bundle)), int64(len(bundle))
			m.DocumentSignature.SHA256, m.DocumentSignature.SizeBytes = fmt.Sprintf("%x", sha256.Sum256(bundleSig)), int64(len(bundleSig))
		}
	}
	raw, _ = json.Marshal(r)
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	imageRaw, _ := json.Marshal(image)
	for name, bytes := range map[string][]byte{"core-release.json": raw, "core-release.json.sig": ed25519.Sign(private, raw), "image.json": imageRaw, "bundle.json": bundle, "bundle.sig": bundleSig, "key.pub": pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})} {
		if err := os.WriteFile(filepath.Join(root, name), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "custom", ReleasesAPI: "https://forge.example/api/v1/repos/owner/YouEye/releases", Mode: "exact", ExactTag: r.Tag, ManifestSHA256: fmt.Sprintf("%x", sha256.Sum256(bundle)), CoreManifestSHA256: digest, Freshness: "require-current"}
	check := func() (ConvergenceResult, error) {
		return VerifyCoreInstalledMedia(policy, root, filepath.Join(root, "image.json"), filepath.Join(root, "bundle.json"), filepath.Join(root, "bundle.sig"), filepath.Join(root, "key.pub"))
	}
	result, err := check()
	if err != nil || result.SelectedTag != "youeye-v0.5.38" || result.CurrentImage != "0.5.37" {
		t.Fatal(result, err)
	}
	if err := os.WriteFile(filepath.Join(root, "bundle.sig"), make([]byte, 64), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := check(); err == nil {
		t.Fatal("tampered host signature accepted")
	}
}
