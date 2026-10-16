package installer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"github.com/youeye-platform/YouEye/releasecache"
	"os"
	"testing"
)

func TestCoreInstallerKeepsReusedHostAuthoritySeparateFromAssembly(t *testing.T) {
	old := publicReleaseTrustJSON
	t.Cleanup(func() { publicReleaseTrustJSON = old })
	keys := map[string]string{}
	for _, channel := range []string{"stable", "beta"} {
		public, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		der, _ := x509.MarshalPKIXPublicKey(public)
		keys[channel] = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	}
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": keys})
	stable, err := publicReleaseAnchor("stable")
	if err != nil {
		t.Fatal(err)
	}
	core := releasecache.CoreRelease{Channel: "beta", Members: []releasecache.CoreMember{{Role: "appliance", Source: releasecache.OfficialRepository, Branch: "main", BuildVersion: "0.5.37"}}}
	release := applianceRelease{core: &core, sourceProvider: "github"}
	got, err := applianceReleaseAnchor(release)
	if err != nil || !bytes.Equal(got, stable) || applianceReleaseTrustClass(release) != "stable" {
		t.Fatal("reused host received the assembly key", err)
	}
	core.Channel = "alpha"
	release.sourceProvider = "custom"
	got, err = applianceReleaseAnchor(release)
	if err != nil || !bytes.Equal(got, stable) {
		t.Fatal("private wrapper replaced original public member authority", err)
	}
	core.Members[0].Branch = "dev"
	if _, err = applianceReleaseAnchor(release); err == nil {
		t.Fatal("private host accepted in public group")
	}
}

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
