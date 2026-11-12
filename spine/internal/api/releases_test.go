package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

const testReleaseRepository = "https://forge.example/owner/YouEye"

func releaseTestServer(t *testing.T) *Server {
	t.Helper()
	s := NewServer("test", config.Default())
	s.coreBootstrapPath = t.TempDir()
	s.coreStatePath = t.TempDir()
	policy := systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Repository: testReleaseRepository, Channel: "stable", CoreManifestSHA256: strings.Repeat("a", 64)}
	if err := systemupdate.SaveReleasePolicy(filepath.Join(s.coreBootstrapPath, "release-policy.json"), policy); err != nil {
		t.Fatal(err)
	}
	return s
}

func stubChannelIndex(t *testing.T, fetch func(repository, channel string) (releasecache.ChannelIndex, []byte, error)) {
	t.Helper()
	old := fetchChannelIndex
	fetchChannelIndex = func(_ *http.Request, repository, channel string) (releasecache.ChannelIndex, []byte, error) {
		return fetch(repository, channel)
	}
	t.Cleanup(func() { fetchChannelIndex = old })
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(w.Code, w.Body.String(), err)
	}
	return out
}

func TestReleaseChannelGetAndPut(t *testing.T) {
	s := releaseTestServer(t)
	w := httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodGet, "/api/releases/channel", nil))
	body := decodeBody(t, w)
	if w.Code != 200 || body["repository"] != testReleaseRepository || body["channel"] != "stable" {
		t.Fatal(w.Code, body)
	}
	if _, ok := body["installed_version"]; ok {
		t.Fatal("installed_version reported without a receipt", body)
	}

	for _, bad := range []string{`{"channel":"main"}`, `{"channel":""}`, `{"channel":"beta","repository":"https://evil.example/x/YouEye"}`, `not json`} {
		w = httptest.NewRecorder()
		s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPut, "/api/releases/channel", strings.NewReader(bad)))
		if w.Code != http.StatusBadRequest {
			t.Fatal(bad, w.Code, w.Body.String())
		}
	}
	w = httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPut, "/api/releases/channel", strings.NewReader(`{"channel":"beta"}`)))
	body = decodeBody(t, w)
	if w.Code != 200 || body["channel"] != "beta" || body["repository"] != testReleaseRepository {
		t.Fatal(w.Code, body)
	}
	policy, err := systemupdate.LoadReleasePolicy(filepath.Join(s.coreBootstrapPath, "release-policy.json"))
	if err != nil || policy.Channel != "beta" || policy.Repository != testReleaseRepository || policy.CoreManifestSHA256 != strings.Repeat("a", 64) {
		t.Fatal(policy, err)
	}
	w = httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPost, "/api/releases/channel", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}

	// The installed version comes from the core receipt.
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	release, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(s.coreStatePath, "targets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "targets", digest+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	receipt, _ := json.Marshal(systemupdate.CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: "fixture", Evidence: "fixture", Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "i", DeviceIDRef: "d", ParentDiskID: "p", StatePartUUID: "s", DataPartUUID: "x"}})
	if err := os.WriteFile(filepath.Join(s.coreStatePath, "committed.json"), receipt, 0600); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodGet, "/api/releases/channel", nil))
	if body = decodeBody(t, w); body["installed_version"] != release.Version {
		t.Fatal(w.Code, body)
	}
}

