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
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func TestCoreBootstrapRetainsExactSignedCoordinatorAndRejectsSubstitution(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	key, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(key)
	previousTrust := publicReleaseTrustJSON
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}})
	t.Cleanup(func() { publicReleaseTrustJSON = previousTrust })
	target.SignerSHA256 = checksum(der)
	parts := map[string][]byte{"youeye": []byte("signed coordinator fixture"), "provenance": []byte("original provenance"), "sbom": []byte("original sbom")}
	var member *releasecache.CoreMember
	for i := range target.Members {
		if target.Members[i].Role == "spine" {
			member = &target.Members[i]
		}
	}
	member.BuildVersion, member.Tag, member.KeyID = target.Version, target.Tag, target.SignerSHA256
	blob := func(name, part string) releasecache.CoreBlob {
		return releasecache.CoreBlob{Name: name, URL: member.Source + "/releases/download/" + member.Tag + "/" + name, SHA256: checksum(parts[part]), SizeBytes: int64(len(parts[part]))}
	}
	member.Artifact = blob("spine-linux-amd64", "youeye")
	member.Provenance = blob("spine-provenance.json", "provenance")
	member.SBOM = blob("spine-sbom.json", "sbom")
	for _, b := range []releasecache.CoreBlob{member.Artifact, member.Provenance, member.SBOM} {
		parts["checksums"] = append(parts["checksums"], []byte(b.SHA256+"  "+b.Name+"\n")...)
	}
	parts["signature"] = ed25519.Sign(private, parts["checksums"])
	member.Checksums = blob("spine-SHA256SUMS", "checksums")
	member.Signature = blob("spine-SHA256SUMS.sig", "signature")
	raw, _ := json.Marshal(target)
	digest := checksum(raw)
	j, err := m.PrepareSigned(context.Background(), "bootstrap-fixture", CoreHostSelection{Raw: raw, Signature: ed25519.Sign(private, raw)}, digest, "")
	if err != nil {
		t.Fatal(err)
	}
	file, err := m.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	for name, raw := range parts {
		if err := os.WriteFile(filepath.Join(filepath.Dir(file), name), raw, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.RegisterBootstrap(j.RequestID, digest, "/tmp/arbitrary-reader", ""); err == nil {
		t.Fatal("accepted unrelated executable")
	}
	for range 2 {
		if got, err := m.RegisterBootstrap(j.RequestID, digest, file, ""); err != nil || got != file {
			t.Fatal(got, err)
		}
	}
	retained := CoreManager{Root: m.Root}
	if got, err := retained.BootstrapExecutable(""); err != nil || got != file {
		t.Fatal(got, err)
	}
	if err := m.ForgetBootstrap(j.RequestID); err == nil {
		t.Fatal("retired unfinished coordinator")
	}
	for _, name := range []string{"youeye", "signature", "provenance"} {
		path := filepath.Join(filepath.Dir(file), name)
		if err := os.WriteFile(path, []byte("substituted"), 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := retained.BootstrapExecutable(""); err == nil {
			t.Fatalf("accepted changed %s", name)
		}
		if err := os.WriteFile(path, parts[name], 0700); err != nil {
			t.Fatal(err)
		}
	}
	previousLookup := coreTrustLookup
	t.Cleanup(func() { coreTrustLookup = previousLookup })
	coreTrustLookup = func(source, branch, scope string) (*updatetrust.Grant, error) {
		if scope == "spine" {
			return nil, fmt.Errorf("revoked")
		}
		return previousLookup(source, branch, scope)
	}
	if _, err := retained.BootstrapExecutable(""); err == nil {
		t.Fatal("accepted revoked original role")
	}
	coreTrustLookup = previousLookup
	j.Phase = "cancelled"
	if err := m.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	if err := m.ForgetBootstrap(j.RequestID); err != nil {
		t.Fatal(err)
	}
	if got, err := retained.BootstrapExecutable(""); err != nil || got != "" {
		t.Fatal(got, err)
	}
}
