package releasecache

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

var writeCoreMetadataVector = flag.Bool("write-core-metadata-vector", false, "explicitly regenerate the synthetic shared metadata test vector")

type metadataVector struct {
	PublicKey          string            `json:"public_key"`
	Execution          []byte            `json:"execution"`
	ExecutionSignature []byte            `json:"execution_signature"`
	Proof              CoreMetadataProof `json:"proof"`
	Facts              CoreMetadataFacts `json:"facts"`
}

func newMetadataVector(t *testing.T) metadataVector {
	t.Helper()
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	pub := priv.Public().(ed25519.PublicKey)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	keyID := metadataHash(der)
	raw, err := os.ReadFile("testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	r.SignerSHA256 = keyID
	r.Source = coreMetadataOfficialRepository
	r.Branch = "main"
	r.Channel = "stable"
	var checksums, signature, provenance []byte
	for i := range r.Members {
		m := &r.Members[i]
		m.KeyID = keyID
		if m.Role == "cp" {
			m.Source = "https://private-builder.example.test/team/YouEye"
			for _, b := range []*CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM} {
				b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
			}
		}
		if m.Role == "spine" {
			provenance = []byte(`{"schema":"youeye.release.provenance.v1","core_metadata":"paired-v2","source_commit":"` + m.SourceCommit + `"}`)
			m.Provenance.SHA256 = metadataHash(provenance)
			m.Provenance.SizeBytes = int64(len(provenance))
			checksums = []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
			signature = ed25519.Sign(priv, checksums)
			m.Checksums.SHA256 = metadataHash(checksums)
			m.Checksums.SizeBytes = int64(len(checksums))
			m.Signature.SHA256 = metadataHash(signature)
			m.Signature.SizeBytes = 64
		}
	}
	execution, _ := metadataJSON(r)
	sig := ed25519.Sign(priv, execution)
	canonical, err := EncodeCoreMetadataV2(r)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := EncodeCoreMetadataPair(execution, canonical)
	if err != nil {
		t.Fatal(err)
	}
	documents := CoreMetadataDocuments{Canonical: canonical, CanonicalSignature: ed25519.Sign(priv, canonical), Pair: pair, PairSignature: ed25519.Sign(priv, pair)}
	facts, err := VerifyCoreMetadataBundle(execution, sig, documents, pub, func(CoreMember) (ed25519.PublicKey, error) { return pub, nil })
	if err != nil {
		t.Fatal(err)
	}
	proof := CoreMetadataProof{Schema: "youeye.core-metadata-proof.v1", ExecutionManifestSHA256: metadataHash(execution), Advertised: true, SpineChecksums: checksums, SpineSignature: signature, SpineProvenance: provenance, Documents: documents, Bindings: facts.Bindings}
	return metadataVector{PublicKey: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), Execution: execution, ExecutionSignature: sig, Proof: proof, Facts: facts}
}
func vectorKey(t *testing.T, v metadataVector) ed25519.PublicKey {
	t.Helper()
	b, _ := pem.Decode([]byte(v.PublicKey))
	k, e := x509.ParsePKIXPublicKey(b.Bytes)
	if e != nil {
		t.Fatal(e)
	}
	return k.(ed25519.PublicKey)
}
func verifyVector(t *testing.T, v metadataVector) (CoreMetadataFacts, error) {
	pub := vectorKey(t, v)
	return VerifyCoreMetadataProof(v.Execution, v.ExecutionSignature, v.Proof, pub, func(CoreMember) (ed25519.PublicKey, error) { return pub, nil })
}

