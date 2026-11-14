package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

const (
	testForgeRepository = "https://forge.example.test/owner/YouEye"
	testFixtureTag      = "youeye-v0.6.1-dev.1"
	testFixtureVersion  = "0.6.1-dev.1"
)

// fixtureCoreRelease returns the shared releasecache fixture document and its
// digest (0.6.1-dev.1, tree 1111…).
func fixtureCoreRelease(t *testing.T) ([]byte, string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "releasecache", "testdata", "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw, coreManifestDigest(raw)
}

// testChannelIndex is a youeye.channel.v1 index naming one YouEye release.
func testChannelIndex(channel, repository, tag, version, digest string) string {
	entry := ""
	if tag != "" {
		entry = fmt.Sprintf(`"youeye":{"repository":%q,"tag":%q,"version":%q,"build":%q,"document":"core-release.json","sha256":%q}`, repository, tag, version, version, digest)
	}
	return `{"schema":"youeye.channel.v1","channel":"` + channel + `","published_at":"2026-11-12T10:00:00Z","products":{` + entry + `}}`
}

// releaseHosts serves https://<host>/<path> from files (keyed host+path) with
// optional status overrides, through one TLS test server. The returned client
// fails the test on any request to a release-listing API (api.github.com or a
// Forgejo /api/v1/repos/ path): boxes find releases only through indexes.
type releaseHosts struct {
	Client   *http.Client
	mu       sync.Mutex
	requests []string
}

func (h *releaseHosts) Requests() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.requests...)
}

func newReleaseHosts(t *testing.T, files map[string]string, status map[string]int) *releaseHosts {
	t.Helper()
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
		_, _ = fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	target := server.Listener.Addr().String()
	inner := server.Client().Transport.(*http.Transport)
	hosts := &releaseHosts{}
	hosts.Client = &http.Client{Transport: guardReleaseAPIs(t.Errorf, func(r *http.Request) (*http.Response, error) {
		hosts.mu.Lock()
		hosts.requests = append(hosts.requests, r.URL.String())
		hosts.mu.Unlock()
		clone := r.Clone(r.Context())
		clone.Host = r.URL.Host
		clone.URL.Host = target
		return inner.RoundTrip(clone)
	})}
	return hosts
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

// guardReleaseAPIs fails (through fail) and refuses any request to a
// release-listing API or over plain HTTP; other requests go to next.
func guardReleaseAPIs(fail func(string, ...any), next roundTripFunc) roundTripFunc {
	return func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" || strings.Contains(r.URL.Path, "/api/v1/repos/") {
			fail("release-listing API called: %s", r.URL)
			return nil, fmt.Errorf("release-listing API called: %s", r.URL)
		}
		if r.URL.Scheme != "https" {
			fail("non-HTTPS release request: %s", r.URL)
			return nil, fmt.Errorf("non-HTTPS release request: %s", r.URL)
		}
		return next(r)
	}
}

func TestReleaseAPIGuardRefusesListingAPIs(t *testing.T) {
	for target, refused := range map[string]bool{
		"https://api.github.com/repos/YouEye-Platform/YouEye/releases":           true,
		"https://forge.example.test/api/v1/repos/owner/YouEye/releases?page=1":   true,
		"http://forge.example.test/owner/YouEye/releases/download/x/index.json":  true,
		"https://forge.example.test/owner/YouEye/releases/download/x/index.json": false,
	} {
		failed, forwarded := false, false
		guard := guardReleaseAPIs(func(string, ...any) { failed = true }, func(*http.Request) (*http.Response, error) {
			forwarded = true
			return nil, errors.New("not served")
		})
		request, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = guard(request)
		if failed != refused || forwarded == refused {
			t.Fatalf("%s: failed=%v forwarded=%v", target, failed, forwarded)
		}
	}
}

