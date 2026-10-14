package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
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
)

func TestCoreCacheRequiresCapacityAndCompleteScopedBytes(t *testing.T) {
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
	r.Source, r.SignerSHA256 = "https://forge.example/owner/YouEye", checksum(der)
	files := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		m.Source, m.KeyID = r.Source, r.SignerSHA256
		blob := func(name string, data []byte) releasecache.CoreBlob {
			b := releasecache.CoreBlob{Name: name, URL: m.Source + "/releases/download/" + m.Tag + "/" + m.Role + "-" + name, SHA256: checksum(data), SizeBytes: int64(len(data))}
			files[b.URL] = data
			return b
		}
		artifact := []byte(`{"fixture":"` + m.Role + `"}`)
		m.Artifact = blob(m.Role+".tar", artifact)
		m.SBOM = blob("sbom.json", []byte(`{"packages":[]}`))
		provenance := []byte(`{"fixture":true}`)
		if m.ReleaseLock != nil {
			lock := blob("release-lock.json", []byte(`{"lock":"exact"}`))
			m.ReleaseLock = &lock
			provenance = []byte(`{"resolved_lock_sha256":"` + lock.SHA256 + `"}`)
		}
		m.Provenance = blob("provenance.json", provenance)
		bound := []releasecache.CoreBlob{m.Artifact, m.SBOM, m.Provenance}
		if m.DocumentSignature != nil {
			sig := blob(m.Role+".tar.sig", ed25519.Sign(private, artifact))
			m.DocumentSignature = &sig
			bound = append(bound, sig)
		}
		checksums := ""
		for _, b := range bound {
			checksums += fmt.Sprintf("%s  %s\n", b.SHA256, b.Name)
		}
		m.Checksums = blob("SHA256SUMS", []byte(checksums))
		m.Signature = blob("SHA256SUMS.sig", ed25519.Sign(private, []byte(checksums)))
	}
	raw, _ = json.Marshal(r)
	selection := CoreHostSelection{Raw: raw, Signature: ed25519.Sign(private, raw)}
	root := t.TempDir()
	trust := filepath.Join(root, "key.pub")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	c := CoreArtifactCache{Root: filepath.Join(root, "cache"), TrustKeyPath: trust,
		AvailableBytes: func(string) (uint64, error) { return 1, nil },
		Client: &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			requests++
			data, ok := files[req.URL.String()]
			if !ok {
				return nil, fmt.Errorf("undeclared URL")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
		})},
	}
	if _, _, err := c.Stage(context.Background(), selection); err == nil || requests != 0 {
		t.Fatal("downloaded without complete capacity", requests, err)
	}
	// A true no-op uses already accepted installed identity and needs no download.
	if _, digest, err := c.StageUpdate(context.Background(), selection, r); err != nil || digest != checksum(raw) || requests != 0 {
		t.Fatal("no-op downloaded", digest, err, requests)
	}
	c.AvailableBytes = func(string) (uint64, error) { return 1 << 30, nil }
	serviceOnly := c
	serviceOnly.Root = filepath.Join(root, "service-only")
	serviceOnly.Client = &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		if !strings.Contains(req.URL.Path, "/cp-") {
			t.Fatal("service update fetched an unchanged role", req.URL.Path)
		}
		data, ok := files[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("undeclared service object")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	previous := r
	previous.Members = append([]releasecache.CoreMember(nil), r.Members...)
	for i := range previous.Members {
		if previous.Members[i].Role == "cp" {
			previous.Members[i].Artifact.SHA256 = strings.Repeat("a", 64)
		}
	}
	if _, _, err := serviceOnly.StageUpdate(context.Background(), selection, previous); err != nil {
		t.Fatal(err)
	}

	if _, digest, err := c.Stage(context.Background(), selection); err != nil || digest != checksum(raw) {
		t.Fatal(digest, err)
	}
	if requests >= len(files) {
		t.Fatal("identical blobs were not deduplicated", requests, len(files))
	}
	before := requests
	if _, _, err := c.Stage(context.Background(), selection); err != nil || requests != before {
		t.Fatal("exact protected cache was not reused", requests, before, err)
	}
	// Cache corruption cannot be accepted as a completed member or trigger a
	// moving lookup for a convenient replacement release.
	path, _ := c.Path(r.Members[0].Artifact)
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Stage(context.Background(), selection); err == nil || requests != before {
		t.Fatal("corrupt cache was accepted", requests, err)
	}
}
