package installer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func installTestSpineMetadata(r *releasecache.CoreRelease, private ed25519.PrivateKey, paired bool, objects map[string][]byte) {
	for i := range r.Members {
		m := &r.Members[i]
		if m.Role != "spine" {
			continue
		}
		p := map[string]string{"schema": "youeye.release.provenance.v1", "source_commit": m.SourceCommit}
		if paired {
			p["core_metadata"] = "paired-v2"
		}
		provenance, _ := json.Marshal(p)
		m.Provenance.SHA256, m.Provenance.SizeBytes = coreManifestDigest(provenance), int64(len(provenance))
		checksums := []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
		signature := ed25519.Sign(private, checksums)
		m.Checksums.SHA256, m.Checksums.SizeBytes = coreManifestDigest(checksums), int64(len(checksums))
		m.Signature.SHA256, m.Signature.SizeBytes = coreManifestDigest(signature), int64(len(signature))
		for _, part := range []struct {
			b   releasecache.CoreBlob
			raw []byte
		}{{m.Checksums, checksums}, {m.Signature, signature}, {m.Provenance, provenance}} {
			u, _ := url.Parse(part.b.URL)
			objects[u.Path] = part.raw
		}
	}
}

type installerMetadataFixture struct {
	core           releasecache.CoreRelease
	private        ed25519.PrivateKey
	server         *httptest.Server
	objects        map[string][]byte
	requests       []string
	raw, signature []byte
}

func newInstallerMetadataFixture(t *testing.T, paired bool) *installerMetadataFixture {
	t.Helper()
	f := &installerMetadataFixture{private: ed25519.NewKeyFromSeed(bytes.Repeat([]byte{37}, 32)), objects: map[string][]byte{}}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r.URL.Path)
		if raw, ok := f.objects[r.URL.Path]; ok {
			w.Write(raw)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.server.Close)
	der, _ := x509.MarshalPKIXPublicKey(f.private.Public())
	digest := sha256.Sum256(der)
	prior := embeddedApplianceDevelopmentTrust
	embeddedApplianceDevelopmentTrust = pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	t.Cleanup(func() { embeddedApplianceDevelopmentTrust = prior })
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &f.core); err != nil {
		t.Fatal(err)
	}
	f.core.Source = f.server.URL + "/owner/YouEye"
	f.core.SignerSHA256 = hex.EncodeToString(digest[:])
	for i := range f.core.Members {
		m := &f.core.Members[i]
		m.Source = f.core.Source
		m.KeyID = f.core.SignerSHA256
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = m.Source + "/releases/download/" + m.Tag + "/" + m.Role + "-" + b.Name
			}
		}
	}
	var host releasecache.CoreMember
	for _, m := range f.core.Members {
		if m.Role == "appliance" {
			host = m
		}
	}
	for i := range f.core.Members {
		if f.core.Members[i].Role == "media" {
			f.core.Members[i].Checksums = host.Checksums
		}
	}
	installTestSpineMetadata(&f.core, f.private, paired, f.objects)
	f.freeze(t, paired)
	return f
}

