package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

// Route through real local TLS and net/http body cancellation while retaining
// the original signed URL for the production transport's source checks.
type runtimeCacheLocalTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (r runtimeCacheLocalTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Host != "forge.example" {
		return nil, fmt.Errorf("unexpected fixture origin")
	}
	local := request.Clone(request.Context())
	u := *request.URL
	u.Scheme, u.Host = r.target.Scheme, r.target.Host
	local.URL = &u
	response, err := r.base.RoundTrip(local)
	if response != nil {
		response.Request = request
	}
	return response, err
}

type runtimeCacheHTTPFixture struct {
	cache            CoreArtifactCache
	selection        CoreHostSelection
	release          releasecache.CoreRelease
	artifact         releasecache.CoreBlob
	canceled         atomic.Bool
	metadataCanceled atomic.Bool
	metadataSlow     atomic.Bool
	payloadMode      atomic.Int32
	payloadStarted   chan struct{}
	payloadOnce      sync.Once
}

func newRuntimeCacheHTTPFixture(t *testing.T, delay time.Duration) *runtimeCacheHTTPFixture {
	t.Helper()
	f := &runtimeCacheHTTPFixture{payloadStarted: make(chan struct{})}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	repository := useBoxRepository(t)
	files := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		blob := func(name string, data []byte) releasecache.CoreBlob {
			b := releasecache.CoreBlob{Name: m.Role + "-" + name, SHA256: checksum(data), SizeBytes: int64(len(data))}
			u, err := url.Parse(releasecache.AssetURL(repository, "", r.Tag, b))
			if err != nil {
				t.Fatal(err)
			}
			files[u.Path] = data
			return b
		}
		payload := []byte(`{"fixture":"` + m.Role + `"}`)
		m.Artifact = blob(m.Role+".tar", payload)
		if m.BuildInputs != nil {
			inputs := blob("build-inputs.json", []byte(`{"inputs":"exact"}`))
			m.BuildInputs = &inputs
		}
		if m.Role == "cp" {
			f.artifact = m.Artifact
		}
	}
	raw, err = json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	f.selection = CoreHostSelection{Raw: raw}
	f.release = r
	root := t.TempDir()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		data, ok := files[request.URL.Path]
		if !ok {
			http.NotFound(w, request)
			return
		}
		if f.metadataSlow.Load() && strings.Contains(request.URL.Path, "/spine-") {
			timer := time.NewTimer(300 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-request.Context().Done():
				f.metadataCanceled.Store(true)
				return
			case <-timer.C:
			}
		}
		if strings.HasSuffix(request.URL.Path, "/cp-cp.tar") {
			f.payloadOnce.Do(func() { close(f.payloadStarted) })
			switch f.payloadMode.Load() {
			case 1:
				data = append([]byte(nil), data...)
				data[0] ^= 1
			case 2:
				data = append(append([]byte(nil), data...), '!')
			case 3:
				// Leaving HTTPS is refused; any HTTPS host is fine (digest-checked).
				http.Redirect(w, request, "http://hostile.example/asset", http.StatusFound)
				return
			}
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if strings.HasSuffix(request.URL.Path, "/cp-cp.tar") && delay > 0 {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data[:1])
			w.(http.Flusher).Flush()
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-request.Context().Done():
				f.canceled.Store(true)
				return
			case <-timer.C:
			}
			_, _ = w.Write(data[1:])
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	// These tests are deliberately nonparallel. Both production-created clients
	// capture this isolated transport; no external request can leave the fixture.
	originalTransport := http.DefaultTransport
	http.DefaultTransport = runtimeCacheLocalTransport{target: target, base: server.Client().Transport}
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	f.cache = NewRuntimeCoreArtifactCache(filepath.Join(root, "cache"))
	f.cache.AvailableBytes = func(string) (uint64, error) { return 1 << 30, nil }
	return f
}

