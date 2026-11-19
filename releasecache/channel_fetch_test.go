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
	"sync"
	"testing"
	"time"
)

// indexHost serves the channel index at /a (the first address) and /b (the
// second), each by its own function, and records the If-None-Match of every
// request.
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
	return fmt.Sprintf(`{"schema":%q,"channel":%q,"published_at":%q,"products":{}}`, ChannelIndexSchema, channel, publishedAt)
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

func answerStatus(code int) func(http.ResponseWriter, string) {
	return func(w http.ResponseWriter, _ string) { w.WriteHeader(code) }
}

func digestOf(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func newIndexHost(t *testing.T) (*indexHost, []string, func(channel string) (ChannelIndex, []byte, error)) {
	t.Helper()
	host := &indexHost{serve: map[string]func(http.ResponseWriter, string){}}
	server := httptest.NewServer(host)
	t.Cleanup(server.Close)
	targets := []string{server.URL + "/a", server.URL + "/b"}
	t.Cleanup(func() {
		for _, target := range targets {
			keepIndexCopy(target, indexCopy{})
		}
	})
	return host, targets, func(channel string) (ChannelIndex, []byte, error) {
		return fetchChannelIndexFrom(context.Background(), server.Client(), targets, channel)
	}
}

func checkRequests(t *testing.T, host *indexHost, want ...string) {
	t.Helper()
	got := host.take()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests %q, want %q", got, want)
	}
}

// Every reader of a channel index (Spine's API, the update check through
// ChooseCoreRelease) asks each address "changed since?" with the ETag of the
// copy it last served, and takes a 304 as that copy.
func TestFetchChannelIndexConditional(t *testing.T) {
	host, targets, fetch := newIndexHost(t)
	first := indexBody("stable", "2026-11-18T10:00:00Z")
	host.set("/a", withETag(first, `"a1"`))

	// First fetch: no If-None-Match; the ETag is kept for /a.
	index, raw, err := fetch("stable")
	if err != nil || string(raw) != first || index.PublishedAt != "2026-11-18T10:00:00Z" {
		t.Fatal(index, err)
	}
	checkRequests(t, host, "/a ")

	// 304: the kept copy, parsed again (the caller gets its own maps).
	index.Products["x"] = ChannelEntry{}
	again, raw, err := fetch("stable")
	if err != nil || string(raw) != first || len(again.Products) != 0 {
		t.Fatal(again, err)
	}
	checkRequests(t, host, `/a "a1"`)

	// A changed index replaces the copy and its ETag.
	second := indexBody("stable", "2026-11-18T11:00:00Z")
	host.set("/a", withETag(second, `"a2"`))
	if _, raw, err = fetch("stable"); err != nil || string(raw) != second {
		t.Fatal(err)
	}
	checkRequests(t, host, `/a "a1"`)
	if c := knownIndexCopy(targets[0]); c.etag != `"a2"` || string(c.raw) != second {
		t.Fatalf("kept %+v", c)
	}

	// The first address refuses: the second is asked, without an ETag the first time, with its own one after.
	third := indexBody("stable", "2026-11-18T12:00:00Z")
	host.set("/a", answerStatus(http.StatusTooManyRequests))
	host.set("/b", withETag(third, `"b1"`))
	if _, raw, err = fetch("stable"); err != nil || string(raw) != third {
		t.Fatal(err)
	}
	checkRequests(t, host, `/a "a2"`, "/b ")
	if _, raw, err = fetch("stable"); err != nil || string(raw) != third {
		t.Fatal(err)
	}
	checkRequests(t, host, `/a "a2"`, `/b "b1"`)
	if a, b := knownIndexCopy(targets[0]), knownIndexCopy(targets[1]); a.etag != `"a2"` || digestOf(a.raw) != digestOf([]byte(second)) || b.etag != `"b1"` {
		t.Fatalf("kept %+v %+v", a, b)
	}

	// Back on the first address, a 304 answers that address's own copy.
	host.set("/a", withETag(second, `"a2"`))
	if _, raw, err = fetch("stable"); err != nil || string(raw) != second {
		t.Fatal(err)
	}
	checkRequests(t, host, `/a "a2"`)

	// An answer without an ETag forgets the copy: the next request is not conditional.
	host.set("/a", func(w http.ResponseWriter, _ string) { _, _ = w.Write([]byte(first)) })
	if _, raw, err = fetch("stable"); err != nil || string(raw) != first {
		t.Fatal(err)
	}
	fetch("stable")
	checkRequests(t, host, `/a "a2"`, "/a ")

	// A copy is kept per address, and an address names its channel: another
	// channel's index is never answered from it.
	// The second address still answers from its own copy.
	host.set("/a", withETag(indexBody("beta", "2026-11-18T13:00:00Z"), `"a3"`))
	if _, raw, err = fetch("stable"); err != nil || string(raw) != third {
		t.Fatalf("not the second address's copy: %s %v", raw, err)
	}
	checkRequests(t, host, "/a ", `/b "b1"`)
	if c := knownIndexCopy(targets[0]); c.etag != "" {
		t.Fatalf("an index for another channel was kept: %+v", c)
	}
	host.set("/b", answerStatus(http.StatusNotFound))
	if _, _, err = fetch("stable"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an index for another channel accepted: %v", err)
	}
}

