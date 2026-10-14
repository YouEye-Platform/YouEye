package systemupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreInitializeRequiresFreshNativeEvidenceAndPreservesMachineBinding(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	oldSource := r.Source
	r.Source, r.SignerSHA256 = "https://forge.example/owner/YouEye", checksum(der)
	for i := range r.Members {
		member := &r.Members[i]
		member.Source, member.KeyID = r.Source, r.SignerSHA256
		for _, b := range []*releasecache.CoreBlob{&member.Artifact, &member.Checksums, &member.Signature, &member.Provenance, &member.SBOM, member.DocumentSignature, member.ReleaseLock} {
			if b != nil {
				b.URL = strings.Replace(b.URL, oldSource, r.Source, 1)
			}
		}
	}
	raw, _ = json.Marshal(r)
	selection := CoreHostSelection{Raw: raw, Signature: ed25519.Sign(private, raw)}
	root := t.TempDir()
	trust := filepath.Join(root, "key.pub")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	m := CoreManager{Root: filepath.Join(root, "state"), Executor: &coreTestExecutor{}}
	machine := CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state", DataPartUUID: "data"}
	fail := true
	verify := func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		if fail {
			return machine, "", fmt.Errorf("fixture service health failed")
		}
		return machine, "fixture installed membership and health", nil
	}
	ctx := context.Background()
	if _, err := m.Initialize(ctx, selection, checksum(raw), trust, verify); err == nil {
		t.Fatal("failed health initialized receipt")
	}
	if _, err := os.Stat(filepath.Join(m.Root, "committed.json")); !os.IsNotExist(err) {
		t.Fatal("failed initialization wrote receipt", err)
	}
	fail = false
	accepted, err := m.Initialize(ctx, selection, checksum(raw), trust, verify)
	if err != nil || accepted.Machine != machine || accepted.ManifestSHA256 != checksum(raw) {
		t.Fatal(accepted, err)
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.Machine != machine {
		t.Fatal(receipt, err)
	}
	if again, err := m.Initialize(ctx, selection, checksum(raw), trust, verify); err != nil || again.AcceptedAt != accepted.AcceptedAt {
		t.Fatal(again, err)
	}
	machine.DeviceIDRef = "device:another"
	if _, err := m.Initialize(ctx, selection, checksum(raw), trust, verify); err == nil {
		t.Fatal("fresh receipt rebound to another machine")
	}
	if receipt, err := m.ReadReceipt(); err != nil || receipt.Machine != accepted.Machine {
		t.Fatal(receipt, err)
	}
	// Losing an accepted target file is recovery work, not an absent receipt
	// permitting a fresh initializer to overwrite the installation record.
	machine = accepted.Machine
	if err := os.Remove(filepath.Join(m.Root, "targets", accepted.ManifestSHA256+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Initialize(ctx, selection, checksum(raw), trust, verify); err == nil {
		t.Fatal("missing retained input was treated as an uninitialized install")
	}

}
