package releases

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrivateSnapshotUsesSelectedSourceAndProtectedTransport(t *testing.T) {
	pub, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	old := releaseDevelopmentTrust
	releaseDevelopmentTrust = pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	t.Cleanup(func() { releaseDevelopmentTrust = old })
	source := "https://forge.example.test/owner/YouEye"
	tag := "installation-" + strings.Repeat("a", 40)
	s := releasecache.InstallationSet{Schema: "youeye.installation.v1", Source: source, Appliance: releasecache.InstallationImage{Version: "1.0.0.0.1", Tag: "appliance-v1.0.0.0.1", SourceCommit: strings.Repeat("a", 40), ManifestSHA256: strings.Repeat("b", 64), SpineSHA256: strings.Repeat("c", 64)}, ControlPanel: releasecache.InstallationComponent{Version: "1.0.0.0.2", Tag: "cp-v1.0.0.0.2", SourceCommit: strings.Repeat("d", 40), ArtifactSHA256: strings.Repeat("e", 64)}, UI: releasecache.InstallationComponent{Version: "1.0.0.0.1", Tag: "ui-v1.0.0.0.1", SourceCommit: strings.Repeat("a", 40), ArtifactSHA256: strings.Repeat("f", 64)}}
	now := time.Now().UTC()
	payload, err := json.Marshal(releasecache.DistributionCatalog{Schema: "youeye.distribution.v1", Channel: "repository-main", Sequence: 1, IssuedAt: now, ExpiresAt: now.Add(time.Hour), Installation: &s, Repositories: map[string]releasecache.DistributionRepository{}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(releasecache.DistributionEnvelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyPrivateInstallation(raw, "https://other.example.test/owner/YouEye"); err == nil {
		t.Fatal("wrong source accepted")
	}
	oldLookup := installationTrustLookup
	t.Cleanup(func() { installationTrustLookup = oldLookup })
	installationTrustLookup = func(repo, branch, scope string) (*updatetrust.Grant, error) {
		if repo != source || branch != "main" || scope != "appliance" {
			t.Fatal("incorrect enrollment scope")
		}
		return nil, fmt.Errorf("publisher trust revoked")
	}
	if _, err = VerifyPrivateInstallation(raw, source); err == nil {
		t.Fatal("revoked source fell back to embedded trust")
	}
	installationTrustLookup = oldLookup
	root := t.TempDir()
	t.Setenv("YOUEYE_RELEASE_CACHE", root)
	if err = os.Mkdir(filepath.Join(root, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	endpoint := source + "/releases/download/" + tag + "/installation.json"
	rows, err := json.Marshal([]Release{{TagName: "installation-draft", Draft: true, PublishedAt: now.Add(time.Hour)}, {TagName: tag, PublishedAt: now, Assets: []Asset{{Name: "installation.json", BrowserDownloadURL: endpoint}}}})
	if err != nil {
		t.Fatal(err)
	}
	objects := map[string]any{}
	for url, data := range map[string][]byte{endpoint: raw, "https://forge.example.test/api/v1/repos/owner/YouEye/releases?limit=50&page=1": rows} {
		hash := fmt.Sprintf("%x", sha256.Sum256(data))
		if err = os.WriteFile(filepath.Join(root, "objects", hash), data, 0600); err != nil {
			t.Fatal(err)
		}
		objects[url] = map[string]any{"sha256": hash, "bytes": len(data)}
	}
	index, err := json.Marshal(map[string]any{"schema": "youeye.release-cache.v1", "objects": objects})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "index.json"), index, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := PrivateInstallationSnapshot(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Fatal("snapshot identity changed")
	}
}