func (f *installerMetadataFixture) freeze(t *testing.T, paired bool) {
	t.Helper()
	var err error
	f.raw, err = json.MarshalIndent(f.core, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	f.signature = ed25519.Sign(f.private, f.raw)
	base := "/owner/YouEye/releases/download/" + f.core.Tag + "/"
	f.objects[base+"core-release.json"] = f.raw
	f.objects[base+"core-release.json.sig"] = f.signature
	if paired {
		canonical, err := releasecache.EncodeCoreMetadataV2(f.core)
		if err != nil {
			t.Fatal(err)
		}
		pair, err := releasecache.EncodeCoreMetadataPair(f.raw, canonical)
		if err != nil {
			t.Fatal(err)
		}
		for i, raw := range [][]byte{canonical, ed25519.Sign(f.private, canonical), pair, ed25519.Sign(f.private, pair)} {
			f.objects[base+releasecache.CoreMetadataAssetNames[i]] = raw
		}
	}
}

func (f *installerMetadataFixture) release() applianceRelease {
	r := applianceRelease{TagName: f.core.Tag}
	for _, name := range []string{"core-release.json", "core-release.json.sig"} {
		raw := f.objects["/owner/YouEye/releases/download/"+f.core.Tag+"/"+name]
		r.Assets = append(r.Assets, applianceReleaseAsset{Name: name, BrowserDownloadURL: f.core.Source + "/releases/download/" + f.core.Tag + "/" + name, Size: int64(len(raw))})
	}
	return r
}

func (f *installerMetadataFixture) answer() applianceAnswer {
	return applianceAnswer{Schema: applianceAnswerCoreSchema, Operation: "erase-install", TransactionID: strings.Repeat("a", 32), TargetSerial: "TARGET", EraseConfirmed: true, Network: applianceAnswerNetwork{Mode: "dhcp"}, Development: defaultDevelopmentAccessPolicy(), ReleasePolicy: applianceReleasePolicy{Schema: releasePolicySchema, Provider: "custom", ReleasesAPI: f.server.URL + "/api/v1/repos/owner/YouEye/releases", Mode: "exact", ExactTag: f.core.Tag, ManifestSHA256: strings.Repeat("b", 64), CoreManifestSHA256: coreManifestDigest(f.raw), Freshness: "require-current"}, CoreRelease: &coreAnswerSelection{ManifestBase64: base64.StdEncoding.EncodeToString(f.raw), SignatureBase64: base64.StdEncoding.EncodeToString(f.signature), ManifestSHA256: coreManifestDigest(f.raw)}}
}

func (f *installerMetadataFixture) bundle() verifiedApplianceBundle {
	var host, spine releasecache.CoreMember
	for _, m := range f.core.Members {
		if m.Role == "appliance" {
			host = m
		}
		if m.Role == "spine" {
			spine = m
		}
	}
	return verifiedApplianceBundle{ManifestSHA256: host.Artifact.SHA256, Manifest: applianceBundleManifest{ImageVersion: host.BuildVersion, SourceCommit: host.SourceCommit, ReleaseSet: applianceManifestReleases{Source: host.Source, Branch: host.Branch, Spine: applianceManifestComponent{Version: spine.BuildVersion, SourceCommit: spine.SourceCommit, ArtifactSHA256: spine.Artifact.SHA256}}}}
}

func TestInstallerMetadataDiscoveryRequiresAuthenticatedPairBeforePayload(t *testing.T) {
	for _, kind := range []string{"paired", "legacy", "stripped", "partial", "provenance", "wrong-role", "bad-pair"} {
		t.Run(kind, func(t *testing.T) {
			paired := kind != "legacy"
			f := newInstallerMetadataFixture(t, paired)
			base := "/owner/YouEye/releases/download/" + f.core.Tag + "/"
			switch kind {
			case "stripped":
				for _, name := range releasecache.CoreMetadataAssetNames {
					delete(f.objects, base+name)
				}
			case "partial":
				delete(f.objects, base+releasecache.CoreMetadataAssetNames[3])
			case "bad-pair":
				f.objects[base+releasecache.CoreMetadataAssetNames[3]][0] ^= 1
			case "wrong-role":
				f.core.Members[len(f.core.Members)-1].KeyID = strings.Repeat("f", 64)
				f.freeze(t, true)
			case "provenance":
				for _, m := range f.core.Members {
					if m.Role == "spine" {
						u, _ := url.Parse(m.Provenance.URL)
						f.objects[u.Path] = []byte(`{"core_metadata":""}`)
					}
				}
			}
			api, _ := url.Parse(f.server.URL + "/api/v1/repos/owner/YouEye/releases")
			selected, _, err := resolveCoreApplianceRelease(t.Context(), f.server.Client(), "custom", api, []applianceRelease{f.release()}, "exact", f.core.Tag)
			if kind != "paired" && kind != "legacy" {
				if err == nil {
					t.Fatal("unsafe metadata accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if selected.coreSHA256 != coreManifestDigest(f.raw) || !bytes.Equal(selected.coreRaw, f.raw) || len(selected.coreMetadataProof) == 0 {
				t.Fatal("original selection or proof lost")
			}
			if err = verifyInstallerCoreProof(f.raw, f.signature, selected.coreMetadataProof); err != nil {
				t.Fatal(err)
			}
			for _, path := range f.requests {
				for _, m := range f.core.Members {
					u, _ := url.Parse(m.Artifact.URL)
					if path == u.Path {
						t.Fatal("binary fetched while checking metadata")
					}
				}
			}
			// An in-memory release without its authenticated proof cannot start even
			// cache directory creation or artifact retrieval.
			selected.coreMetadataProof = nil
			cache := filepath.Join(t.TempDir(), "payload")
			if _, err = downloadVerifiedApplianceRelease(t.Context(), f.server.Client(), selected, cache, ""); err == nil {
				t.Fatal("download accepted absent proof")
			}
			if _, err = os.Stat(cache); !os.IsNotExist(err) {
				t.Fatal("payload cache created before proof")
			}
		})
	}
}

func TestInstallerFrozenAnswerProofSidecarAndOfflineResume(t *testing.T) {
	f := newInstallerMetadataFixture(t, true)
	answer := f.answer()
	dir := t.TempDir()
	path := filepath.Join(dir, "answer.json")
	// An actual frozen portable cache, not a regenerated answer elsewhere.
	cacheRoot := filepath.Join(dir, "release-cache")
	index, _ := json.Marshal(releasecache.Index{Schema: "youeye.release-cache.v1", Objects: map[string]releasecache.Object{}})
	if err := os.MkdirAll(cacheRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheRoot, "index.json"), index, 0400); err != nil {
		t.Fatal(err)
	}
	answer.ReleaseCacheSHA256 = coreManifestDigest(index)
	if err := writeApplianceAnswerFile(path, answer); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	input, err := loadApplianceInstallInput(installConfig{ApplianceAnswerPath: path})
	if err != nil {
		t.Fatal(err)
	}
	// A supplied cache binding is retained even though its old answer has no
	// metadata field. Never regenerate the answer in a different directory.
	prepared, err := prepareCoreInstallInput(t.Context(), input, f.bundle(), f.server.Client(), true)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if prepared.AnswerPath != path || prepared.ReleaseCacheSHA256 != input.ReleaseCacheSHA256 || !bytes.Equal(original, after) || len(prepared.CoreRelease.MetadataProof) != 0 || len(prepared.CoreMetadataProof) == 0 {
		t.Fatal("frozen answer/cache binding changed or proof missing")
	}
	indexAfter, _ := os.ReadFile(filepath.Join(cacheRoot, "index.json"))
	if !bytes.Equal(index, indexAfter) {
		t.Fatal("frozen cache changed")
	}
	sidecar, err := writeCoreMetadataSidecar(prepared.CoreMetadataProof)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(sidecar)
	info, _ := os.Stat(sidecar)
	if info.Mode().Perm() != 0600 {
		t.Fatal("proof sidecar not protected")
	}
	retained, _ := json.Marshal(map[string]any{"transaction_id": answer.TransactionID, "target_serial": "TARGET", "manifest_sha256": f.bundle().ManifestSHA256, "release_policy": answer.ReleasePolicy, "core_release": answer.CoreRelease, "core_metadata_proof": json.RawMessage(prepared.CoreMetadataProof)})
	resume := input
	resume.Operation = "resume"
	restored, err := restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resume, f.bundle().ManifestSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if restored.AnswerPath != path {
		t.Fatal("resume moved frozen answer")
	}
	if _, err = prepareCoreInstallInput(t.Context(), restored, f.bundle(), nil, true); err != nil {
		t.Fatal("offline resume did not retain proof", err)
	}
	var proof releasecache.CoreMetadataProof
	json.Unmarshal(prepared.CoreMetadataProof, &proof)
	proof.SpineProvenance[0] ^= 1
	bad, _ := json.Marshal(proof)
	restored.CoreMetadataProof = bad
	if _, err = prepareCoreInstallInput(t.Context(), restored, f.bundle(), nil, true); err == nil {
		t.Fatal("corrupt retained proof accepted")
	}
	if err = verifyInstallerCoreProof(f.raw, f.signature, append(prepared.CoreMetadataProof, []byte(" {}")...)); err == nil {
		t.Fatal("trailing proof accepted")
	}
	if err = verifyInstallerCoreProof(f.raw, f.signature, bytes.Repeat([]byte{'x'}, coreMetadataProofMaxBytes+1)); err == nil {
		t.Fatal("oversized proof accepted")
	}
	// Replacing a current scoped key invalidates the retained proof offline.
	embeddedApplianceDevelopmentTrust = pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: func() []byte {
		d, _ := x509.MarshalPKIXPublicKey(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{39}, 32)).Public())
		return d
	}()})
	if err = verifyInstallerCoreProof(f.raw, f.signature, prepared.CoreMetadataProof); err == nil {
		t.Fatal("stale authority accepted")
	}
}