func TestReleaseIndexCachesAndClassifiesErrors(t *testing.T) {
	s := releaseTestServer(t)
	index := releasecache.ChannelIndex{Schema: releasecache.ChannelIndexSchema, Channel: "stable", PublishedAt: "2026-11-12T10:00:00Z", Products: map[string]releasecache.ChannelEntry{
		"notes": {Repository: "https://forge.example/owner/YE-App-Notes", Tag: "v0.6.1-rc.1", Version: "0.6.1-rc.1", Document: "product-release.json", SHA256: strings.Repeat("b", 64)},
	}}
	raw, _ := json.Marshal(index)
	sum := sha256.Sum256(raw)
	calls := 0
	var fail error
	stubChannelIndex(t, func(repository, channel string) (releasecache.ChannelIndex, []byte, error) {
		calls++
		if repository != testReleaseRepository {
			t.Fatal("index fetched for another repository", repository)
		}
		if fail != nil {
			return releasecache.ChannelIndex{}, nil, fail
		}
		i := index
		i.Channel = channel
		return i, raw, nil
	})
	get := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.handleReleaseIndex(w, httptest.NewRequest(http.MethodGet, "/api/releases/index", nil))
		return w
	}
	w := get()
	body := decodeBody(t, w)
	if w.Code != 200 || body["repository"] != testReleaseRepository || body["channel"] != "stable" || body["index_sha256"] != hex.EncodeToString(sum[:]) || calls != 1 {
		t.Fatal(w.Code, body, calls)
	}
	products := body["index"].(map[string]any)["products"].(map[string]any)
	if _, ok := products["notes"]; !ok {
		t.Fatal(body)
	}
	if w = get(); w.Code != 200 || calls != 1 {
		t.Fatal("index not cached", w.Code, calls)
	}
	// A channel change invalidates the cache.
	w = httptest.NewRecorder()
	s.handleReleaseChannel(w, httptest.NewRequest(http.MethodPut, "/api/releases/channel", strings.NewReader(`{"channel":"dev"}`)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	fail = fmt.Errorf("fetch: %w (HTTP 429 from forge.example)", releasecache.ErrRateLimited)
	w = get()
	body = decodeBody(t, w)
	if w.Code != http.StatusBadGateway || body["code"] != "rate_limited" || calls != 2 {
		t.Fatal(w.Code, body, calls)
	}
	// The host is not asked again during the backoff.
	if w = get(); w.Code != http.StatusBadGateway || decodeBody(t, w)["code"] != "rate_limited" || calls != 2 {
		t.Fatal("backoff not honoured", w.Code, calls)
	}
	s.releaseIndex.retry = time.Time{}
	fail = fmt.Errorf("%w (HTTP 404)", releasecache.ErrNotFound)
	if w = get(); w.Code != http.StatusBadGateway || decodeBody(t, w)["code"] != "unavailable" {
		t.Fatal(w.Code, w.Body.String())
	}
	s.releaseIndex.retry = time.Time{}
	fail = nil
	w = get()
	if body = decodeBody(t, w); w.Code != 200 || body["channel"] != "dev" {
		t.Fatal(w.Code, body)
	}
	w = httptest.NewRecorder()
	s.handleReleaseIndex(w, httptest.NewRequest(http.MethodPost, "/api/releases/index", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}
	// Without a protected policy there is nothing to follow.
	if err := os.Remove(filepath.Join(s.coreBootstrapPath, "release-policy.json")); err != nil {
		t.Fatal(err)
	}
	s.releaseIndex.key = ""
	if w = get(); w.Code != http.StatusBadGateway || decodeBody(t, w)["code"] != "invalid" {
		t.Fatal(w.Code, w.Body.String())
	}
}

type coreCheckFixture struct {
	candidate CoreUpdateCandidate
	err       error
}

func (f coreCheckFixture) Check(context.Context) (CoreUpdateCandidate, error) {
	return f.candidate, f.err
}
func (f coreCheckFixture) Submit(context.Context, string, CoreUpdateRequest) (CoreUpdateActionResult, error) {
	return CoreUpdateActionResult{}, fmt.Errorf("unused")
}

func TestCoreUpdateCheckReportsBehindAndRateLimit(t *testing.T) {
	s := NewServer("test", config.Default())
	s.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true, Capabilities: appliance.Capabilities{ImageUpdate: true}}, &appliance.Manifest{}, nil
	}
	s.SetCoreUpdateOperations(coreCheckFixture{candidate: CoreUpdateCandidate{Behind: true, Message: "channel beta is behind the installed version 0.6.1-rc.2; waiting for it to catch up"}})
	w := httptest.NewRecorder()
	s.handleCoreUpdateCheck(w, httptest.NewRequest(http.MethodGet, "/", nil))
	body := decodeBody(t, w)
	if w.Code != 200 || body["behind"] != true || !strings.Contains(body["message"].(string), "behind") {
		t.Fatal(w.Code, body)
	}
	s.SetCoreUpdateOperations(coreCheckFixture{err: fmt.Errorf("%w (HTTP 403 from github.com)", releasecache.ErrRateLimited)})
	w = httptest.NewRecorder()
	s.handleCoreUpdateCheck(w, httptest.NewRequest(http.MethodGet, "/", nil))
	body = decodeBody(t, w)
	if w.Code != http.StatusBadGateway || body["code"] != "rate_limited" || strings.Contains(body["error"].(string), "network") {
		t.Fatal(w.Code, body)
	}
}
