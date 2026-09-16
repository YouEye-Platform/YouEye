package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"testing"
)

func TestPublicApplianceUsesEmbeddedChannelAnchor(t *testing.T) {
	original := publicReleaseTrustJSON
	t.Cleanup(func() { publicReleaseTrustJSON = original })
	for _, class := range []string{"beta", "stable"} {
		bundle := writeTestApplianceBundle(t)
		raw, _ := os.ReadFile(bundle.manifestPath)
		manifest, err := parseApplianceBundleManifest(raw)
		if err != nil {
			t.Fatal(err)
		}
		manifest.Trust.Class = class
		manifest.ReleaseSet.Source = "https://github.com/YouEye-Platform/YouEye"
		manifest.ReleaseSet.Branch = "main"
		if class == "beta" {
			manifest.ReleaseSet.Branch = "beta"
		}
		pub, key, _ := ed25519.GenerateKey(rand.Reader)
		der, _ := x509.MarshalPKIXPublicKey(pub)
		anchor := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
		raw, _ = json.Marshal(manifest)
		os.WriteFile(bundle.manifestPath, raw, 0600)
		os.WriteFile(bundle.signaturePath, ed25519.Sign(key, raw), 0600)
		publicReleaseTrustJSON = []byte(`{"schema":"youeye.public-trust.v1","keys":{}}`)
		if _, err = verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath); err == nil {
			t.Fatal("unprovisioned public key accepted")
		}
		publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{class: string(anchor)}})
		// The unrelated caller-supplied development anchor cannot authorize public releases.
		if _, err = verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath); err != nil {
			t.Fatal(err)
		}
		_, wrong, _ := ed25519.GenerateKey(rand.Reader)
		os.WriteFile(bundle.signaturePath, ed25519.Sign(wrong, raw), 0600)
		if _, err = verifyApplianceBundle(bundle.manifestPath, bundle.signaturePath, bundle.trustKeyPath); err == nil {
			t.Fatal("wrong signer accepted")
		}
		manifest.ReleaseSet.Branch = "dev"
		if err = validateApplianceBundleManifest(manifest); err == nil {
			t.Fatal("public key accepted for wrong channel")
		}
	}
}
