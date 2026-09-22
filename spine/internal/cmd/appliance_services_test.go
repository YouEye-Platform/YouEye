package cmd

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func TestBindServicesKeepsSealedImageAndSpine(t *testing.T) {
	original := appliance.Manifest{ImageVersion: "1.0.0", SourceCommit: strings.Repeat("a", 40), ReleaseSet: &appliance.ReleaseSet{Source: "https://github.com/YouEye-Platform/YouEye", Branch: "main", Spine: appliance.ComponentRelease{Version: "1.0.0", ArtifactSHA256: strings.Repeat("b", 64)}, ControlPanel: appliance.ComponentRelease{Version: "1.0.0"}}}
	selected := releasecache.InstallationSet{Source: original.ReleaseSet.Source, Appliance: releasecache.InstallationImage{Version: original.ImageVersion, SourceCommit: original.SourceCommit, SpineSHA256: original.ReleaseSet.Spine.ArtifactSHA256}, ControlPanel: releasecache.InstallationComponent{Version: "1.0.1", Tag: "cp-v1.0.1", SourceCommit: strings.Repeat("c", 40), ArtifactSHA256: strings.Repeat("d", 64)}}
	deployment, err := bindInstallationServices(original, selected)
	if err != nil {
		t.Fatal(err)
	}
	if original.ReleaseSet.ControlPanel.Version != "1.0.0" || deployment.ReleaseSet.ControlPanel.Version != "1.0.1" || deployment.ReleaseSet.Spine != original.ReleaseSet.Spine || deployment.SourceCommit != original.SourceCommit {
		t.Fatal("sealed image mutated")
	}
	for name, mutate := range map[string]func(*releasecache.InstallationSet){
		"image":  func(s *releasecache.InstallationSet) { s.Appliance.Version = "2.0.0" },
		"commit": func(s *releasecache.InstallationSet) { s.Appliance.SourceCommit = strings.Repeat("e", 40) },
		"spine":  func(s *releasecache.InstallationSet) { s.Appliance.SpineSHA256 = strings.Repeat("f", 64) },
		"source": func(s *releasecache.InstallationSet) { s.Source = "https://github.com/other/YouEye" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := selected
			mutate(&bad)
			if _, err := bindInstallationServices(original, bad); err == nil {
				t.Fatal("incompatible service set accepted")
			}
		})
	}
}
func TestPinnedServicesProtection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "installation.json")
	if err := writePinnedServices(path, []byte("signed snapshot")); err != nil {
		t.Fatal(err)
	}
	raw, err := readPinnedServices(path)
	if err != nil || string(raw) != "signed snapshot" {
		t.Fatalf("%s %v", raw, err)
	}
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := readPinnedServices(path); err == nil {
		t.Fatal("writable state accepted")
	}
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readPinnedServices(link); err == nil {
		t.Fatal("symlink state accepted")
	}
}

func TestFirstDeploymentFreezesSignedServicesAndResumesWithoutNetwork(t *testing.T) {
	root := t.TempDir()
	oldPolicy, oldSelection, oldTrust, oldChannels := deploymentPolicyPath, deploymentSelectionPath, deploymentDistributionPolicy, channels.ConfigPath
	t.Cleanup(func() {
		deploymentPolicyPath, deploymentSelectionPath, deploymentDistributionPolicy, channels.ConfigPath = oldPolicy, oldSelection, oldTrust, oldChannels
	})
	deploymentPolicyPath = filepath.Join(root, "policy.json")
	deploymentSelectionPath = filepath.Join(root, "installation.json")
	channels.ConfigPath = filepath.Join(root, "youeye.yaml")
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	trust := releasecache.DistributionPolicy{Schema: "youeye.distribution-policy.v1", Origin: "https://releases.example.test", Keys: map[string]string{"stable": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}}
	deploymentDistributionPolicy = func() releasecache.DistributionPolicy { return trust }
	manifest := appliance.Manifest{ImageVersion: "1.0.0", SourceCommit: strings.Repeat("a", 40), ReleaseSet: &appliance.ReleaseSet{Source: "https://github.com/YouEye-Platform/YouEye", Branch: "main", Spine: appliance.ComponentRelease{ArtifactSHA256: strings.Repeat("b", 64)}}}
	component := releasecache.InstallationComponent{Version: "1.0.1", SourceCommit: strings.Repeat("c", 40), ArtifactSHA256: strings.Repeat("d", 64)}
	cp, ui := component, component
	cp.Tag = "cp-v1.0.1"
	ui.Tag = "ui-v1.0.1"
	selection := releasecache.InstallationSet{Schema: "youeye.installation.v1", Source: manifest.ReleaseSet.Source, Appliance: releasecache.InstallationImage{Version: manifest.ImageVersion, Tag: "appliance-v1.0.0", SourceCommit: manifest.SourceCommit, ManifestSHA256: strings.Repeat("e", 64), SpineSHA256: manifest.ReleaseSet.Spine.ArtifactSHA256}, ControlPanel: cp, UI: ui}
	now := time.Now().UTC()
	catalog := releasecache.DistributionCatalog{Schema: "youeye.distribution.v1", Channel: "stable", Sequence: 1, IssuedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour), Repositories: map[string]releasecache.DistributionRepository{}, Installation: &selection}
	payload, _ := json.Marshal(catalog)
	envelope, _ := json.Marshal(releasecache.DistributionEnvelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
	digest := fmt.Sprintf("%x", sha256.Sum256(envelope))
	cache := filepath.Join(root, "cache")
	if err = os.MkdirAll(filepath.Join(cache, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YOUEYE_RELEASE_CACHE", cache)
	index, _ := json.Marshal(map[string]any{"schema": "youeye.release-cache.v1", "objects": map[string]any{trust.Origin + "/v1/stable.json": map[string]any{"sha256": digest, "bytes": len(envelope)}}})
	for path, raw := range map[string][]byte{filepath.Join(cache, "index.json"): index, filepath.Join(cache, "objects", digest): envelope, deploymentPolicyPath: []byte(`{"schema":"youeye.release-policy.v1","provider":"github","mode":"track","track":"stable","freshness":"require-current"}`)} {
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	selected, err := selectApplianceServices(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if selected.ReleaseSet.ControlPanel.Tag != cp.Tag {
		t.Fatal("current service not selected")
	}
	// Prove the retry does not fetch a different catalog or need the cache.
	if err = os.RemoveAll(cache); err != nil {
		t.Fatal(err)
	}
	selected, err = selectApplianceServices(manifest)
	if err != nil || selected.ReleaseSet.UI.Tag != ui.Tag {
		t.Fatalf("resume: %v", err)
	}
	health, err := pinnedDeploymentManifest(manifest)
	if err != nil || health.ReleaseSet.ControlPanel.Tag != cp.Tag {
		t.Fatalf("health: %v", err)
	}
	config, err := channels.Load()
	if err != nil || config.Control.Tag != cp.Tag || config.UI.Tag != ui.Tag {
		t.Fatalf("channels: %+v %v", config, err)
	}
}