func TestResolveApplianceReleaseFromCustomRepositoryDevIndex(t *testing.T) {
	raw, digest := fixtureCoreRelease(t)
	hosts := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":                   testChannelIndex("dev", testForgeRepository, testFixtureTag, testFixtureVersion, digest),
		"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/core-release.json": string(raw),
	}, nil)
	release, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository+".git", "dev", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.TagName != testFixtureTag || release.Repository != testForgeRepository || release.coreSHA256 != digest || string(release.coreRaw) != string(raw) || release.core == nil || release.core.SourceTree != strings.Repeat("1", 40) {
		t.Fatalf("unexpected release %s %s %s", release.TagName, release.Repository, release.coreSHA256)
	}
	want := []string{
		testForgeRepository + "/releases/download/channel-dev/index.json",
		testForgeRepository + "/releases/download/" + testFixtureTag + "/core-release.json",
	}
	if got := hosts.Requests(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	// Every blob is located in the repository release the document came from.
	member, _ := release.core.Member("media")
	if got := releasecache.AssetURL(release.Repository, "", release.TagName, member.Artifact); got != testForgeRepository+"/releases/download/"+testFixtureTag+"/youeye-appliance-amd64.iso" {
		t.Fatalf("media URL = %s", got)
	}

	// A custom repository's stable channel never consults releases.youeye.me.
	if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "stable", "", "", ""); !errors.Is(err, releasecache.ErrNotFound) {
		t.Fatalf("missing stable index: %v", err)
	}
	for _, request := range hosts.Requests() {
		if strings.Contains(request, "releases.youeye.me") {
			t.Fatalf("custom repository consulted the official index host: %s", request)
		}
	}

	// A document that differs from the index digest is refused.
	tampered := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":                   testChannelIndex("dev", testForgeRepository, testFixtureTag, testFixtureVersion, digest),
		"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/core-release.json": string(raw) + " ",
	}, nil)
	if _, err := resolveApplianceRelease(t.Context(), tampered.Client, testForgeRepository, "dev", "", "", ""); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("tampered document accepted: %v", err)
	}

	// An index naming another repository is refused.
	foreign := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json": testChannelIndex("dev", "https://other.example.test/owner/YouEye", testFixtureTag, testFixtureVersion, digest),
	}, nil)
	if _, err := resolveApplianceRelease(t.Context(), foreign.Client, testForgeRepository, "dev", "", "", ""); err == nil {
		t.Fatal("index naming another repository accepted")
	}

	// An index without a YouEye release fails clearly.
	empty := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-alpha/index.json": testChannelIndex("alpha", "", "", "", ""),
	}, nil)
	if _, err := resolveApplianceRelease(t.Context(), empty.Client, testForgeRepository, "alpha", "", "", ""); err == nil || !strings.Contains(err.Error(), "no YouEye release") {
		t.Fatalf("empty channel: %v", err)
	}
}

