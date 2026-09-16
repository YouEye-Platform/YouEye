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
	"os"
	"path"
	"strings"
	"testing"
	"time"
)

func TestPrivateMainDiscoveryAndSignedDownload(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	raw, err := os.ReadFile(bundle.manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseApplianceBundleManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	anchor := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	old := embeddedApplianceDevelopmentTrust
	embeddedApplianceDevelopmentTrust = anchor
	t.Cleanup(func() { embeddedApplianceDevelopmentTrust = old })
	files := map[string][]byte{}
	tag := "appliance-v0.5.6.0.3"
	var release applianceRelease
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/releases") {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Query().Get("page") == "1" {
				_ = json.NewEncoder(w).Encode([]applianceRelease{release})
			} else {
				_, _ = w.Write([]byte("[]"))
			}
			return
		}
		content, ok := files[path.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(content)
	}))
	defer server.Close()
	source := server.URL + "/owner/YouEye"
	manifest.ImageVersion = "0.5.6.0.3"
	manifest.ReleaseSet.Source = source
	manifest.ReleaseSet.Branch = "main"
	manifest.ReleaseSet.Spine.Tag = "spine-v" + manifest.ReleaseSet.Spine.Version
	manifest.ReleaseSet.ControlPanel.Tag = "cp-v" + manifest.ReleaseSet.ControlPanel.Version
	manifest.ReleaseSet.UI.Tag = "ui-v" + manifest.ReleaseSet.UI.Version
	signSet := func() {
		raw, _ := json.Marshal(manifest)
		for _, name := range applianceSignedAssetNames {
			files[name] = []byte("fixture " + name)
		}
		files["appliance-development.pub"] = anchor
		files[applianceManifestFilename] = raw
		files[applianceManifestSigName] = ed25519.Sign(private, raw)
		var sums strings.Builder
		for _, name := range applianceSignedAssetNames {
			hash := sha256.Sum256(files[name])
			fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(hash[:]), name)
		}
		files[applianceChecksumsFilename] = []byte(sums.String())
		files[applianceChecksumsSigName] = ed25519.Sign(private, files[applianceChecksumsFilename])
	}
	signSet()
	release = applianceRelease{TagName: tag, PublishedAt: time.Now()}
	for name, content := range files {
		release.Assets = append(release.Assets, applianceReleaseAsset{Name: name, Size: int64(len(content)), BrowserDownloadURL: source + "/releases/download/" + tag + "/" + name})
	}
	selected, err := resolveApplianceRelease(context.Background(), server.Client(), "forgejo", server.URL+"/api/v1/repos/owner/YouEye/releases", "stable", "")
	if err != nil {
		t.Fatal(err)
	}
	if !privateForgejoMainRelease(selected) {
		t.Fatal("discovery lost authenticated provider context")
	}
	verified, err := downloadVerifiedApplianceRelease(context.Background(), server.Client(), selected, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if verified.Manifest.ImageVersion != "0.5.6.0.3" {
		t.Fatal("wrong release")
	}
	manifest.ReleaseSet.Source = "https://different.example.test/owner/YouEye"
	signSet()
	for i := range selected.Assets {
		selected.Assets[i].Size = int64(len(files[selected.Assets[i].Name]))
	}
	if _, err = downloadVerifiedApplianceRelease(context.Background(), server.Client(), selected, t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "signed appliance source") {
		t.Fatalf("wrong signed provider accepted: %v", err)
	}
	manifest.ReleaseSet.Source = source
	signSet()
	for i := range selected.Assets {
		selected.Assets[i].Size = int64(len(files[selected.Assets[i].Name]))
	}
	files[applianceChecksumsSigName] = make([]byte, ed25519.SignatureSize)
	if _, err = downloadVerifiedApplianceRelease(context.Background(), server.Client(), selected, t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("bad signature accepted: %v", err)
	}
}
