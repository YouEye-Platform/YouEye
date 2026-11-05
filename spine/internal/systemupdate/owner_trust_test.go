package systemupdate

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
	"os"
	"path/filepath"
	"testing"
)

func TestCustomSystemSignatureRequiresEnrolledSystemScope(t *testing.T) {
	dir := t.TempDir()
	files := map[string][]byte{"system-root.img.zst": []byte("root"), "system-a.efi": []byte("a"), "system-b.efi": []byte("b"), "youeye-system-updater-linux-amd64": []byte("updater")}
	manifest := testUpdateManifest(files)
	manifest.ReleaseSet.Source = "https://forge.example/alice/YouEye"
	manifest.ReleaseSet.Branch = "dev"
	path, sig := writeSignedBundle(t, dir, manifest, files)
	private, err := os.ReadFile(filepath.Join(dir, "trust.key"))
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(ed25519.PrivateKey(private).Public())
	grant := updatetrust.Grant{Publisher: "Personal", Repository: manifest.ReleaseSet.Source, Branch: "dev", Scope: "appliance", PublicKey: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}
	policy := updatetrust.Policy{Schema: updatetrust.Schema, Grants: []updatetrust.Grant{grant}}
	verified, err := verifyManifestWithOwnerPolicy(path, sig, "missing-official-anchor", policy)
	if err != nil || verified.Publisher != "Personal" {
		t.Fatalf("custom signature refused: %v", err)
	}
	for _, scope := range []string{"app", "ui", "cp", "spine"} {
		policy.Grants[0].Scope = scope
		if _, err := verifyManifestWithOwnerPolicy(path, sig, "missing-official-anchor", policy); err == nil {
			t.Fatal("non-system key authorized system")
		}
	}
	policy.Grants[0] = grant
	policy.Grants[0].Revoked = true
	if _, err := verifyManifestWithOwnerPolicy(path, sig, filepath.Join(dir, "trust.pub"), policy); err == nil {
		t.Fatal("revoked key fell back to installed anchor")
	}
	policy.Grants[0] = grant
	raw, _ := os.ReadFile(sig)
	raw[0] ^= 1
	_ = os.WriteFile(sig, raw, 0600)
	if _, err := verifyManifestWithOwnerPolicy(path, sig, "missing-official-anchor", policy); err == nil {
		t.Fatal("tampered custom signature accepted")
	}
}

func TestOwnerSourceSwitchRequiresExplicitSelection(t *testing.T) {
	current := &appliance.ReleaseSet{Source: "https://forge.example/alice/YouEye", Branch: "dev"}
	policy := updatetrust.Policy{Schema: updatetrust.Schema, Grants: []updatetrust.Grant{{Repository: current.Source, Branch: current.Branch, Scope: "appliance", Revoked: true}}}
	for _, next := range []*appliance.ReleaseSet{{Source: "https://forge.example/official/YouEye", Branch: "dev"}, {Source: current.Source, Branch: "main"}} {
		if validateOwnerSourceChange(policy, current, next, false) == nil {
			t.Fatal("implicit source/channel switch accepted")
		}
		if err := validateOwnerSourceChange(policy, current, next, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateOwnerSourceChange(policy, current, current, false); err != nil {
		t.Fatal(err)
	}
	policy.Grants[0].Scope = "app"
	if err := validateOwnerSourceChange(policy, current, &appliance.ReleaseSet{Source: "another"}, false); err != nil {
		t.Fatal("app grant controlled system source", err)
	}
}
