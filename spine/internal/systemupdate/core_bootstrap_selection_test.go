package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func TestRetainedBootstrapProofContinuesInitializeAndFirstBootOffline(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-metadata-v2-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		PublicKey          string                         `json:"public_key"`
		Execution          []byte                         `json:"execution"`
		ExecutionSignature []byte                         `json:"execution_signature"`
		Proof              releasecache.CoreMetadataProof `json:"proof"`
	}
	if err = json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	prior := coreTrustLookup
	revoked := false
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if revoked && scope == "ui" {
			return nil, fmt.Errorf("current UI role revoked")
		}
		return &updatetrust.Grant{PublicKey: vector.PublicKey}, nil
	}
	t.Cleanup(func() { coreTrustLookup = prior })
	proof, _ := json.Marshal(vector.Proof)
	directory := t.TempDir()
	for name, content := range map[string][]byte{"core-release.json": vector.Execution, "core-release.json.sig": vector.ExecutionSignature, CoreMetadataProofName: proof} {
		if err = os.WriteFile(filepath.Join(directory, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := ReadCoreBootstrapSelection(directory, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(loaded.Raw, vector.Execution) || !bytes.Equal(loaded.Signature, vector.ExecutionSignature) || !bytes.Equal(loaded.MetadataProof, proof) {
		t.Fatal("bootstrap loader replaced original bytes")
	}
	requests := 0
	client := &http.Client{Transport: signedRedirectTransport(func(*http.Request) (*http.Response, error) {
		requests++
		return nil, fmt.Errorf("offline metadata transport")
	})}
	cache := t.TempDir()
	loaded, _, err = EnsureCoreMetadata(context.Background(), loaded, "unused", cache, client, "")
	if err != nil {
		t.Fatal(err)
	}
	m := CoreManager{Root: filepath.Join(t.TempDir(), "core")}
	machine := CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}
	if _, err = m.Initialize(context.Background(), loaded, checksum(vector.Execution), "unused", func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		if _, _, err := EnsureCoreMetadata(context.Background(), loaded, "unused", cache, client, ""); err != nil {
			return machine, "", err
		}
		return machine, "exact fixture installed payloads and health", nil
	}); err != nil {
		t.Fatal("offline initialization lost proof", err)
	}
	r, _, _ := releasecache.ParseCoreRelease(vector.Execution)
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Provider: "github", Mode: "exact", ExactTag: r.Tag, ManifestSHA256: checksum([]byte("fixture media")), CoreManifestSHA256: checksum(vector.Execution), Freshness: "require-current"}
	frozen, selected, err := m.FreezeFirstBoot(context.Background(), policy, loaded, "unused", func(context.Context) (CoreHostSelection, error) {
		t.Error("exact baseline attempted new discovery")
		return CoreHostSelection{}, fmt.Errorf("offline")
	})
	if err != nil || frozen.ManifestSHA256 != checksum(vector.Execution) || !bytes.Equal(selected.MetadataProof, proof) {
		t.Fatal("offline first boot changed selection/proof", err)
	}
	// Re-entry uses retained target evidence; it does not replay discovery or
	// downgrade to manifest-only acceptance when the transport is unavailable.
	_, selected, err = m.FreezeFirstBoot(context.Background(), policy, loaded, "unused", nil)
	if err != nil || !bytes.Equal(selected.MetadataProof, proof) || requests != 0 {
		t.Fatal("restart refetched metadata or lost proof", err, requests)
	}
	if _, err = os.Stat(filepath.Join(cache, "metadata-v2")); !os.IsNotExist(err) {
		t.Fatal("offline proof unexpectedly required a metadata cache")
	}
	revoked = true
	if _, err = ReadCoreBootstrapSelection(directory, "unused"); err == nil {
		t.Fatal("bootstrap proof bypassed current UI revocation")
	}
	if _, _, err = m.Selection(frozen.ManifestSHA256, "unused"); err == nil {
		t.Fatal("retained first-boot target bypassed current UI revocation")
	}
	revoked = false
	vector.Proof.Documents.PairSignature[0] ^= 1
	bad, _ := json.Marshal(vector.Proof)
	if err = os.WriteFile(filepath.Join(directory, CoreMetadataProofName), bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = ReadCoreBootstrapSelection(directory, "unused"); err == nil {
		t.Fatal("bad bootstrap proof accepted")
	}
	if requests != 0 {
		t.Fatal("invalid local proof used network fallback")
	}
	if err = os.Remove(filepath.Join(directory, CoreMetadataProofName)); err != nil {
		t.Fatal(err)
	}
	absent, err := ReadCoreBootstrapSelection(directory, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = EnsureCoreMetadata(context.Background(), absent, "unused", t.TempDir(), client, ""); err == nil || requests == 0 {
		t.Fatal("missing proof was treated as authenticated legacy", err, requests)
	}
}