func TestResolveApplianceReleaseOfficialStablePrefersReleasesHost(t *testing.T) {
	raw, digest := fixtureCoreRelease(t)
	official := releasecache.OfficialRepository
	index := testChannelIndex("stable", official, testFixtureTag, testFixtureVersion, digest)
	document := "github.com/YouEye-Platform/YouEye/releases/download/" + testFixtureTag + "/core-release.json"
	repositoryIndex := "github.com/YouEye-Platform/YouEye/releases/download/channel-stable/index.json"

	hosts := newReleaseHosts(t, map[string]string{
		"releases.youeye.me/v1/channels/stable.json": index,
		repositoryIndex: index,
		document:        string(raw),
	}, nil)
	release, err := resolveApplianceRelease(t.Context(), hosts.Client, official, "stable", "", "", "")
	if err != nil || release.TagName != testFixtureTag || release.Repository != official {
		t.Fatalf("official stable: %s %v", release.TagName, err)
	}
	want := []string{"https://releases.youeye.me/v1/channels/stable.json", "https://" + document}
	if got := hosts.Requests(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests = %v, want %v", got, want)
	}

	// The releases host is down or serves a bad index: the repository copy is used.
	for name, status := range map[string]int{"down": http.StatusServiceUnavailable, "missing": http.StatusNotFound, "rate-limited": http.StatusTooManyRequests} {
		fallback := newReleaseHosts(t, map[string]string{repositoryIndex: index, document: string(raw)}, map[string]int{"releases.youeye.me/v1/channels/stable.json": status})
		release, err := resolveApplianceRelease(t.Context(), fallback.Client, official, "stable", "", "", "")
		if err != nil || release.TagName != testFixtureTag {
			t.Fatalf("%s releases host: %v", name, err)
		}
		want := []string{"https://releases.youeye.me/v1/channels/stable.json", "https://" + repositoryIndex, "https://" + document}
		if got := fallback.Requests(); strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("%s releases host: requests = %v", name, got)
		}
	}
	wrongChannel := newReleaseHosts(t, map[string]string{
		"releases.youeye.me/v1/channels/stable.json": testChannelIndex("beta", official, testFixtureTag, testFixtureVersion, digest),
		repositoryIndex: index,
		document:        string(raw),
	}, nil)
	if _, err := resolveApplianceRelease(t.Context(), wrongChannel.Client, official, "stable", "", "", ""); err != nil {
		t.Fatalf("index of another channel on the releases host was not skipped: %v", err)
	}

	// The official dev channel has no releases.youeye.me copy.
	dev := newReleaseHosts(t, map[string]string{
		"github.com/YouEye-Platform/YouEye/releases/download/channel-dev/index.json": testChannelIndex("dev", official, testFixtureTag, testFixtureVersion, digest),
		document: string(raw),
	}, nil)
	if _, err := resolveApplianceRelease(t.Context(), dev.Client, official, "dev", "", "", ""); err != nil {
		t.Fatal(err)
	}
	for _, request := range dev.Requests() {
		if strings.Contains(request, "releases.youeye.me") {
			t.Fatalf("official dev consulted releases.youeye.me: %s", request)
		}
	}
}

func TestResolveApplianceReleaseExactTagAndDigest(t *testing.T) {
	raw, digest := fixtureCoreRelease(t)
	hosts := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/core-release.json": string(raw),
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.2-dev.1/core-release.json":    string(raw),
	}, nil)
	release, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", testFixtureTag, digest, "")
	if err != nil || release.TagName != testFixtureTag || release.coreSHA256 != digest {
		t.Fatalf("exact release: %s %v", release.TagName, err)
	}
	// An exact selection never reads the channel index.
	if got := hosts.Requests(); len(got) != 1 || !strings.HasSuffix(got[0], "/"+testFixtureTag+"/core-release.json") {
		t.Fatalf("exact release requests = %v", got)
	}

	other := strings.Repeat("0", 64)
	if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", testFixtureTag, other, ""); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatalf("digest mismatch accepted: %v", err)
	}
	if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", "youeye-v0.6.2-dev.1", digest, ""); err == nil || !strings.Contains(err.Error(), "names tag") {
		t.Fatalf("document of another tag accepted: %v", err)
	}
	before := len(hosts.Requests())
	for name, args := range map[string][2]string{
		"tag without digest": {testFixtureTag, ""},
		"appliance tag":      {"appliance-v0.6.1", digest},
		"uppercase digest":   {testFixtureTag, strings.ToUpper(digest)},
	} {
		if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", args[0], args[1], ""); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "feature", "", "", ""); err == nil {
		t.Fatal("unknown channel accepted")
	}
	for _, repository := range []string{"http://forge.example.test/owner/YouEye", "https://forge.example.test/api/v1/repos/owner/YouEye/releases", "https://user:pw@forge.example.test/owner/YouEye"} {
		if _, err := resolveApplianceRelease(t.Context(), hosts.Client, repository, "dev", "", "", ""); err == nil {
			t.Fatalf("repository %s accepted", repository)
		}
	}
	if got := hosts.Requests(); len(got) != before {
		t.Fatalf("invalid selections made requests: %v", got[before:])
	}
}

