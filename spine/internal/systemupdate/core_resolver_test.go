package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreResolverExactRawBranchSequenceAndFallback(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	base, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	key, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(key)
	oldSource := base.Source
	base.Source, base.SignerSHA256 = "https://forge.example/owner/YouEye", checksum(der)
	for i := range base.Members {
		m := &base.Members[i]
		m.Source, m.KeyID = base.Source, base.SignerSHA256
		for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
			if b != nil {
				b.URL = strings.Replace(b.URL, oldSource, base.Source, 1)
			}
		}
	}
	trust := filepath.Join(t.TempDir(), "key.pub")
	if err := os.WriteFile(trust, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	list := []release{}
	add := func(version, branch, channel string, seq uint64, published int64) string {
		r := base
		r.Version, r.Tag, r.Branch, r.Channel, r.Sequence = version, "youeye-v"+version, branch, channel, seq
		data, _ := json.Marshal(r)
		manifest := r.Source + "/releases/download/" + r.Tag + "/core-release.json"
		files[manifest], files[manifest+".sig"] = data, ed25519.Sign(private, data)
		list = append(list, release{TagName: r.Tag, PublishedAt: time.Unix(published, 0), Prerelease: channel != "stable", Assets: []releaseAsset{{Name: "core-release.json", BrowserDownloadURL: manifest}, {Name: "core-release.json.sig", BrowserDownloadURL: manifest + ".sig"}}})
		return checksum(data)
	}
	older := add("0.6.0-team-abcd.9", "Team/Fix", "feature", 1, 200)
	newer := add("0.6.0-team-abcd.10", "Team/Fix", "feature", 2, 100)
	add("0.5.38-alpha.1", "main", "alpha", 3, 300)
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		data := files[req.URL.String()]
		if strings.Contains(req.URL.Path, "/api/v1/repos/") {
			data, _ = json.Marshal(list)
			if req.URL.Query().Get("page") != "1" {
				data = []byte("[]")
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	selection := CoreReleaseSelection{Source: base.Source, Branch: "Team/Fix", Fallback: []string{"main"}}
	ctx := context.Background()
	_, r, digest, err := ResolveCoreRelease(ctx, client, selection, trust)
	if err != nil || digest != newer || r.Version != "0.6.0-team-abcd.10" {
		t.Fatal(r.Version, digest, err)
	}
	selection.Tag, selection.ManifestSHA256 = "youeye-v0.6.0-team-abcd.9", older
	if _, _, digest, err := ResolveCoreRelease(ctx, client, selection, trust); err != nil || digest != older {
		t.Fatal(digest, err)
	}
	selection.ManifestSHA256 = newer
	if _, _, _, err := ResolveCoreRelease(ctx, client, selection, trust); err == nil {
		t.Fatal("wrong exact digest accepted")
	}
	selection.Tag, selection.ManifestSHA256, selection.Branch, selection.Fallback = "", "", "team/fix", nil
	if _, _, _, err := ResolveCoreRelease(ctx, client, selection, trust); !errors.Is(err, ErrNoCoreRelease) {
		t.Fatal("raw branch was case-folded", err)
	}
	selection.Fallback = []string{"main"}
	if _, r, _, err := ResolveCoreRelease(ctx, client, selection, trust); err != nil || r.Branch != "main" {
		t.Fatal(r.Branch, err)
	}

	t.Run("installed snapshot cannot freeze later discovery", func(t *testing.T) {
		root := t.TempDir()
		t.Setenv("YOUEYE_RELEASE_CACHE", root)
		if err := os.Mkdir(filepath.Join(root, "objects"), 0700); err != nil {
			t.Fatal(err)
		}
		objects := map[string]releasecache.Object{}
		cache := func(source string, data []byte) {
			t.Helper()
			hash := checksum(data)
			if err := os.WriteFile(filepath.Join(root, "objects", hash), data, 0400); err != nil {
				t.Fatal(err)
			}
			objects[source] = releasecache.Object{SHA256: hash, Bytes: int64(len(data))}
		}
		api := "https://forge.example/api/v1/repos/owner/YouEye/releases"
		stale, _ := json.Marshal(list[:1])
		cache(api+"?limit=50&page=1", stale)
		cache(api+"?limit=50&page=2", []byte("[]"))
		for _, asset := range list[0].Assets {
			cache(asset.BrowserDownloadURL, files[asset.BrowserDownloadURL])
		}
		index, _ := json.Marshal(releasecache.Index{Schema: "youeye.release-cache.v1", Objects: objects})
		if err := os.WriteFile(filepath.Join(root, "index.json"), index, 0400); err != nil {
			t.Fatal(err)
		}
		unavailable, calls := false, 0
		wrapped := &http.Client{Transport: releasecache.Wrap(signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			calls++
			if unavailable {
				return nil, fmt.Errorf("isolated provider unavailable")
			}
			return client.Transport.RoundTrip(req)
		}))}
		track := CoreReleaseSelection{Source: base.Source, Branch: "Team/Fix"}
		if _, _, digest, err := ResolveCoreRelease(ctx, wrapped, track, trust); err != nil || digest != newer {
			t.Fatalf("track stayed on frozen installation: %s %v", digest, err)
		}
		pin := track
		pin.Tag, pin.ManifestSHA256 = list[1].TagName, newer
		if _, _, digest, err := ResolveCoreRelease(ctx, wrapped, pin, trust); err != nil || digest != newer {
			t.Fatalf("later exact pin hidden by installation cache: %s %v", digest, err)
		}
		unavailable = true
		if _, _, _, err := ResolveCoreRelease(ctx, wrapped, track, trust); err == nil {
			t.Fatal("track fell back to stale metadata when provider failed")
		}
		if _, _, _, err := ResolveCoreRelease(ctx, wrapped, pin, trust); err == nil {
			t.Fatal("missing exact pin fell back to installed candidate")
		}
		pin.Tag, pin.ManifestSHA256 = list[0].TagName, older
		before := calls
		if _, _, digest, err := ResolveCoreRelease(ctx, wrapped, pin, trust); err != nil || digest != older || calls != before {
			t.Fatalf("protected unpublished exact candidate lost: %s %v network=%d", digest, err, calls-before)
		}
		pin.ManifestSHA256 = newer
		if _, _, _, err := ResolveCoreRelease(ctx, wrapped, pin, trust); err == nil {
			t.Fatal("cached exact candidate accepted wrong manifest digest")
		}
	})
	selection.Branch = "Team/Fix"
	add("0.6.0-team-abcd.11", "Team/Fix", "feature", 2, 400)
	if _, _, _, err := ResolveCoreRelease(ctx, client, selection, trust); err == nil {
		t.Fatal("conflicting signed sequence selected")
	}
}