func TestCoreMetadataV2SharedVector(t *testing.T) {
	path := "testdata/core-metadata-v2-vector.json"
	if *writeCoreMetadataVector {
		v := newMetadataVector(t)
		raw, e := json.MarshalIndent(v, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(raw, '\n'), 0644); e != nil {
			t.Fatal(e)
		}
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var v metadataVector
	if e = json.Unmarshal(raw, &v); e != nil {
		t.Fatal(e)
	}
	facts, e := verifyVector(t, v)
	if e != nil || !reflect.DeepEqual(facts, v.Facts) {
		t.Fatalf("shared vector mismatch: %v", e)
	}
}
func TestCoreMetadataV2NoAddressesAndExactRegistry(t *testing.T) {
	v := newMetadataVector(t)
	if bytes.Contains(v.Proof.Documents.Canonical, []byte("://")) || bytes.Contains(v.Proof.Documents.Pair, []byte("://")) {
		t.Fatal("deployment address in canonical metadata")
	}
	facts, e := verifyVector(t, v)
	if e != nil {
		t.Fatal(e)
	}
	if facts.ExecutionManifestSHA256 != metadataHash(v.Execution) || facts.CanonicalManifestSHA256 == facts.ExecutionManifestSHA256 {
		t.Fatal("canonical and execution digest boundary lost")
	}
	if len(facts.Bindings) != 14 {
		t.Fatal("incomplete local registry")
	}
	found := false
	for _, b := range facts.Bindings {
		if strings.Contains(b.OriginalSource, "private-builder.example.test") {
			found = true
			id, _ := CoreSourceID(b.OriginalSource)
			if b.Identity.ID != id || b.Identity.Authority != "development" {
				t.Fatal("wrong independently derived mapping")
			}
		}
	}
	if !found {
		t.Fatal("original private provenance disappeared")
	}
	if len(CoreMetadataPublicFacts(facts).Bindings) != 0 {
		t.Fatal("private local mapping leaked in public diagnostics")
	}
}
func TestCoreMetadataV2EveryRoleUsesCurrentAuthority(t *testing.T) {
	v := newMetadataVector(t)
	pub := vectorKey(t, v)
	calls := 0
	_, e := VerifyCoreMetadataProof(v.Execution, v.ExecutionSignature, v.Proof, pub, func(m CoreMember) (ed25519.PublicKey, error) {
		calls++
		if m.Role == "cp" {
			return nil, fmt.Errorf("revoked exact original source scope")
		}
		return pub, nil
	})
	if e == nil || calls < 2 {
		t.Fatal("assembly enrolled an independent original role")
	}
}
func TestCoreMetadataV2PartialWrongMissingAndTamperedFailClosed(t *testing.T) {
	for _, field := range []string{"canonical", "canonical_signature", "pair", "pair_signature", "spine_checksums", "spine_signature", "spine_provenance", "registry", "execution"} {
		t.Run(field, func(t *testing.T) {
			v := newMetadataVector(t)
			switch field {
			case "canonical":
				v.Proof.Documents.Canonical = nil
			case "canonical_signature":
				v.Proof.Documents.CanonicalSignature = bytes.Repeat([]byte{1}, 64)
			case "pair":
				v.Proof.Documents.Pair = nil
			case "pair_signature":
				v.Proof.Documents.PairSignature = bytes.Repeat([]byte{1}, 64)
			case "spine_checksums":
				v.Proof.SpineChecksums = append(v.Proof.SpineChecksums, 'x')
			case "spine_signature":
				v.Proof.SpineSignature = bytes.Repeat([]byte{1}, 64)
			case "spine_provenance":
				v.Proof.SpineProvenance = []byte(`{}`)
			case "registry":
				v.Proof.Bindings[0].OriginalSource = "https://different.example.test/team/YouEye"
			case "execution":
				v.Execution = append(v.Execution, ' ')
			}
			if _, e := verifyVector(t, v); e == nil {
				t.Fatal("invalid representation accepted")
			}
		})
	}
}
func TestCoreMetadataV2SignedMarkerPreventsAssetStripping(t *testing.T) {
	v := newMetadataVector(t)
	v.Proof.Advertised = false
	v.Proof.Documents = CoreMetadataDocuments{}
	v.Proof.Bindings = nil
	if _, e := verifyVector(t, v); e == nil {
		t.Fatal("network stripping selected weaker legacy reader")
	}
}
func TestCoreMetadataV2UnknownCapabilityAndBareAuthorityFail(t *testing.T) {
	v := newMetadataVector(t)
	pub := vectorKey(t, v)
	var canonical CoreMetadataV2
	if e := json.Unmarshal(v.Proof.Documents.Canonical, &canonical); e != nil {
		t.Fatal(e)
	}
	canonical.Members[12].Publisher.ID = strings.Repeat("f", 64)
	canonical.Members[12].Publisher.Authority = "official-stable"
	raw, _ := metadataJSON(canonical)
	if _, e := EncodeCoreMetadataPair(v.Execution, raw); e == nil {
		t.Fatal("bare class assertion changed original role authority")
	}
	canonical, _ = CoreMetadataFromExecution(mustMetadataRelease(t, v.Execution))
	canonical.RequiredCapabilities = []string{"future-unknown"}
	raw, _ = metadataJSON(canonical)
	if _, e := ParseCoreMetadataV2(raw); e == nil {
		t.Fatal("unknown capability accepted")
	}
	_ = pub
}
func mustMetadataRelease(t *testing.T, raw []byte) CoreRelease {
	t.Helper()
	r, _, e := ParseCoreRelease(raw)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestCoreMetadataV2SameSequenceIsNotArbitraryEquivalence(t *testing.T) {
	v := newMetadataVector(t)
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	r := mustMetadataRelease(t, v.Execution)
	r.SourceCommit = strings.Repeat("f", 40)
	v.Execution, _ = metadataJSON(r)
	v.ExecutionSignature = ed25519.Sign(priv, v.Execution)
	v.Proof.ExecutionManifestSHA256 = metadataHash(v.Execution)
	if _, e := verifyVector(t, v); e == nil {
		t.Fatal("same sequence replaced signed pair identity")
	}
}
func TestCoreMetadataV2UnknownMarkerFailsEvenWithValidSpineSignature(t *testing.T) {
	v := newMetadataVector(t)
	r := mustMetadataRelease(t, v.Execution)
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	for _, m := range r.Members {
		if m.Role != "spine" {
			continue
		}
		raw := []byte(`{"core_metadata":"future-unknown"}`)
		m.Provenance.SHA256 = metadataHash(raw)
		m.Provenance.SizeBytes = int64(len(raw))
		sums := []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", m.Artifact.SHA256, m.Artifact.Name, m.Provenance.SHA256, m.Provenance.Name, m.SBOM.SHA256, m.SBOM.Name))
		sig := ed25519.Sign(priv, sums)
		m.Checksums.SHA256 = metadataHash(sums)
		m.Checksums.SizeBytes = int64(len(sums))
		m.Signature.SHA256 = metadataHash(sig)
		if _, e := VerifyCoreSpineMetadata(m, vectorKey(t, v), sums, sig, raw); e == nil {
			t.Fatal("unknown original capability silently became legacy")
		}
	}
}

func TestCoreMetadataRejectsEscapedAddresses(t *testing.T) {
	v := newMetadataVector(t)
	var canonical CoreMetadataV2
	if err := json.Unmarshal(v.Proof.Documents.Canonical, &canonical); err != nil {
		t.Fatal(err)
	}
	canonical.Compatibility.Capabilities = append(canonical.Compatibility.Capabilities, "https://example.test/")
	raw, err := json.Marshal(canonical)
	if err != nil {
		t.Fatal(err)
	}
	for _, escape := range []string{`https:\/\/example.test/`, `https\u003a//example.test/`} {
		bad := bytes.ReplaceAll(raw, []byte("https://example.test/"), []byte(escape))
		if _, err := ParseCoreMetadataV2(bad); err == nil {
			t.Fatal("escaped deployment address accepted")
		}
	}
}