func TestResolveApplianceReleaseSurfacesRateLimit(t *testing.T) {
	for _, code := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		hosts := newReleaseHosts(t, nil, map[string]int{"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json": code})
		_, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", "", "", "")
		if !errors.Is(err, releasecache.ErrRateLimited) {
			t.Fatalf("HTTP %d from the index: %v", code, err)
		}
		// Both official locations refusing still reports a rate limit.
		official := newReleaseHosts(t, nil, map[string]int{
			"releases.youeye.me/v1/channels/stable.json":                                    code,
			"github.com/YouEye-Platform/YouEye/releases/download/channel-stable/index.json": code,
		})
		if _, err := resolveApplianceRelease(t.Context(), official.Client, releasecache.OfficialRepository, "stable", "", "", ""); !errors.Is(err, releasecache.ErrRateLimited) {
			t.Fatalf("HTTP %d from both official indexes: %v", code, err)
		}
	}
	raw, digest := fixtureCoreRelease(t)
	_ = raw
	exact := newReleaseHosts(t, nil, map[string]int{"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/core-release.json": http.StatusTooManyRequests})
	if _, err := resolveApplianceRelease(t.Context(), exact.Client, testForgeRepository, "dev", testFixtureTag, digest, ""); !errors.Is(err, releasecache.ErrRateLimited) {
		t.Fatalf("HTTP 429 for an exact document: %v", err)
	}
}

func TestDownloadCoreBlobLocatesAssetsInTheReleaseRepository(t *testing.T) {
	payload := "blob bytes\n"
	sum := sha256.Sum256([]byte(payload))
	blob := releasecache.CoreBlob{Name: "spine-linux-amd64", SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(payload))}
	hosts := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/spine-linux-amd64": payload,
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.0-dev.4/spine-linux-amd64":    payload,
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.0-dev.4/build-inputs.json":    "changed",
	}, nil)
	release := applianceRelease{Repository: testForgeRepository, TagName: testFixtureTag}
	dir := t.TempDir()
	if err := downloadCoreBlob(t.Context(), hosts.Client, release, blob, filepath.Join(dir, "a"), 1<<20, false); err != nil {
		t.Fatal(err)
	}
	// A blob carried over from an earlier release names that release.
	blob.Release = "youeye-v0.6.0-dev.4"
	if err := downloadCoreBlob(t.Context(), hosts.Client, release, blob, filepath.Join(dir, "b"), 1<<20, false); err != nil {
		t.Fatal(err)
	}
	got := hosts.Requests()
	if len(got) != 2 || !strings.HasSuffix(got[0], "/"+testFixtureTag+"/spine-linux-amd64") || !strings.HasSuffix(got[1], "/youeye-v0.6.0-dev.4/spine-linux-amd64") {
		t.Fatalf("blob requests = %v", got)
	}
	// Bytes that differ from the bound digest are refused.
	bad := releasecache.CoreBlob{Name: "build-inputs.json", SHA256: blob.SHA256, SizeBytes: int64(len("changed")), Release: "youeye-v0.6.0-dev.4"}
	if err := downloadCoreBlob(t.Context(), hosts.Client, release, bad, filepath.Join(dir, "c"), 1<<20, false); err == nil {
		t.Fatal("blob with a different digest accepted")
	}
}

