package releasecache

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type distributionRT func(*http.Request) (*http.Response, error)

func (f distributionRT) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func distributionFixture(t *testing.T) (DistributionPolicy, DistributionCatalog, ed25519.PrivateKey) {
	t.Helper()
	t.Setenv("YOUEYE_DISTRIBUTION_STATE", t.TempDir())
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	now := time.Now().UTC()
	return DistributionPolicy{"youeye.distribution-policy.v1", "https://releases.example.test", map[string]string{"stable": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}}, DistributionCatalog{Schema: "youeye.distribution.v1", Channel: "stable", Sequence: 1, IssuedAt: now, ExpiresAt: now.Add(24 * time.Hour), Repositories: map[string]DistributionRepository{"YouEye": {Releases: []json.RawMessage{json.RawMessage(`{"tag_name":"appliance-v1.0.0","published_at":"2026-01-01T00:00:00Z","assets":[{"name":"image.iso","browser_download_url":"https://github.com/YouEye-Platform/YouEye/releases/download/appliance-v1.0.0/image.iso"}]}`)}}}}, key
}
func signDistribution(c DistributionCatalog, key ed25519.PrivateKey) []byte {
	b, _ := json.Marshal(c)
	out, _ := json.Marshal(DistributionEnvelope{base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))})
	return out
}
func TestDistributionRejectsCorruptionExpiryAndSourceChanges(t *testing.T) {
	p, c, k := distributionFixture(t)
	key := p.Keys["stable"]
	if _, _, e := VerifyDistribution(signDistribution(c, k), "stable", key, time.Now()); e != nil {
		t.Fatal(e)
	}
	for _, test := range []string{"expiry", "future", "channel", "source", "signature"} {
		t.Run(test, func(t *testing.T) {
			_, v, _ := distributionFixture(t)
			switch test {
			case "expiry":
				v.ExpiresAt = time.Now().Add(-time.Hour)
			case "future":
				v.IssuedAt = time.Now().Add(time.Hour)
			case "channel":
				v.Channel = "beta"
			case "source":
				v.Repositories["YouEye"] = DistributionRepository{Releases: []json.RawMessage{json.RawMessage(`{"tag_name":"appliance-v1.0.0","assets":[{"browser_download_url":"https://evil.example/payload"}]}`)}}
			}
			b := signDistribution(v, k)
			if test == "signature" {
				b[len(b)-8] ^= 1
			}
			if _, _, e := VerifyDistribution(b, "stable", key, time.Now()); e == nil {
				t.Fatal("invalid catalog accepted")
			}
		})
	}
}
func TestDistributionUsesNoGitHubAPIAndCachesPagination(t *testing.T) {
	p, c, k := distributionFixture(t)
	p.Origin = "https://pagination.example.test"
	calls := 0
	next := distributionRT(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "pagination.example.test" {
			t.Fatalf("GitHub API accessed: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(signDistribution(c, k))))}, nil
	})
	for _, q := range []string{"?per_page=100&page=1", "?per_page=50&page=2"} {
		b, ok, e := DistributionBytes(context.Background(), next, p, "https://api.github.com/repos/YouEye-Platform/YouEye/releases"+q)
		if e != nil || !ok {
			t.Fatalf("%v %v", ok, e)
		}
		if strings.Contains(q, "page=2") && string(b) != "[]" {
			t.Fatalf("invalid page %s", b)
		}
	}
	if calls != 1 {
		t.Fatalf("fetched catalog %d times", calls)
	}
}
func TestDistributionDoesNotInterceptCustomReposOrFallBack(t *testing.T) {
	p, _, _ := distributionFixture(t)
	p.Origin = "https://unavailable.example.test"
	next := distributionRT(func(r *http.Request) (*http.Response, error) { return nil, fmt.Errorf("offline") })
	_, ok, e := DistributionBytes(context.Background(), next, p, "https://api.github.com/repos/other/repo/releases")
	if ok || e != nil {
		t.Fatal("custom source intercepted")
	}
	_, ok, e = DistributionBytes(context.Background(), next, p, "https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	if !ok || e == nil {
		t.Fatal("distribution failure fell through")
	}
}

func TestDistributionRetainsRollbackWatermarkAcrossRestart(t *testing.T) {
	p, c, k := distributionFixture(t)
	c.Sequence = 2
	next := distributionRT(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(signDistribution(c, k))))}, nil
	})
	source := "https://api.github.com/repos/YouEye-Platform/YouEye/releases"
	if _, _, e := DistributionBytes(context.Background(), next, p, source); e != nil {
		t.Fatal(e)
	}
	distributionEntries = map[string]distributionEntry{}
	paths, e := filepath.Glob(filepath.Join(os.Getenv("YOUEYE_DISTRIBUTION_STATE"), "youeye-distribution/go/*.json"))
	if e != nil || len(paths) != 1 {
		t.Fatal("missing durable watermark", e)
	}
	earlier := time.Now().Add(-time.Hour)
	if e = os.Chtimes(paths[0], earlier, earlier); e != nil {
		t.Fatal(e)
	}
	c.Sequence = 1
	if _, _, e = DistributionBytes(context.Background(), next, p, source); e == nil || !strings.Contains(e.Error(), "rollback") {
		t.Fatal("rollback after restart accepted", e)
	}
}

func TestDistributionServiceWithoutHomeEnvironment(t *testing.T) {
	p, c, key := distributionFixture(t)
	p.Origin = "https://envless-service.example.test"
	t.Setenv("HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	calls := 0
	next := distributionRT(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "envless-service.example.test" {
			t.Fatalf("API fallback: %s", r.URL)
		}
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(signDistribution(c, key)))}, nil
	})
	data, handled, err := DistributionBytes(context.Background(), next, p, "https://api.github.com/repos/YouEye-Platform/YouEye/releases")
	if err != nil || !handled || calls != 1 || !bytes.Contains(data, []byte("appliance-v1.0.0")) {
		t.Fatalf("service discovery: %s %v %v calls=%d", data, handled, err, calls)
	}
	files, err := filepath.Glob(filepath.Join(os.Getenv("YOUEYE_DISTRIBUTION_STATE"), "youeye-distribution", "go", "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("durable override not used: %v %v", files, err)
	}
}

func TestDistributionServiceCacheUsesRegisteredHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("YOUEYE_DISTRIBUTION_STATE", "")
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	got, err := distributionCacheRoot()
	if err != nil || got != filepath.Join(account.HomeDir, ".cache") {
		t.Fatalf("service cache: %q %v", got, err)
	}
}