func TestInstallerMetadataRetainsIndependentOriginalPublicRoleAuthority(t *testing.T) {
	f := newInstallerMetadataFixture(t, true)
	beta := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{43}, 32))
	der, _ := x509.MarshalPKIXPublicKey(beta.Public())
	keyID := coreManifestDigest(der)
	prior := publicReleaseTrustJSON
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"beta": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}})
	t.Cleanup(func() { publicReleaseTrustJSON = prior })
	for i := range f.core.Members {
		m := &f.core.Members[i]
		if m.Role != "cp" {
			continue
		}
		m.Source = releasecache.OfficialRepository
		m.Branch = "beta"
		m.BuildVersion = "0.5.38-beta.1"
		m.Tag = "youeye-v" + m.BuildVersion
		m.KeyID = keyID
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM} {
			b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
		}
	}
	f.freeze(t, true)
	proof, err := fetchInstallerCoreProof(t.Context(), f.server.Client(), f.raw, f.signature, false)
	if err != nil {
		t.Fatal("independently trusted original Beta member rejected", err)
	}
	if err = verifyInstallerCoreProof(f.raw, f.signature, proof); err != nil {
		t.Fatal(err)
	}
	// The assembly's development key remains valid, but removing the reused
	// role's own Beta grant must invalidate the same exact selection/proof.
	publicReleaseTrustJSON = []byte(`{"schema":"youeye.public-trust.v1","keys":{}}`)
	before := len(f.requests)
	if _, err = fetchInstallerCoreProof(t.Context(), f.server.Client(), f.raw, f.signature, false); err == nil {
		t.Fatal("assembly key authorized an untrusted reused role")
	}
	if len(f.requests) != before {
		t.Fatal("network used before current role authorization")
	}
	if err = verifyInstallerCoreProof(f.raw, f.signature, proof); err == nil {
		t.Fatal("retained proof bypassed current original role policy")
	}
}