func TestFetchChannelIndexErrors(t *testing.T) {
	host, _, fetch := newIndexHost(t)

	// An index for another channel, then one too large: both invalid, the last error answered.
	host.set("/a", withETag(indexBody("beta", "2026-11-18T10:00:00Z"), `"x"`))
	host.set("/b", func(w http.ResponseWriter, _ string) {
		_, _ = w.Write([]byte(strings.Repeat(" ", ChannelIndexLimit+1)))
	})
	if _, _, err := fetch("stable"); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("too large: %v", err)
	}
	host.set("/b", withETag("{not json", `"y"`))
	if _, _, err := fetch("stable"); !errors.Is(err, ErrInvalidIndex) {
		t.Fatalf("invalid: %v", err)
	}
	// A rate limit at the first address and an invalid index at the second: the last error is answered.
	host.set("/a", answerStatus(http.StatusForbidden))
	if _, _, err := fetch("stable"); !errors.Is(err, ErrInvalidIndex) {
		t.Fatalf("last error: %v", err)
	}
	// Rate limited everywhere.
	host.set("/b", answerStatus(http.StatusTooManyRequests))
	if _, _, err := fetch("stable"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate limited: %v", err)
	}
	// A 304 the box did not ask for is not an answer.
	host.set("/a", answerStatus(http.StatusNotModified))
	host.set("/b", answerStatus(http.StatusNotModified))
	if _, _, err := fetch("stable"); err == nil || !strings.Contains(err.Error(), "HTTP 304") {
		t.Fatalf("unasked 304: %v", err)
	}
	// An unknown channel asks nothing.
	host.take()
	if _, _, err := fetch("main"); err == nil {
		t.Fatal("unknown channel accepted")
	}
	if len(host.take()) != 0 {
		t.Fatal("an unknown channel was fetched")
	}
}

// The update check (ChooseCoreRelease) goes through the same conditional
// fetch: its second look at an unchanged index is a 304.
func TestChooseCoreReleaseAsksConditionally(t *testing.T) {
	var mu sync.Mutex
	var conditional []string
	index := indexBody("stable", "2026-11-18T10:00:00Z")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		conditional = append(conditional, r.Header.Get("If-None-Match"))
		mu.Unlock()
		w.Header().Set("ETag", `"i1"`)
		if r.Header.Get("If-None-Match") == `"i1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(index))
	}))
	defer server.Close()
	repository := "https://forge.example.test/o/YouEye"
	target := ChannelIndexURLs(repository, "stable")[0]
	t.Cleanup(func() { keepIndexCopy(target, indexCopy{}) })
	client := &http.Client{Transport: rewriteTo(server.URL)}
	for range 2 {
		// The index has no youeye entry: the choice fails after the index was read.
		if _, err := ChooseCoreRelease(context.Background(), client, repository, "stable", InstalledRelease{Fresh: true}); err == nil {
			t.Fatal("a release chosen from an index without one")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(conditional, "|") != `|"i1"` {
		t.Fatalf("If-None-Match sent: %q", conditional)
	}
}

// rewriteTo sends every request to base, keeping the path.
type rewriteTo string

func (base rewriteTo) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	target := string(base) + r.URL.Path
	u, err := r.URL.Parse(target)
	if err != nil {
		return nil, err
	}
	r.URL, r.Host = u, u.Host
	return http.DefaultTransport.RoundTrip(r)
}

func TestNextChannelIndexCheckJitter(t *testing.T) {
	old := channelIndexRand
	t.Cleanup(func() { channelIndexRand = old })
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	channelIndexRand = func() float64 { return 0 }
	if got := NextChannelIndexCheck(now).Sub(now); got != ChannelIndexTTL {
		t.Fatalf("no jitter: %v", got)
	}
	channelIndexRand = func() float64 { return 0.999999 }
	if got := NextChannelIndexCheck(now).Sub(now); got <= ChannelIndexTTL || got > 5*time.Minute+30*time.Second {
		t.Fatalf("most jitter: %v", got)
	}
	channelIndexRand = old
	spread := map[time.Duration]bool{}
	for range 200 {
		got := NextChannelIndexCheck(now).Sub(now)
		if got < 5*time.Minute || got > 5*time.Minute+30*time.Second {
			t.Fatalf("expiry %v outside [5m, 5m30s]", got)
		}
		spread[got] = true
	}
	if len(spread) < 2 {
		t.Fatal("the expiry does not vary")
	}
}
