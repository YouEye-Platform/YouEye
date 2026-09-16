package installer

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestPublicSignedDownloadVerifiesLockBeforeISO(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, _ := os.ReadFile(bundle.manifestPath)
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Trust.Class = "stable"
	manifest.ImageVersion = "0.5.8"
	manifest.ReleaseSet.Source = "https://github.com/YouEye-Platform/YouEye"
	manifest.ReleaseSet.Branch = "main"
	manifest.ReleaseSet.Spine.SourceCommit = manifest.SourceCommit
	manifest.ReleaseSet.ControlPanel.SourceCommit = manifest.SourceCommit
	manifest.ReleaseSet.UI.SourceCommit = manifest.SourceCommit
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	anchor := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	original := publicReleaseTrustJSON
	t.Cleanup(func() { publicReleaseTrustJSON = original })
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": string(anchor)}})
	marshal := func(v any) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	hash := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	files := map[string][]byte{}
	for _, name := range applianceSignedAssetNames {
		files[name] = []byte("fixture " + name)
	}
	files["appliance-development.pub"] = anchor
	files[applianceManifestFilename] = marshal(manifest)
	files[applianceManifestSigName] = ed25519.Sign(private, files[applianceManifestFilename])
	files[applianceReleaseLockName] = marshal(map[string]any{"schema": "youeye.appliance.release-lock.v1", "image": map[string]string{"version": manifest.ImageVersion, "release_source": manifest.ReleaseSet.Source, "release_branch": "main", "debian_snapshot": "20260805T142647Z"}, "components": map[string]applianceManifestComponent{"spine": manifest.ReleaseSet.Spine, "control_panel": manifest.ReleaseSet.ControlPanel, "ui": manifest.ReleaseSet.UI}, "market": map[string]string{"source": "https://github.com/YouEye-Platform/Market", "branch": "main", "commit": strings.Repeat("b", 40)}})
	files["provenance.json"] = marshal(map[string]any{"schema": "youeye.appliance.provenance.v2", "source_commit": manifest.SourceCommit, "source": map[string]string{"commit": manifest.SourceCommit, "branch": "main"}, "release_set": manifest.ReleaseSet, "resolved_lock_sha256": hash(files[applianceReleaseLockName]), "debian_snapshot": "20260805T142647Z", "market": map[string]string{"source": "https://github.com/YouEye-Platform/Market", "branch": "main", "source_commit": strings.Repeat("b", 40)}})
	var sums strings.Builder
	for _, name := range applianceSignedAssetNames {
		fmt.Fprintf(&sums, "%s  %s\n", hash(files[name]), name)
	}
	files[applianceChecksumsFilename] = []byte(sums.String())
	files[applianceChecksumsSigName] = ed25519.Sign(private, files[applianceChecksumsFilename])
	var mu sync.Mutex
	var isoRequests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := path.Base(r.URL.Path)
		if name == applianceISOFilename {
			isoRequests.Add(1)
		}
		mu.Lock()
		b, ok := files[name]
		mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(b)
	}))
	defer server.Close()
	release := applianceRelease{TagName: "appliance-v0.5.8", sourceProvider: "github"}
	for name := range files {
		release.Assets = append(release.Assets, applianceReleaseAsset{Name: name, BrowserDownloadURL: server.URL + "/releases/download/" + release.TagName + "/" + name})
	}
	if _, err := downloadVerifiedApplianceRelease(context.Background(), server.Client(), release, t.TempDir(), ""); err != nil {
		t.Fatal(err)
	}
	if isoRequests.Load() != 1 {
		t.Fatal("valid release did not fetch ISO")
	}
	mu.Lock()
	files[applianceReleaseLockName] = append(files[applianceReleaseLockName], '\n')
	mu.Unlock()
	if _, err := downloadVerifiedApplianceRelease(context.Background(), server.Client(), release, t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "lock") {
		t.Fatalf("altered lock accepted: %v", err)
	}
	if isoRequests.Load() != 1 {
		t.Fatal("invalid lock downloaded ISO")
	}
}

