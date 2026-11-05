package releases

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

type mixedCoreRoundTrip func(*http.Request) (*http.Response, error)

func (f mixedCoreRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mixedMemberHash(raw []byte) string                                        { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

func TestMixedCoreOriginalEnvelopeUsesScopedAuthorityAndSignedMirror(t *testing.T) {
	t.Setenv("YOUEYE_RELEASE_CACHE", t.TempDir())
	root := t.TempDir()
	oldRoot, oldTrust, oldChannels := coreSelectionRoot, updatetrust.Path, channels.ConfigPath
	t.Cleanup(func() { coreSelectionRoot, updatetrust.Path, channels.ConfigPath = oldRoot, oldTrust, oldChannels })
	coreSelectionRoot, updatetrust.Path, channels.ConfigPath = root, filepath.Join(root, "trust.json"), filepath.Join(root, "channels.yaml")
	var vector struct {
		PublicKey string                         `json:"public_key"`
		Execution []byte                         `json:"execution"`
		Proof     releasecache.CoreMetadataProof `json:"proof"`
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-metadata-v2-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(vector.Execution)
	if err != nil {
		t.Fatal(err)
	}
	stable := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, 32))
	original := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{73}, 32))
	der, _ := x509.MarshalPKIXPublicKey(original.Public())
	originalPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	bodies := map[string][]byte{}
	var cp releasecache.CoreMember
	for i := range r.Members {
		m := &r.Members[i]
		if m.Role != "cp" {
			continue
		}
		m.KeyID = mixedMemberHash(der)
		payload, provenance, sbom := []byte("independently signed original Control Panel"), []byte(`{"schema":"fixture.original.provenance"}`), []byte(`{"spdxVersion":"SPDX-2.3"}`)
		for _, b := range []struct {
			blob *releasecache.CoreBlob
			raw  []byte
		}{{&m.Artifact, payload}, {&m.Provenance, provenance}, {&m.SBOM, sbom}} {
			b.blob.SHA256 = mixedMemberHash(b.raw)
			b.blob.SizeBytes = int64(len(b.raw))
			bodies[b.blob.URL] = b.raw
		}
		sums := []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
		sig := ed25519.Sign(original, sums)
		m.Checksums.SHA256, m.Checksums.SizeBytes = mixedMemberHash(sums), int64(len(sums))
		m.Signature.SHA256, m.Signature.SizeBytes = mixedMemberHash(sig), 64
		bodies[m.Checksums.URL], bodies[m.Signature.URL] = sums, sig
		cp = *m
	}
	execution, _ := json.Marshal(r)
	executionSignature := ed25519.Sign(stable, execution)
	canonical, err := releasecache.EncodeCoreMetadataV2(r)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := releasecache.EncodeCoreMetadataPair(execution, canonical)
	if err != nil {
		t.Fatal(err)
	}
	docs := releasecache.CoreMetadataDocuments{Canonical: canonical, CanonicalSignature: ed25519.Sign(stable, canonical), Pair: pair, PairSignature: ed25519.Sign(stable, pair)}
	facts, err := releasecache.VerifyCoreMetadataBundle(execution, executionSignature, docs, stable.Public().(ed25519.PublicKey), func(m releasecache.CoreMember) (ed25519.PublicKey, error) {
		if m.Role == "cp" {
			return original.Public().(ed25519.PublicKey), nil
		}
		return stable.Public().(ed25519.PublicKey), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	proof := vector.Proof
	proof.ExecutionManifestSHA256 = mixedMemberHash(execution)
	proof.Documents, proof.Bindings = docs, facts.Bindings
	proofRaw, _ := json.Marshal(proof)
	for name, data := range map[string][]byte{"core-release.json": execution, "core-release.json.sig": executionSignature, "core-metadata.json": proofRaw} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	policy := updatetrust.Policy{Schema: updatetrust.Schema, Grants: []updatetrust.Grant{{Publisher: "Fixture Stable", Repository: r.Source, Branch: r.Branch, Scope: "appliance", PublicKey: vector.PublicKey}, {Publisher: "Fixture Stable", Repository: r.Source, Branch: r.Branch, Scope: "spine", PublicKey: vector.PublicKey}, {Publisher: "Fixture Stable", Repository: r.Source, Branch: r.Branch, Scope: "ui", PublicKey: vector.PublicKey}, {Publisher: "Fixture original", Repository: cp.Source, Branch: cp.Branch, Scope: "cp", PublicKey: originalPEM}}}
	if err := updatetrust.Save(updatetrust.Path, policy); err != nil {
		t.Fatal(err)
	}
	if err := (&channels.Config{Control: channels.Channel{Source: cp.Source, Branch: cp.Branch, Tag: cp.Tag, ArtifactSHA256: cp.Artifact.SHA256, Fallback: []string{}}}).Save(); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Releases.RepoURL = r.Source
	candidate, err := ResolveComponent(cfg, channels.ComponentControl, cfg.Releases.Repositories.ControlPanel, "cp")
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Source != cp.Source || candidate.Branch != cp.Branch || candidate.Tag != cp.Tag || candidate.ArtifactSHA256 != cp.Artifact.SHA256 {
		t.Fatal("original identity replaced by assembly")
	}
	mirrors := map[string][]byte{}
	for _, b := range []releasecache.CoreBlob{cp.Artifact, cp.Checksums, cp.Signature, cp.Provenance, cp.SBOM} {
		mirrors[r.Source+"/releases/download/"+r.Tag+"/blob-"+b.SHA256] = bodies[b.URL]
	}
	reads := 0
	client := &http.Client{Transport: selectedCoreTransport{base: mixedCoreRoundTrip(func(request *http.Request) (*http.Response, error) {
		reads++
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			return nil, fmt.Errorf("credentials crossed signed mirror boundary")
		}
		raw, ok := mirrors[request.URL.String()]
		if !ok {
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("unpublished original")), Header: http.Header{}, Request: request}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), ContentLength: int64(len(raw)), Header: http.Header{}, Request: request}, nil
	})}}
	response, err := client.Get(candidate.ArtifactURL)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 {
		t.Fatal(err, response.StatusCode)
	}
	artifact := filepath.Join(root, "cp.tar")
	if err := os.WriteFile(artifact, payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), client, candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err != nil {
		t.Fatal(err)
	}
	if reads < 5 {
		t.Fatal("original metadata envelope was not independently read")
	}
	if err := os.WriteFile(artifact, append(payload, '!'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), client, candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err == nil {
		t.Fatal("modified artifact accepted")
	}
	if err := os.WriteFile(artifact, payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifySelectedCoreArtifact(context.Background(), client, r.Source+"/releases/download/"+cp.Tag+"/"+cp.Artifact.Name, artifact, candidate.ArtifactSHA256, "cp"); err == nil {
		t.Fatal("assembly address relabeled original member")
	}
	policy.Grants[len(policy.Grants)-1].Revoked = true
	if err := updatetrust.Save(updatetrust.Path, policy); err != nil {
		t.Fatal(err)
	}
	before := reads
	if err := VerifySelectedCoreArtifact(context.Background(), client, candidate.ArtifactURL, artifact, candidate.ArtifactSHA256, "cp"); err == nil {
		t.Fatal("revoked original role accepted")
	}
	if reads != before {
		t.Fatal("revoked metadata attempted network fallback")
	}
}
