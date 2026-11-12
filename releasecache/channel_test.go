package releasecache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// noAPI fails any request to a release-listing API: boxes never use one.
type noAPI struct {
	t    *testing.T
	next http.RoundTripper
}

func (n noAPI) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == "api.github.com" || strings.Contains(r.URL.Path, "/api/v1/repos/") {
		n.t.Fatalf("release API called: %s", r.URL)
	}
	return n.next.RoundTrip(r)
}

// serve routes https://<host>/<path> requests to handler, keyed by host+path.
func serve(t *testing.T, files map[string]string, status map[string]int) *http.Client {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Host + r.URL.EscapedPath()
		if code, ok := status[key]; ok {
			w.WriteHeader(code)
			return
		}
		body, ok := files[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	target := server.Listener.Addr().String()
	inner := server.Client().Transport.(*http.Transport)
	rewrite := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		clone.Host = r.URL.Host
		clone.URL.Host = target
		return inner.RoundTrip(clone)
	})
	return &http.Client{Transport: noAPI{t: t, next: rewrite}}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func index(channel string, entries string) string {
	return `{"schema":"youeye.channel.v1","channel":"` + channel + `","published_at":"2026-11-12T10:00:00Z","products":{` + entries + `}}`
}

func TestFetchCoreReleaseThroughIndex(t *testing.T) {
	raw := fixture(t)
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	repo := "https://forge.example.test/owner/YouEye"
	entry := `"youeye":{"repository":"` + repo + `","tag":"youeye-v0.6.1-rc.1","version":"0.6.1-rc.1","document":"core-release.json","sha256":"` + digest + `"}`
	client := serve(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":               index("dev", entry),
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.1-rc.1/core-release.json": string(raw),
	}, nil)
	_, release, got, err := FetchCoreRelease(context.Background(), client, repo, "dev")
	if err != nil || got != digest || release.Version != "0.6.1-rc.1" {
		t.Fatalf("resolve: %v %s", err, got)
	}
	// A document that differs from the index digest is refused.
	client = serve(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":               index("dev", entry),
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.1-rc.1/core-release.json": string(raw) + " ",
	}, nil)
	if _, _, _, err := FetchCoreRelease(context.Background(), client, repo, "dev"); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("tampered document accepted: %v", err)
	}
	// An index for another channel is refused.
	client = serve(t, map[string]string{"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json": index("alpha", entry)}, nil)
	if _, _, _, err := FetchCoreRelease(context.Background(), client, repo, "dev"); err == nil {
		t.Fatal("index of another channel accepted")
	}
}

func TestOfficialStableTriesReleasesHostFirst(t *testing.T) {
	urls := ChannelIndexURLs(OfficialRepository, "stable")
	if len(urls) != 2 || urls[0] != "https://releases.youeye.me/v1/channels/stable.json" || urls[1] != OfficialRepository+"/releases/download/channel-stable/index.json" {
		t.Fatalf("unexpected index locations %v", urls)
	}
	if urls := ChannelIndexURLs(OfficialRepository, "dev"); len(urls) != 1 {
		t.Fatalf("dev has no releases.youeye.me copy: %v", urls)
	}
	if urls := ChannelIndexURLs("https://forge.example.test/o/YouEye", "stable"); len(urls) != 1 {
		t.Fatalf("other repositories never use releases.youeye.me: %v", urls)
	}
	// The releases host is down; the repository copy is used.
	client := serve(t, map[string]string{
		"github.com/YouEye-Platform/YouEye/releases/download/channel-stable/index.json": index("stable", ""),
	}, map[string]int{"releases.youeye.me/v1/channels/stable.json": 503})
	if _, _, err := FetchChannelIndex(context.Background(), client, OfficialRepository, "stable"); err != nil {
		t.Fatal(err)
	}
}

func TestRateLimitIsClassified(t *testing.T) {
	for _, code := range []int{403, 429} {
		client := serve(t, nil, map[string]int{"forge.example.test/o/YouEye/releases/download/channel-dev/index.json": code})
		_, _, err := FetchChannelIndex(context.Background(), client, "https://forge.example.test/o/YouEye", "dev")
		if !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "rate-limited") {
			t.Fatalf("HTTP %d: %v", code, err)
		}
	}
	client := serve(t, nil, nil)
	if _, _, err := FetchChannelIndex(context.Background(), client, "https://forge.example.test/o/YouEye", "dev"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("404: %v", err)
	}
}

func TestChannelIndexValidation(t *testing.T) {
	bad := []string{
		index("nightly", ""),
		index("dev", `"other":{"repository":"https://a.test/o/r","tag":"v1.0.0-rc.1","version":"1.0.0-rc.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`),
		index("dev", `"notes":{"repository":"https://a.test/o/r","tag":"dev-v1.0.0-rc.1","version":"1.0.0-rc.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`),
		index("dev", `"market":{"repository":"https://a.test/o/r","tag":"v1.0.0-rc.1","version":"1.0.0-rc.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`),
		index("dev", `"notes":{"repository":"http://a.test/o/r","tag":"v1.0.0-rc.1","version":"1.0.0-rc.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`),
		`{"schema":"youeye.channel.v1","channel":"dev","published_at":"2026-11-12T10:00:00Z","products":{},"extra":1}`,
	}
	for i, raw := range bad {
		if _, err := ParseChannelIndex([]byte(raw)); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	good := index("beta", `"notes":{"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.1-rc.2","version":"0.6.1-rc.2","document":"product-release.json","sha256":"`+strings.Repeat("b", 64)+`"},"market":{"repository":"https://github.com/YouEye-Platform/YE-AppMarket","tag":"catalog-v0.6.1-rc.1","version":"0.6.1-rc.1","document":"product-release.json","sha256":"`+strings.Repeat("c", 64)+`"}`)
	if _, err := ParseChannelIndex([]byte(good)); err != nil {
		t.Fatal(err)
	}
}
