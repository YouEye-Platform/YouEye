package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// indexHost serves the channel index at /a (the first address) and /b (the second), each by its own function, and
// records the If-None-Match of every request.
type indexHost struct {
	mu       sync.Mutex
	base     string
	serve    map[string]func(w http.ResponseWriter, ifNoneMatch string)
	requests []string // "<path> <If-None-Match>"
}

func (h *indexHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.requests = append(h.requests, r.URL.Path+" "+r.Header.Get("If-None-Match"))
	serve := h.serve[r.URL.Path]
	h.mu.Unlock()
	if r.Header.Get("User-Agent") != "youeye" {
		http.Error(w, "no user agent", http.StatusBadRequest)
		return
	}
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

// The release index answer goes through the real conditional fetch, against two addresses of a local host.
func conditionalIndexServer(t *testing.T) (*Server, *indexHost, func() map[string]any) {
	t.Helper()
	s := releaseTestServer(t)
	host := &indexHost{serve: map[string]func(http.ResponseWriter, string){}}
	server := httptest.NewServer(host)
	t.Cleanup(server.Close)
	host.base = server.URL
	old := fetchChannelIndex
	fetchChannelIndex = func(r *http.Request, _, channel string, known map[string]channelIndexCopy) (string, channelIndexCopy, error) {
		return fetchChannelIndexConditional(r.Context(), server.Client(), []string{server.URL + "/a", server.URL + "/b"}, channel, known)
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
	host.set("/a", withETag(first, `"a1"`))

	// First fetch: no If-None-Match; the ETag is kept for /a.
	body := get()
	if body["status"] != 200 || body["index_sha256"] != digestOf(first) {
		t.Fatal(body)
	}
	checkRequests(t, host, "/a ")
	if lifetime := s.releaseIndex.expires.Sub(s.releaseIndex.fetched); lifetime < releaseIndexTTL || lifetime > releaseIndexTTL*11/10 {
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
	checkRequests(t, host, `/a "a1"`)
	if !s.releaseIndex.fetched.After(fetchedBefore) || !s.releaseIndex.expires.After(time.Now().Add(releaseIndexTTL-time.Second)) || s.releaseIndex.lastErr != nil {
		t.Fatalf("a 304 did not count as a refresh: fetched %v expires %v err %v", s.releaseIndex.fetched, s.releaseIndex.expires, s.releaseIndex.lastErr)
	}
	get()
	checkRequests(t, host)

	// A changed index replaces the copy and its ETag.
	second := indexBody("stable", "2026-11-18T11:00:00Z")
	host.set("/a", withETag(second, `"a2"`))
	expire(s)
	if body = get(); body["index_sha256"] != digestOf(second) || body["index"].(map[string]any)["published_at"] != "2026-11-18T11:00:00Z" {
		t.Fatal(body)
	}
	checkRequests(t, host, `/a "a1"`)
	if s.releaseIndex.copies[host.base+"/a"].ETag != `"a2"` {
		t.Fatalf("copies: %+v", s.releaseIndex.copies)
	}

	// The first address refuses: the second is asked, without an ETag the first time, with its own one after.
	third := indexBody("stable", "2026-11-18T12:00:00Z")
	host.set("/a", status(http.StatusTooManyRequests))
	host.set("/b", withETag(third, `"b1"`))
	expire(s)
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(third) {
		t.Fatal(body)
	}
	checkRequests(t, host, `/a "a2"`, "/b ")
	expire(s)
	if body = get(); body["index_sha256"] != digestOf(third) {
		t.Fatal(body)
	}
	checkRequests(t, host, `/a "a2"`, `/b "b1"`)
	if a, b := s.releaseIndex.copies[host.base+"/a"], s.releaseIndex.copies[host.base+"/b"]; a.ETag != `"a2"` || a.Digest != digestOf(second) || b.ETag != `"b1"` || b.Digest != digestOf(third) {
		t.Fatalf("copies: %+v", s.releaseIndex.copies)
	}

	// Both fail: the last good index is answered, the error is remembered and the host is left alone meanwhile.
	host.set("/b", status(http.StatusNotFound))
	expire(s)
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(third) {
		t.Fatal(body)
	}
	checkRequests(t, host, `/a "a2"`, `/b "b1"`)
	if !errors.Is(s.releaseIndex.lastErr, releasecache.ErrNotFound) || s.releaseIndex.failures != 1 || !s.releaseIndex.retry.After(time.Now()) {
		t.Fatalf("failure not remembered: %v %d %v", s.releaseIndex.lastErr, s.releaseIndex.failures, s.releaseIndex.retry)
	}
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(third) {
		t.Fatal(body)
	}
	checkRequests(t, host)

	// After the back-off a 304 from the first address answers that address's copy and clears the failure.
	host.set("/a", withETag(second, `"a2"`))
	s.releaseIndex.retry = time.Time{}
	if body = get(); body["index_sha256"] != digestOf(second) || s.releaseIndex.failures != 0 || s.releaseIndex.lastErr != nil {
		t.Fatal(body, s.releaseIndex.failures, s.releaseIndex.lastErr)
	}
	checkRequests(t, host, `/a "a2"`)

	// A channel change forgets the copies: nothing is sent conditionally for another channel.
	w := httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPut, "/api/releases/channel", strings.NewReader(`{"channel":"beta"}`)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	beta := indexBody("beta", "2026-11-18T13:00:00Z")
	host.set("/a", withETag(beta, `"a2"`))
	if body = get(); body["status"] != 200 || body["index_sha256"] != digestOf(beta) {
		t.Fatal(body)
	}
	checkRequests(t, host, "/a ")
}

func TestFetchChannelIndexConditionalErrors(t *testing.T) {
	host := &indexHost{serve: map[string]func(http.ResponseWriter, string){}}
	server := httptest.NewServer(host)
	defer server.Close()
	targets := []string{server.URL + "/a", server.URL + "/b"}
	fetch := func(known map[string]channelIndexCopy) (string, channelIndexCopy, error) {
		return fetchChannelIndexConditional(context.Background(), server.Client(), targets, "stable", known)
	}

	// An index for another channel, then one too large: both invalid, classified as releasecache does.
	host.set("/a", withETag(indexBody("beta", "2026-11-18T10:00:00Z"), `"x"`))
	host.set("/b", func(w http.ResponseWriter, _ string) {
		_, _ = w.Write([]byte(strings.Repeat(" ", channelIndexLimit+1)))
	})
	if _, _, err := fetch(nil); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("too large: %v", err)
	}
	host.set("/b", withETag("{not json", `"y"`))
	if _, _, err := fetch(nil); !errors.Is(err, releasecache.ErrInvalidIndex) {
		t.Fatalf("invalid: %v", err)
	}
	// A rate limit at the first address and an invalid index at the second: the last error is answered.
	host.set("/a", status(http.StatusForbidden))
	if _, _, err := fetch(nil); !errors.Is(err, releasecache.ErrInvalidIndex) {
		t.Fatalf("last error: %v", err)
	}
	// Rate limited everywhere.
	host.set("/b", status(http.StatusTooManyRequests))
	if _, _, err := fetch(nil); !errors.Is(err, releasecache.ErrRateLimited) {
		t.Fatalf("rate limited: %v", err)
	}
	// A 304 the box did not ask for is not an answer.
	host.set("/a", status(http.StatusNotModified))
	host.set("/b", status(http.StatusNotModified))
	if _, _, err := fetch(nil); err == nil || !strings.Contains(err.Error(), "HTTP 304") {
		t.Fatalf("unasked 304: %v", err)
	}
	// An unknown channel asks nothing.
	host.take()
	if _, _, err := fetchChannelIndexConditional(context.Background(), server.Client(), targets, "main", nil); err == nil {
		t.Fatal("unknown channel accepted")
	}
	if len(host.take()) != 0 {
		t.Fatal("an unknown channel was fetched")
	}
}

func TestReleaseIndexExpiryJitter(t *testing.T) {
	old := releaseIndexRand
	t.Cleanup(func() { releaseIndexRand = old })
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	releaseIndexRand = func() float64 { return 0 }
	if got := releaseIndexExpiry(now).Sub(now); got != releaseIndexTTL {
		t.Fatalf("no jitter: %v", got)
	}
	releaseIndexRand = func() float64 { return 0.999999 }
	if got := releaseIndexExpiry(now).Sub(now); got <= releaseIndexTTL || got > 5*time.Minute+30*time.Second {
		t.Fatalf("most jitter: %v", got)
	}
	releaseIndexRand = old
	spread := map[time.Duration]bool{}
	for range 200 {
		got := releaseIndexExpiry(now).Sub(now)
		if got < 5*time.Minute || got > 5*time.Minute+30*time.Second {
			t.Fatalf("expiry %v outside [5m, 5m30s]", got)
		}
		spread[got] = true
	}
	if len(spread) < 2 {
		t.Fatal("the expiry does not vary")
	}
}
