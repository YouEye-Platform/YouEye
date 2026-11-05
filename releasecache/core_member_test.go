package releasecache

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"io"
	"testing"
)

func TestCoreMemberRequiresRoleAuthorityAndOriginalSignedNames(t *testing.T) {
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	hash := sha256.Sum256(der)
	member := coreFixture().Members[12]
	member.KeyID = hex.EncodeToString(hash[:])
	files := map[string][]byte{}
	blob := func(name string, raw []byte) CoreBlob {
		h := sha256.Sum256(raw)
		b := CoreBlob{Name: name, URL: member.Source + "/releases/download/" + member.Tag + "/cp-" + name, SHA256: hex.EncodeToString(h[:]), SizeBytes: int64(len(raw))}
		files[b.URL] = raw
		return b
	}
	member.Artifact = blob("standalone.tar", []byte("exact payload"))
	member.Provenance = blob("provenance.json", []byte(`{"source_commit":"fixture"}`))
	member.SBOM = blob("sbom.spdx.json", []byte(`{"packages":[]}`))
	checksums := []byte(fmt.Sprintf("%s  %s\n%s  %s\n%s  %s\n", member.Artifact.SHA256, member.Artifact.Name, member.Provenance.SHA256, member.Provenance.Name, member.SBOM.SHA256, member.SBOM.Name))
	member.Checksums = blob("SHA256SUMS", checksums)
	member.Signature = blob("SHA256SUMS.sig", ed25519.Sign(private, checksums))
	open := func(b CoreBlob) (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(files[b.URL])), nil }
	if err := VerifyCoreMember(member, key, open); err != nil {
		t.Fatal(err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := VerifyCoreMember(member, other, open); err == nil {
		t.Fatal("assembly/foreign key became role authority")
	}
	changed := member
	changed.Artifact.Name = "cp-standalone.tar"
	if err := VerifyCoreMember(changed, key, open); err == nil {
		t.Fatal("remote alias rewrote signed checksum name")
	}
	files[member.Artifact.URL] = append(files[member.Artifact.URL], byte('!'))
	if err := VerifyCoreMember(member, key, open); err == nil {
		t.Fatal("accepted trailing payload")
	}
	files[member.Artifact.URL] = []byte("wrong payload")
	if err := VerifyCoreMember(member, key, open); err == nil {
		t.Fatal("accepted wrong payload digest")
	}
	files[member.Artifact.URL] = []byte("exact payload")
	files[member.Signature.URL][0] ^= 1
	if err := VerifyCoreMember(member, key, open); err == nil {
		t.Fatal("accepted changed signature")
	}
}