func (f *runtimeCacheHTTPFixture) requireUncommittedAndUnlocked(t *testing.T) {
	t.Helper()
	path, err := f.cache.Path(f.artifact)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("failed payload became a committed cache blob", err)
	}
	lock, err := os.OpenFile(filepath.Join(f.cache.Root, "lock"), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal("failed staging retained its cache lock", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
}

func requireRuntimeCacheCancellation(t *testing.T, canceled *atomic.Bool) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for !canceled.Load() {
		select {
		case <-deadline.C:
			t.Fatal("local server did not observe request cancellation")
		case <-tick.C:
		}
	}
}

func TestRuntimeCoreCachePreservesExplicitPayloadTimeouts(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(fmt.Sprintf("fallback=%t", fallback), func(t *testing.T) {
			f := newRuntimeCacheHTTPFixture(t, 300*time.Millisecond)
			client := f.cache.ArtifactClient
			if fallback {
				f.cache.ArtifactClient = nil
				client = f.cache.Client
			}
			client.Timeout = 100 * time.Millisecond
			transport := client.Transport
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := f.stage(ctx, false); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("explicit payload timeout was not honored", err)
			}
			if client.Timeout != 100*time.Millisecond || client.Transport != transport {
				t.Fatal("supplied client timeout or transport was mutated")
			}
			requireRuntimeCacheCancellation(t, &f.canceled)
			f.requireUncommittedAndUnlocked(t)
		})
	}
}

func TestRuntimeCoreCachePreservesCallerCancellation(t *testing.T) {
	f := newRuntimeCacheHTTPFixture(t, 3*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.stage(ctx, false) }()
	select {
	case <-f.payloadStarted:
		cancel()
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("payload request did not start")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("caller cancellation was not preserved", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("payload did not settle after caller cancellation")
	}
	requireRuntimeCacheCancellation(t, &f.canceled)
	f.requireUncommittedAndUnlocked(t)
}

func TestRuntimeCoreCacheRejectsInvalidPayloadsAndRedirects(t *testing.T) {
	for name, mode := range map[string]int32{"corrupt": 1, "oversized": 2, "unsafe redirect": 3} {
		t.Run(name, func(t *testing.T) {
			f := newRuntimeCacheHTTPFixture(t, 0)
			f.payloadMode.Store(mode)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := f.stage(ctx, false)
			if err == nil || strings.Contains(err.Error(), "unexpected fixture origin") {
				t.Fatal("signed bytes or redirect boundary was not enforced", err)
			}
			f.requireUncommittedAndUnlocked(t)
		})
	}
}

func (f *runtimeCacheHTTPFixture) stage(ctx context.Context, update bool) error {
	if !update {
		_, _, err := f.cache.StageFreshServices(ctx, f.selection)
		return err
	}
	previous := f.release
	previous.Members = append([]releasecache.CoreMember(nil), f.release.Members...)
	for i := range previous.Members {
		if previous.Members[i].Role == "cp" {
			previous.Members[i].Artifact.SHA256 = strings.Repeat("a", 64)
		}
	}
	_, _, err := f.cache.StageUpdate(ctx, f.selection, previous)
	return err
}

func TestRuntimeCoreCachePayloadOutlivesMetadataBudget(t *testing.T) {
	for _, update := range []bool{false, true} {
		t.Run(fmt.Sprintf("update=%t", update), func(t *testing.T) {
			f := newRuntimeCacheHTTPFixture(t, 300*time.Millisecond)
			f.cache.Client.Timeout = 100 * time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := f.stage(ctx, update); err != nil {
				t.Fatal("valid signed payload inherited metadata timeout:", err)
			}
			path, err := f.cache.Path(f.artifact)
			if err != nil {
				t.Fatal(err)
			}
			if err := verifyFile(path, f.artifact.SizeBytes, f.artifact.SHA256); err != nil {
				t.Fatal("signed payload was not verified and committed:", err)
			}
		})
	}
}
