package systemupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/updatetrust"
)

func coreReaderFixture(t *testing.T) (CoreManager, string, string) {
	t.Helper()
	m, _, target := coreJournalFixture(t)
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	previousTrust := publicReleaseTrustJSON
	publicReleaseTrustJSON, _ = json.Marshal(map[string]any{"schema": "youeye.public-trust.v1", "keys": map[string]string{"stable": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}})
	t.Cleanup(func() { publicReleaseTrustJSON = previousTrust })
	target.SignerSHA256 = checksum(der)
	for i := range target.Members {
		target.Members[i].KeyID = target.SignerSHA256
	}
	parts := map[string][]byte{"youeye": []byte("original signed Stable reader"), "provenance": []byte(`{"fixture":"original provenance"}`), "sbom": []byte("original sbom")}
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
	parts["core-release.json"] = raw
	parts["core-release.json.sig"] = ed25519.Sign(private, raw)
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
	return m, file, digest
}

func coreReaderTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[path] = checksum(raw)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCoreReaderVerificationLeavesTransactionAndBootstrapAbsent(t *testing.T) {
	m, file, digest := coreReaderFixture(t)
	before := coreReaderTree(t, m.Root)
	for range 2 {
		if err := m.VerifyBootstrapReader(file, digest, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Read(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reader verification created a transaction: %v", err)
	}
	if _, err := m.readBootstrap(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reader verification registered a coordinator: %v", err)
	}
	if after := coreReaderTree(t, m.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("reader verification changed protected state")
	}
	if err := m.VerifyBootstrapReader(file, strings.Repeat("f", 64), ""); err == nil {
		t.Fatal("accepted a different reviewed manifest")
	}
	if err := m.VerifyBootstrapReader(filepath.Join(t.TempDir(), "youeye"), digest, ""); err == nil {
		t.Fatal("accepted an unrelated reader path")
	}
}

func TestCoreReaderRejectsChangedSignedInputsAndUnsafePaths(t *testing.T) {
	for _, name := range []string{"youeye", "signature", "provenance", "core-release.json", "core-release.json.sig"} {
		t.Run(name, func(t *testing.T) {
			m, file, digest := coreReaderFixture(t)
			if err := os.WriteFile(filepath.Join(filepath.Dir(file), name), []byte("changed bytes"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := m.VerifyBootstrapReader(file, digest, ""); err == nil {
				t.Fatal("accepted changed signed input")
			}
		})
	}
	t.Run("writable directory", func(t *testing.T) {
		m, file, digest := coreReaderFixture(t)
		if err := os.Chmod(filepath.Dir(file), 0777); err != nil {
			t.Fatal(err)
		}
		if err := m.VerifyBootstrapReader(file, digest, ""); err == nil {
			t.Fatal("accepted a writable envelope directory")
		}
	})
	t.Run("symlink directory", func(t *testing.T) {
		m, file, digest := coreReaderFixture(t)
		directory := filepath.Dir(file)
		if err := os.Rename(directory, directory+"-elsewhere"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(directory+"-elsewhere", directory); err != nil {
			t.Fatal(err)
		}
		if err := m.VerifyBootstrapReader(file, digest, ""); err == nil {
			t.Fatal("accepted a symlink envelope directory")
		}
	})
}

func TestCoreReaderRechecksOwnerRevocation(t *testing.T) {
	for _, scope := range []string{"appliance", "spine"} {
		t.Run(scope, func(t *testing.T) {
			m, file, digest := coreReaderFixture(t)
			if err := m.VerifyBootstrapReader(file, digest, ""); err != nil {
				t.Fatal(err)
			}
			previousLookup := coreTrustLookup
			t.Cleanup(func() { coreTrustLookup = previousLookup })
			coreTrustLookup = func(source, branch, wanted string) (*updatetrust.Grant, error) {
				if wanted == scope {
					return nil, fmt.Errorf("revoked")
				}
				return previousLookup(source, branch, wanted)
			}
			if err := m.VerifyBootstrapReader(file, digest, ""); err == nil {
				t.Fatal("accepted newly revoked reader authority")
			}
		})
	}
}
