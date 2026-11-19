package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// indexHost serves each channel's index at /<channel> by its own function and
// records the If-None-Match of every request.
type indexHost struct {
	mu       sync.Mutex
	serve    map[string]func(w http.ResponseWriter, ifNoneMatch string)
	requests []string // "<path> <If-None-Match>"
}

func (h *indexHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.requests = append(h.requests, r.URL.Path+" "+r.Header.Get("If-None-Match"))
	serve := h.serve[r.URL.Path]
	h.mu.Unlock()
	if serve == nil {
		http.NotFound(w, r)
		return
	}
	serve(w, r.Header.Get("If-None-Match"))
}

func (h *indexHost) set(path string, serve func(w http.ResponseWriter, ifNoneMatch string)) {
	h.mu.Lock()
	h.serve[path] = serve
	h.mu.Unlock()
}

func (h *indexHost) take() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	requests := h.requests
	h.requests = nil
	return requests
}

func indexBody(channel, publishedAt string) string {
	return fmt.Sprintf(`{"schema":%q,"channel":%q,"published_at":%q,"products":{}}`, releasecache.ChannelIndexSchema, channel, publishedAt)
}

// withETag answers body with etag, or 304 when the request already names etag.
func withETag(body, etag string) func(http.ResponseWriter, string) {
	return func(w http.ResponseWriter, ifNoneMatch string) {
		w.Header().Set("ETag", etag)
		if ifNoneMatch == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(body))
	}
}

func status(code int) func(http.ResponseWriter, string) {
	return func(w http.ResponseWriter, _ string) { w.WriteHeader(code) }
}

func digestOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// The release index answer goes through releasecache's real conditional
// fetch: each channel's index address is sent to /<channel> on a local host.
func conditionalIndexServer(t *testing.T) (*Server, *indexHost, func() map[string]any) {
	t.Helper()
	s := releaseTestServer(t)
	host := &indexHost{serve: map[string]func(http.ResponseWriter, string){}}
	server := httptest.NewServer(host)
	t.Cleanup(server.Close)
	// releasecache keeps a copy per address for the whole process: a
	// repository of this test alone starts without one.
	repository := fmt.Sprintf("https://forge.example/t%d/YouEye", time.Now().UnixNano())
	paths := map[string]string{}
	for _, channel := range releasecache.Channels {
		for _, address := range releasecache.ChannelIndexURLs(repository, channel) {
			paths[address] = "/" + channel
		}
	}
	client := &http.Client{Transport: roundTripper(func(r *http.Request) (*http.Response, error) {
		path, ok := paths[r.URL.String()]
		if !ok {
			return nil, fmt.Errorf("unexpected address %s", r.URL)
		}
		r = r.Clone(r.Context())
		r.URL, _ = url.Parse(server.URL + path)
		r.Host = r.URL.Host
		return http.DefaultTransport.RoundTrip(r)
	})}
	old := fetchChannelIndex
	fetchChannelIndex = func(r *http.Request, _, channel string) (releasecache.ChannelIndex, []byte, error) {
		return releasecache.FetchChannelIndex(r.Context(), client, repository, channel)
	}
	t.Cleanup(func() { fetchChannelIndex = old })
	get := func() map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		s.handleReleaseIndex(w, httptest.NewRequest(http.MethodGet, "/api/releases/index", nil))
		body := decodeBody(t, w)
		body["status"] = w.Code
		return body
	}
	return s, host, get
}

func expire(s *Server) {
	s.releaseIndex.expires = time.Now().Add(-time.Second)
}

func checkRequests(t *testing.T, host *indexHost, want ...string) {
	t.Helper()
	got := host.take()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests %q, want %q", got, want)
	}
}