func TestCoreInstallerFreezesChannelSelectionAndExactAnswerBytes(t *testing.T) {
	raw, digest := fixtureCoreRelease(t)
	files := map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":                   testChannelIndex("dev", testForgeRepository, testFixtureTag, testFixtureVersion, digest),
		"forge.example.test/owner/YouEye/releases/download/" + testFixtureTag + "/core-release.json": string(raw),
	}
	hosts := newReleaseHosts(t, files, nil)
	selected, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	core := *selected.core
	answer := applianceAnswer{Schema: applianceAnswerSchema, Operation: "erase-install", TransactionID: strings.Repeat("a", 32), TargetSerial: "TARGET", EraseConfirmed: true, Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: applianceReleasePolicy{Schema: releasePolicySchema, Repository: testForgeRepository, Channel: "dev", CoreManifestSHA256: selected.coreSHA256}, ConsoleAccess: defaultConsoleAccessPolicy(), CoreRelease: coreAnswerFromRelease(selected)}
	encoded, _ := json.MarshalIndent(answer, "", "    ")
	decoded, err := parseApplianceAnswer(encoded)
	if err != nil {
		t.Fatal("formatting changed exact bytes", err)
	}
	if decoded.CoreRelease.ManifestBase64 != answer.CoreRelease.ManifestBase64 {
		t.Fatal("answer rewrote core manifest")
	}
	// Both an interactive input and a supplied answer reach the same exact
	// selection before the provider discovers or writes disks.
	appliance, _ := core.Member("appliance")
	spine, _ := core.Member("spine")
	bundle := verifiedApplianceBundle{ManifestSHA256: appliance.Artifact.SHA256, Manifest: applianceBundleManifest{
		ImageVersion: appliance.BuildVersion, SourceTree: appliance.SourceTree,
		ReleaseSet: applianceManifestReleases{
			Spine: applianceManifestComponent{Version: spine.BuildVersion, SourceTree: spine.SourceTree, ArtifactSHA256: spine.Artifact.SHA256}},
	}}
	input := applianceInstallInput{Operation: "erase-install", TransactionID: answer.TransactionID, TargetSerial: "TARGET", EraseConfirmed: true, Network: answer.Network, ConsoleAccess: answer.ConsoleAccess, ReleasePolicy: answer.ReleasePolicy, AnswerPath: "/original/answer.json"}
	input.ReleasePolicy.CoreManifestSHA256 = ""
	prepared, err := prepareCoreInstallInput(t.Context(), input, bundle, hosts.Client, true)
	if err != nil || prepared.CoreRelease == nil || prepared.AnswerPath != "" || prepared.CoreRelease.ManifestBase64 != answer.CoreRelease.ManifestBase64 || prepared.ReleasePolicy.CoreManifestSHA256 != digest {
		t.Fatal("complete selection was not frozen", err)
	}
	path, err := writeRuntimeApplianceAnswer(prepared, applianceDisk{Serial: "TARGET"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(path) })
	saved, err := loadApplianceInstallInput(installConfig{ApplianceAnswerPath: path})
	if err != nil || saved.CoreRelease == nil || saved.ReleasePolicy.CoreManifestSHA256 != selected.coreSHA256 || saved.ReleasePolicy.Channel != "dev" || saved.ReleasePolicy.Repository != testForgeRepository {
		t.Fatal("lost runtime selection", err)
	}
	if _, err := prepareCoreInstallInput(t.Context(), saved, bundle, nil, true); err != nil {
		t.Fatal("frozen answer unexpectedly needed discovery", err)
	}
	retained, _ := json.Marshal(map[string]any{"transaction_id": answer.TransactionID, "target_serial": "TARGET", "manifest_sha256": bundle.ManifestSHA256, "release_policy": saved.ReleasePolicy, "core_release": saved.CoreRelease})
	resumeInput := input
	resumeInput.Operation = "resume"
	restored, err := restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resumeInput, bundle.ManifestSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = prepareCoreInstallInput(t.Context(), restored, bundle, nil, true); err != nil {
		t.Fatal("resume did not retain the exact selection", err)
	}
	resumeInput.TransactionID = strings.Repeat("c", 32)
	if _, err = restoreCoreInstallSelection(coreSelectionRunner{raw: string(retained)}, applianceDisk{Path: "/dev/test", Serial: "TARGET"}, resumeInput, bundle.ManifestSHA256); err == nil {
		t.Fatal("resume accepted another transaction's selection")
	}
	cachedInput := input
	cachedInput.ReleaseCacheSHA256 = strings.Repeat("f", 64)
	if _, err = prepareCoreInstallInput(t.Context(), cachedInput, bundle, nil, true); err == nil {
		t.Fatal("cache silently lost its frozen transport")
	}
	wrong := bundle
	wrong.ManifestSHA256 = strings.Repeat("e", 64)
	if _, err := prepareCoreInstallInput(t.Context(), saved, wrong, nil, true); err == nil {
		t.Fatal("foreign media accepted")
	}
	// The image's seed Spine may differ from the release's Spine: first boot
	// adopts the release's Spine onto State.
	otherSpine := bundle
	otherSpine.Manifest.ReleaseSet.Spine.ArtifactSHA256 = strings.Repeat("e", 64)
	if _, err := prepareCoreInstallInput(t.Context(), saved, otherSpine, nil, true); err != nil {
		t.Fatal("media with an older seed Spine refused:", err)
	}
	resuming := input
	resuming.Operation = "resume"
	if _, err := prepareCoreInstallInput(t.Context(), resuming, bundle, nil, true); err == nil {
		t.Fatal("resume selected a moving release")
	}
	answer.CoreRelease.ManifestSHA256 = strings.Repeat("f", 64)
	if err := validateApplianceAnswer(answer); err == nil {
		t.Fatal("changed exact selection accepted")
	}
	// The channel moved to a document that no longer matches its index digest.
	files["forge.example.test/owner/YouEye/releases/download/"+testFixtureTag+"/core-release.json"] = " " + string(raw)
	moved := newReleaseHosts(t, files, nil)
	if _, err := prepareCoreInstallInput(t.Context(), input, bundle, moved.Client, true); err == nil {
		t.Fatal("changed document kept its digest")
	}
}

