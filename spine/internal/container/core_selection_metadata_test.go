package container

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type handoffOfflineTransport struct{ requests int }

func (t *handoffOfflineTransport) RoundTrip(*http.Request) (*http.Response, error) {
	t.requests++
	return nil, fmt.Errorf("offline metadata")
}

func TestCoreCPHandoffUsesExactRetainedProofOfflineBeforeMutation(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-metadata-v2-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Execution []byte                         `json:"execution"`
		Proof     releasecache.CoreMetadataProof `json:"proof"`
	}
	if err = json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(vector.Execution)
	if err != nil {
		t.Fatal(err)
	}
	// The shared vector is signed by this explicitly synthetic test key. Give
	// its original members a private fixture source so the normal native
	// development anchor path can be tested without changing machine policy.
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, 32))
	public := private.Public().(ed25519.PublicKey)
	r.Source = "https://handoff-fixture.example/owner/YouEye"
	for i := range r.Members {
		m := &r.Members[i]
		m.Source = r.Source
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = m.Source + "/releases/download/" + m.Tag + "/" + b.Name
			}
		}
	}
	execution, _ := json.Marshal(r)
	signature := ed25519.Sign(private, execution)
	canonical, err := releasecache.EncodeCoreMetadataV2(r)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := releasecache.EncodeCoreMetadataPair(execution, canonical)
	if err != nil {
		t.Fatal(err)
	}
	vector.Proof.Documents = releasecache.CoreMetadataDocuments{Canonical: canonical, CanonicalSignature: ed25519.Sign(private, canonical), Pair: pair, PairSignature: ed25519.Sign(private, pair)}
	facts, err := releasecache.VerifyCoreMetadataBundle(execution, signature, vector.Proof.Documents, public, func(releasecache.CoreMember) (ed25519.PublicKey, error) { return public, nil })
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(execution)
	vector.Proof.ExecutionManifestSHA256 = hex.EncodeToString(h[:])
	vector.Proof.Bindings = facts.Bindings
	proof, _ := json.Marshal(vector.Proof)
	root := t.TempDir()
	trust := filepath.Join(root, "key.pub")
	der, _ := x509.MarshalPKIXPublicKey(public)
	if err = os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{"core-release.json": execution, "core-release.json.sig": signature, systemupdate.CoreMetadataProofName: proof} {
		if err = os.WriteFile(filepath.Join(root, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	offline := &handoffOfflineTransport{}
	client := &http.Client{Transport: offline}
	cache := t.TempDir()
	selection, err := coreSelectionForHandoff(context.Background(), root, trust, cache, client)
	if err != nil || offline.requests != 0 {
		t.Fatal("CP handoff refetched retained metadata", err, offline.requests)
	}
	if !bytes.Equal(selection.Raw, execution) || !bytes.Equal(selection.MetadataProof, proof) {
		t.Fatal("CP handoff changed original selection/proof")
	}
	inputs, err := retainCoreHandoffInputs(selection)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(inputs)
	// A later replacement of the bootstrap source cannot change the exact
	// already verified files selected for the CP push.
	if err = os.WriteFile(filepath.Join(root, "core-release.json"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	for name, expected := range map[string][]byte{"core-release.json": execution, "core-release.json.sig": signature, systemupdate.CoreMetadataProofName: proof} {
		actual, err := os.ReadFile(filepath.Join(inputs, name))
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatal("CP retained input changed", name, err)
		}
	}
	if err = os.WriteFile(filepath.Join(root, "core-release.json"), execution, 0600); err != nil {
		t.Fatal(err)
	}
	vector.Proof.Documents.PairSignature[0] ^= 1
	bad, _ := json.Marshal(vector.Proof)
	if err = os.WriteFile(filepath.Join(root, systemupdate.CoreMetadataProofName), bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = coreSelectionForHandoff(context.Background(), root, trust, cache, client); err == nil {
		t.Fatal("bad proof entered CP handoff")
	}
	if offline.requests != 0 {
		t.Fatal("bad retained proof fell back to network")
	}
	if err = os.WriteFile(filepath.Join(root, systemupdate.CoreMetadataProofName), proof, 0600); err != nil {
		t.Fatal(err)
	}
	der, _ = x509.MarshalPKIXPublicKey(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{45}, 32)).Public())
	if err = os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = coreSelectionForHandoff(context.Background(), root, trust, cache, client); err == nil {
		t.Fatal("CP retained proof bypassed changed current trust")
	}
	if _, err = os.Stat(filepath.Join(cache, "metadata-v2")); !os.IsNotExist(err) {
		t.Fatal("offline handoff wrote metadata cache")
	}
}