func TestDetachedLockMatchesAuthenticatedManifestAndProvenance(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, _ := os.ReadFile(bundle.manifestPath)
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Trust.Class = "stable"
	manifest.ReleaseSet.Source = "https://github.com/YouEye-Platform/YouEye"
	manifest.ReleaseSet.Branch = "main"
	manifest.ReleaseSet.Spine.SourceCommit = manifest.SourceCommit
	manifest.ReleaseSet.ControlPanel.SourceCommit = manifest.SourceCommit
	manifest.ReleaseSet.UI.SourceCommit = manifest.SourceCommit
	marshal := func(v any) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, scenario := range []string{"valid", "altered-lock", "wrong-digest", "wrong-source", "wrong-version", "wrong-component", "extra-component", "wrong-market", "wrong-provenance-commit"} {
		t.Run(scenario, func(t *testing.T) {
			image := map[string]string{"version": manifest.ImageVersion, "release_source": manifest.ReleaseSet.Source, "release_branch": "main", "debian_snapshot": "20260805T142647Z"}
			components := map[string]applianceManifestComponent{"spine": manifest.ReleaseSet.Spine, "control_panel": manifest.ReleaseSet.ControlPanel, "ui": manifest.ReleaseSet.UI}
			market := map[string]string{"source": "https://github.com/YouEye-Platform/Market", "branch": "main", "commit": strings.Repeat("b", 40)}
			if scenario == "wrong-source" {
				image["release_source"] = "https://wrong.example/YouEye"
			}
			if scenario == "wrong-version" {
				image["version"] = "9.9.9"
			}
			if scenario == "wrong-component" {
				c := components["spine"]
				c.SourceCommit = strings.Repeat("c", 40)
				components["spine"] = c
			}
			if scenario == "extra-component" {
				components["unexpected"] = components["spine"]
			}
			if scenario == "wrong-market" {
				market["source"] = "https://wrong.example/Market"
			}
			lock := marshal(map[string]any{"schema": "youeye.appliance.release-lock.v1", "image": image, "components": components, "market": market})
			hash := sha256.Sum256(lock)
			digest := hex.EncodeToString(hash[:])
			if scenario == "wrong-digest" {
				digest = strings.Repeat("0", 64)
			}
			if scenario == "altered-lock" {
				lock = append(lock, '\n')
			}
			commit := manifest.SourceCommit
			if scenario == "wrong-provenance-commit" {
				commit = strings.Repeat("d", 40)
			}
			provenance := marshal(map[string]any{"schema": "youeye.appliance.provenance.v2", "source_commit": commit, "source": map[string]string{"commit": commit, "branch": "main"}, "release_set": manifest.ReleaseSet, "resolved_lock_sha256": digest, "debian_snapshot": image["debian_snapshot"], "market": map[string]string{"source": market["source"], "source_commit": market["commit"], "branch": market["branch"]}})
			err := validateDetachedApplianceLock(provenance, lock, manifest)
			if scenario == "valid" && err != nil {
				t.Fatal(err)
			}
			if scenario != "valid" && err == nil {
				t.Fatal("invalid detached lock accepted")
			}
		})
	}
}

func TestPublicReleaseRequiresExactNineteenAssets(t *testing.T) {
	api, _ := url.Parse("https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	release := applianceRelease{TagName: "appliance-v0.5.8", sourceProvider: "github"}
	for _, name := range append(append([]string{}, applianceSignedAssetNames...), applianceChecksumsFilename, applianceChecksumsSigName, applianceReleaseLockName) {
		release.Assets = append(release.Assets, applianceReleaseAsset{Name: name, BrowserDownloadURL: "https://github.com/YouEye-Platform/YouEye/releases/download/" + release.TagName + "/" + name})
	}
	if err := validateApplianceReleaseAssets("github", api, release); err != nil {
		t.Fatal(err)
	}
	release.Assets = release.Assets[:len(release.Assets)-1]
	if err := validateApplianceReleaseAssets("github", api, release); err == nil {
		t.Fatal("public release without lock accepted")
	}
}
