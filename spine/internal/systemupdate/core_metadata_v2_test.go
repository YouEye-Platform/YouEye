package systemupdate

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

// These fixtures contain a real checksum-bound original Spine announcement;
// placeholder hashes cannot stand in for authenticated legacy-reader evidence.
func metadataFixtureEnvelope(t *testing.T, r *releasecache.CoreRelease, key ed25519.PrivateKey, paired bool) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		if m.Role != "spine" {
			continue
		}
		provenance := []byte(`{"fixture":true}`)
		if paired {
			provenance = []byte(`{"core_metadata":"paired-v2"}`)
		}
		m.Provenance.SHA256 = checksum(provenance)
		m.Provenance.SizeBytes = int64(len(provenance))
		sums := []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
		signature := ed25519.Sign(key, sums)
		m.Checksums.SHA256 = checksum(sums)
		m.Checksums.SizeBytes = int64(len(sums))
		m.Signature.SHA256 = checksum(signature)
		m.Signature.SizeBytes = int64(len(signature))
		files[m.Checksums.URL] = sums
		files[m.Signature.URL] = signature
		files[m.Provenance.URL] = provenance
	}
	return files
}
func metadataFixtureSelection(t *testing.T, r releasecache.CoreRelease, assembly, spine ed25519.PrivateKey, files map[string][]byte) CoreHostSelection {
	t.Helper()
	raw, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	selection := CoreHostSelection{Raw: raw, Signature: ed25519.Sign(assembly, raw)}
	proof, _, e := releasecache.FetchCoreMetadataProof(raw, selection.Signature, assembly.Public().(ed25519.PublicKey), func(releasecache.CoreMember) (ed25519.PublicKey, error) {
		return spine.Public().(ed25519.PublicKey), nil
	}, false, func(b releasecache.CoreBlob, _ int64) ([]byte, error) { return files[b.URL], nil }, nil)
	if e != nil {
		t.Fatal(e)
	}
	selection.MetadataProof, e = json.Marshal(proof)
	if e != nil {
		t.Fatal(e)
	}
	return selection
}

func TestCoreMetadataProofRequiresFreshCurrentAuthority(t *testing.T) {
	raw, err := ReadCoreState("../../../releasecache/testdata/core-metadata-v2-vector.json", CoreMetadataProofMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		PublicKey          string                         `json:"public_key"`
		Execution          []byte                         `json:"execution"`
		ExecutionSignature []byte                         `json:"execution_signature"`
		Proof              releasecache.CoreMetadataProof `json:"proof"`
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	old := coreTrustLookup
	t.Cleanup(func() { coreTrustLookup = old })
	revoked := false
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if revoked {
			return nil, fmt.Errorf("current owner revocation")
		}
		return &updatetrust.Grant{PublicKey: v.PublicKey}, nil
	}
	proof, _ := json.Marshal(v.Proof)
	selection := CoreHostSelection{Raw: v.Execution, Signature: v.ExecutionSignature, MetadataProof: proof}
	selected, facts, err := EnsureCoreMetadata(context.Background(), selection, "unused", t.TempDir(), nil, "")
	if err != nil || facts.Schema != releasecache.CoreMetadataV2Schema || facts.ExecutionManifestSHA256 != checksum(v.Execution) {
		t.Fatal(facts, err)
	}
	inputs := t.TempDir()
	cache := t.TempDir()
	for name, data := range map[string][]byte{"checksums": v.Proof.SpineChecksums, "signature": v.Proof.SpineSignature, "provenance": v.Proof.SpineProvenance, "core-release-v2.json": v.Proof.Documents.Canonical, "core-release-v2.json.sig": v.Proof.Documents.CanonicalSignature, "core-compatibility.json": v.Proof.Documents.Pair, "core-compatibility.json.sig": v.Proof.Documents.PairSignature} {
		if e := os.WriteFile(filepath.Join(inputs, name), data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	empty := CoreHostSelection{Raw: v.Execution, Signature: v.ExecutionSignature}
	if _, _, err = EnsureCoreMetadata(context.Background(), empty, "unused", cache, nil, inputs); err != nil {
		t.Fatal("valid offline bundle rejected", err)
	}
	if err = os.Remove(filepath.Join(inputs, "core-compatibility.json")); err != nil {
		t.Fatal(err)
	}
	if _, _, err = EnsureCoreMetadata(context.Background(), empty, "unused", cache, nil, inputs); err == nil {
		t.Fatal("cached proof hid supplied partial offline bundle")
	}
	m := CoreManager{Root: t.TempDir()}
	if err = m.retainSelection(selected, facts.ExecutionManifestSHA256); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.Selection(facts.ExecutionManifestSHA256, "unused"); err != nil {
		t.Fatal("offline re-entry rejected verified proof", err)
	}
	revoked = true
	if _, _, err = m.Selection(facts.ExecutionManifestSHA256, "unused"); err == nil {
		t.Fatal("retained proof bypassed current revocation")
	}
	revoked = false
	v.Proof.Documents.Pair = nil
	bad, _ := json.Marshal(v.Proof)
	if err = os.WriteFile(filepath.Join(m.Root, "targets", facts.ExecutionManifestSHA256+".metadata.json"), bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.Selection(facts.ExecutionManifestSHA256, "unused"); err == nil {
		t.Fatal("retained partial pair accepted")
	}
}
