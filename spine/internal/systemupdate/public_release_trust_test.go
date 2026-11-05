package systemupdate

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestPublicUpdateUsesEmbeddedChannelAnchor(t *testing.T) {
	original := publicReleaseTrustJSON
	t.Cleanup(func() { publicReleaseTrustJSON = original })
	for _, class := range []string{"beta", "stable"} {
		dir := t.TempDir()
		files := map[string][]byte{"system-root.img.zst": []byte("root"), "system-a.efi": []byte("a"), "system-b.efi": []byte("b"), "youeye-system-updater-linux-amd64": []byte("updater")}
		manifest := testUpdateManifest(files)
		manifest.Trust.Class = class
		manifest.ArtifactKind = class
		manifest.ReleaseSet.Branch = "main"
		if class == "beta" {
			manifest.ReleaseSet.Branch = "beta"
		}
		// Component tag identity is independent from public signing-key selection.
		manifest.ReleaseSet.ControlPanel.Tag = "cp-v1.0.0"
		manifest.ReleaseSet.UI.Tag = "ui-v1.0.0"
		if class == "beta" {
			manifest.ReleaseSet.ControlPanel.Tag = "cp-beta-v1.0.0"
			manifest.ReleaseSet.UI.Tag = "ui-beta-v1.0.0"
		}
		path, sig := writeSignedBundle(t, dir, manifest, files)
		key, _ := os.ReadFile(filepath.Join(dir, "trust.key"))
		pub := ed25519.PrivateKey(key).Public()
		der, _ := x509.MarshalPKIXPublicKey(pub)
		anchor := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
		publicReleaseTrustJSON = []byte(`{"schema":"youeye.public-trust.v1","keys":{}}`)
		if _, err := VerifyManifest(path, sig, filepath.Join(dir, "trust.pub")); err == nil {
			t.Fatal("supplied key bypassed missing public policy")
		}
		publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{class: string(anchor)}})
		if _, err := VerifyManifest(path, sig, "absent-development-key"); err != nil {
			t.Fatal(err)
		}
		manifest.ReleaseSet.Branch = "dev"
		if err := manifest.Validate(); err == nil {
			t.Fatal("public trust accepted for dev channel")
		}
	}
}