type coreSelectionRunner struct{ raw string }

func (r coreSelectionRunner) Run(_ string, _ ...string) (string, error) { return r.raw, nil }

// A download_base in the index moves the document and every file of the
// release, and the answer carries it to State for first deployment.
func TestResolveApplianceReleaseFollowsDownloadBase(t *testing.T) {
	raw, digest := fixtureCoreRelease(t)
	index := strings.Replace(testChannelIndex("dev", testForgeRepository, testFixtureTag, testFixtureVersion, digest),
		`"document":"core-release.json"`, `"document":"core-release.json","download_base":"https://mirror.example.test/files"`, 1)
	hosts := newReleaseHosts(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json": index,
		"mirror.example.test/files/" + testFixtureTag + "/core-release.json":      string(raw),
	}, nil)
	release, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.DownloadBase != "https://mirror.example.test/files" || coreAnswerFromRelease(release).DownloadBase != release.DownloadBase {
		t.Fatalf("download base not kept: %+v", release.DownloadBase)
	}
	member, _ := release.core.Member("media")
	if got := releasecache.AssetURL(release.Repository, release.DownloadBase, release.TagName, member.Artifact); got != "https://mirror.example.test/files/"+testFixtureTag+"/youeye-appliance-amd64.iso" {
		t.Fatalf("media URL = %s", got)
	}
	// An exact release handed over by install.sh brings its base along.
	exact, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", testFixtureTag, digest, "https://mirror.example.test/files")
	if err != nil || exact.DownloadBase != "https://mirror.example.test/files" {
		t.Fatalf("exact release with base: %v", err)
	}
	if _, err := resolveApplianceRelease(t.Context(), hosts.Client, testForgeRepository, "dev", testFixtureTag, digest, "http://mirror.example.test/files"); err == nil {
		t.Fatal("plain HTTP download base accepted")
	}
}