func TestReleaseIndexConditionalFetch(t *testing.T) {
	s, host, get := conditionalIndexServer(t)
	first := indexBody("stable", "2026-11-18T10:00:00Z")
	host.set("/stable", withETag(first, `"a1"`))

	// First fetch: not conditional. The index is kept for the TTL plus 0-10 %.
	body := get()
	if body["status"] != 200 || body["index_sha256"] != digestOf(first) {
		t.Fatal(body)
	}
	checkRequests(t, host, "/stable ")
	if lifetime := s.releaseIndex.expires.Sub(s.releaseIndex.fetched); lifetime < releasecache.ChannelIndexTTL || lifetime > releasecache.ChannelIndexTTL*11/10 {
		t.Fatalf("expiry %v after the fetch", lifetime)
	}
	// Within the TTL nothing is asked.
	get()
	checkRequests(t, host)

	// 304: the index stays, the timer starts again, the failure count is clear.
	fetchedBefore := s.releaseIndex.fetched
	expire(s)
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(first) {
		t.Fatal(body)
	}
	checkRequests(t, host, `/stable "a1"`)
	if !s.releaseIndex.fetched.After(fetchedBefore) || !s.releaseIndex.expires.After(time.Now().Add(releasecache.ChannelIndexTTL-time.Second)) || s.releaseIndex.lastErr != nil {
		t.Fatalf("a 304 did not count as a refresh: fetched %v expires %v err %v", s.releaseIndex.fetched, s.releaseIndex.expires, s.releaseIndex.lastErr)
	}
	get()
	checkRequests(t, host)

	// A changed index replaces the answer.
	second := indexBody("stable", "2026-11-18T11:00:00Z")
	host.set("/stable", withETag(second, `"a2"`))
	expire(s)
	if body = get(); body["index_sha256"] != digestOf(second) || body["index"].(map[string]any)["published_at"] != "2026-11-18T11:00:00Z" {
		t.Fatal(body)
	}
	checkRequests(t, host, `/stable "a1"`)

	// The host fails: the last good index is answered, the error is remembered and the host is left alone meanwhile.
	host.set("/stable", status(http.StatusNotFound))
	expire(s)
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(second) {
		t.Fatal(body)
	}
	checkRequests(t, host, `/stable "a2"`)
	if !errors.Is(s.releaseIndex.lastErr, releasecache.ErrNotFound) || s.releaseIndex.failures != 1 || !s.releaseIndex.retry.After(time.Now()) {
		t.Fatalf("failure not remembered: %v %d %v", s.releaseIndex.lastErr, s.releaseIndex.failures, s.releaseIndex.retry)
	}
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(second) {
		t.Fatal(body)
	}
	checkRequests(t, host)

	// After the back-off a 304 answers the kept copy and clears the failure.
	host.set("/stable", withETag(second, `"a2"`))
	s.releaseIndex.retry = time.Time{}
	if body = get(); body["index_sha256"] != digestOf(second) || s.releaseIndex.failures != 0 || s.releaseIndex.lastErr != nil {
		t.Fatal(body, s.releaseIndex.failures, s.releaseIndex.lastErr)
	}
	checkRequests(t, host, `/stable "a2"`)

	// A channel change asks the other channel's address at once, not conditionally the first time.
	w := httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPut, "/api/releases/channel", strings.NewReader(`{"channel":"beta"}`)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	beta := indexBody("beta", "2026-11-18T13:00:00Z")
	host.set("/beta", withETag(beta, `"a2"`))
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(beta) {
		t.Fatal(body)
	}
	checkRequests(t, host, "/beta ")
}

func TestReleaseIndexErrorBeforeAnyIndex(t *testing.T) {
	s, host, get := conditionalIndexServer(t)
	host.set("/stable", status(http.StatusTooManyRequests))
	if body := get(); body["status"] != http.StatusBadGateway || body["code"] != "rate_limited" {
		t.Fatal(body)
	}
	checkRequests(t, host, "/stable ")
	// Backing off: answered from the remembered error without asking.
	if body := get(); body["status"] != http.StatusBadGateway || body["code"] != "rate_limited" {
		t.Fatal(body)
	}
	checkRequests(t, host)
	if s.releaseIndex.failures != 1 {
		t.Fatal(s.releaseIndex.failures)
	}
}
