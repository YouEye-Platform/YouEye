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
	entry := `"youeye":{"repository":"` + repo + `","tag":"youeye-v0.6.1-dev.1","version":"0.6.1-dev.1","build":"0.6.1-dev.1","document":"core-release.json","sha256":"` + digest + `"}`
	client := serve(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":                index("dev", entry),
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.1-dev.1/core-release.json": string(raw),
	}, nil)
	_, release, got, err := FetchCoreRelease(context.Background(), client, repo, "dev")
	if err != nil || got != digest || release.Version != "0.6.1-dev.1" {
		t.Fatalf("resolve: %v %s", err, got)
	}
	// A document that differs from the index digest is refused.
	client = serve(t, map[string]string{
		"forge.example.test/owner/YouEye/releases/download/channel-dev/index.json":                index("dev", entry),
		"forge.example.test/owner/YouEye/releases/download/youeye-v0.6.1-dev.1/core-release.json": string(raw) + " ",
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
		`{"schema":"youeye.channel.v2","channel":"dev","published_at":"2026-11-12T10:00:00Z","products":{}}`,
		`{"schema":"youeye.channel.v1","channel":"dev","published_at":"yesterday","products":{}}`,
	}
	for i, raw := range bad {
		if _, err := ParseChannelIndex([]byte(raw)); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	// A bad entry fails only its own product.
	for i, entry := range []string{
		`"notes":{"repository":"https://a.test/o/r","tag":"dev-v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `"}`,
		`"notes":{"repository":"http://a.test/o/r","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `"}`,
		`"notes":{"repository":"https://a.test/o/r","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `","download_base":"https://x.test/f?sig=1"}`,
		`"notes":7`,
	} {
		parsed, err := ParseChannelIndex([]byte(index("dev", entry+`,"wiki":{"repository":"https://a.test/o/w","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`)))
		if err != nil || parsed.Invalid["notes"] == "" || len(parsed.Products) != 1 || parsed.Products["wiki"].Tag != "v1.0.0-dev.1" {
			t.Errorf("case %d: %v %+v", i, err, parsed)
		}
	}
	good := index("beta", `"notes":{"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.1-dev.2","version":"0.6.1-dev.2","build":"0.6.1-dev.2","document":"product-release.json","sha256":"`+strings.Repeat("b", 64)+`"},"market":{"repository":"https://github.com/YouEye-Platform/YE-AppMarket","tag":"catalog-v0.6.1-dev.1","version":"0.6.1-dev.1","build":"0.6.1-dev.1","document":"product-release.json","sha256":"`+strings.Repeat("c", 64)+`"}`)
	if parsed, err := ParseChannelIndex([]byte(good)); err != nil || len(parsed.Products) != 2 || len(parsed.Invalid) != 0 {
		t.Fatal(err)
	}
}

// An index from a later publisher: extra top-level and entry fields, a product
// this reader doesn't know, a download base and stones with extra fields.
func TestFutureChannelIndexIsRead(t *testing.T) {
	future := `{"schema":"youeye.channel.v1","channel":"stable","published_at":"2027-01-01T00:00:00Z","signatures":[{"key":"k1"}],"mirrors":["https://m.test"],
	"products":{
	 "youeye":{"repository":"https://github.com/YouEye-Platform/YouEye","tag":"youeye-v0.9.0","version":"0.9.0","build":"0.9.0-dev.4","document":"core-release.json","sha256":"` + strings.Repeat("a", 64) + `","download_base":"https://releases.youeye.me/v1/files","size_bytes":123,
	  "stepping_stones":[{"tag":"youeye-v0.7.0","version":"0.7.0","build":"0.7.0-dev.3","document":"core-release.json","sha256":"` + strings.Repeat("b", 64) + `","minimum_release":"0.6.0","minimum_reader":1,"note":"x"},{"broken":true},"nonsense"]},
	 "photos":{"repository":"https://github.com/YouEye-Platform/Photos","tag":"v0.1.0","version":"0.1.0","build":"0.1.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("c", 64) + `"},
	 "notes":{"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.9.0","version":"0.9.0","build":"0.9.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("d", 64) + `","channel_note":"y"}}}`
	parsed, err := ParseChannelIndex([]byte(future))
	if err != nil {
		t.Fatal(err)
	}
	core := parsed.Products["youeye"]
	if len(parsed.Products) != 2 || core.DownloadBase != "https://releases.youeye.me/v1/files" || len(core.SteppingStones) != 1 || core.SteppingStones[0].Build != "0.7.0-dev.3" {
		t.Fatalf("future index read wrongly: %+v", parsed)
	}
	if core.DocumentURL() != "https://releases.youeye.me/v1/files/youeye-v0.9.0/core-release.json" {
		t.Fatalf("download base not used: %s", core.DocumentURL())
	}
}

// coreDoc returns a variant of the fixture as release version/build with the
// given minimum_release and reader, and its digest.
func coreDoc(t *testing.T, version, build, minimum string, reader int) (string, string) {
	raw := mutate(t, func(d map[string]any) {
		d["version"], d["build"], d["tag"] = version, build, "youeye-v"+version
		d["compatibility"].(map[string]any)["minimum_release"] = minimum
		d["minimum_reader"] = reader
	})
	sum := sha256.Sum256(raw)
	return string(raw), hex.EncodeToString(sum[:])
}

func TestSteppingStoneWalk(t *testing.T) {
	repo := "https://forge.example.test/owner/YouEye"
	files := map[string]string{}
	entry := func(version, build, digest string) string {
		return `"repository":"` + repo + `","tag":"youeye-v` + version + `","version":"` + version + `","build":"` + build + `","document":"core-release.json","sha256":"` + digest + `"`
	}
	stone := func(version, build, minimum string, reader int) string {
		raw, digest := coreDoc(t, version, build, minimum, reader)
		files["forge.example.test/owner/YouEye/releases/download/youeye-v"+version+"/core-release.json"] = raw
		return fmt.Sprintf(`{"tag":"youeye-v%s","version":"%s","build":"%s","document":"core-release.json","sha256":"%s","minimum_release":"%s","minimum_reader":%d}`, version, version, build, digest, minimum, reader)
	}
	s1 := stone("0.6.2-dev.1", "0.6.2-dev.1", "0.6.0", 1)
	s2 := stone("0.6.2-dev.5", "0.6.2-dev.5", "0.6.2-dev.1", 1)
	headRaw, headDigest := coreDoc(t, "0.6.3", "0.6.3-dev.2", "0.6.2-dev.5", 1)
	files["forge.example.test/owner/YouEye/releases/download/youeye-v0.6.3/core-release.json"] = headRaw
	files["forge.example.test/owner/YouEye/releases/download/channel-stable/index.json"] = index("stable", `"youeye":{`+entry("0.6.3", "0.6.3-dev.2", headDigest)+`,"stepping_stones":[`+s2+`,`+s1+`]}`)
	client := serve(t, files, nil)
	ctx := context.Background()
	// N → stone 1 → stone 2 → head: never skipping a stone.
	walk := []struct{ installed, want string }{{"0.6.1-dev.1", "0.6.2-dev.1"}, {"0.6.2-dev.1", "0.6.2-dev.5"}, {"0.6.2-dev.5", "0.6.3-dev.2"}, {"0.6.3-dev.2", "0.6.3-dev.2"}}
	for _, step := range walk {
		choice, err := ChooseCoreRelease(ctx, client, repo, "stable", step.installed)
		if err != nil || choice.Release.Build != step.want || choice.Stone != (step.want != "0.6.3-dev.2") || choice.Head.Version != "0.6.3" {
			t.Fatalf("from %s: %v %+v", step.installed, err, choice.Release.Build)
		}
	}
	// Too old for every stone.
	if _, err := ChooseCoreRelease(ctx, client, repo, "stable", "0.5.9"); !errors.Is(err, ErrNoInstallableRelease) {
		t.Fatalf("expected no installable release: %v", err)
	}
	// A fresh install takes the head.
	if _, release, _, err := FetchCoreRelease(ctx, client, repo, "stable"); err != nil || release.Build != "0.6.3-dev.2" {
		t.Fatalf("head: %v", err)
	}
	// A head that needs a newer reader sends the box to a stone.
	newRaw, newDigest := coreDoc(t, "0.6.4", "0.6.4-dev.1", "0.6.0", 2)
	files["forge.example.test/owner/YouEye/releases/download/youeye-v0.6.4/core-release.json"] = newRaw
	files["forge.example.test/owner/YouEye/releases/download/channel-stable/index.json"] = index("stable", `"youeye":{`+entry("0.6.4", "0.6.4-dev.1", newDigest)+`,"stepping_stones":[`+s1+`]}`)
	client = serve(t, files, nil)
	choice, err := ChooseCoreRelease(ctx, client, repo, "stable", "0.6.1-dev.1")
	if err != nil || !choice.Stone || choice.Release.Build != "0.6.2-dev.1" || !strings.Contains(choice.HeadRefused, "reader") {
		t.Fatalf("reader stone: %v %+v", err, choice.HeadRefused)
	}
}

func TestValidDownloadBaseMatchesTheControlPanel(t *testing.T) {
	for value, want := range map[string]bool{
		"https://releases.youeye.me/v1/files": true, "https://mirror.test:8443/f": true,
		"https://Mirror.Test/f": false, "https://mirror.test:443/f": false, "https://mirror.test/f/": false,
		"http://mirror.test/f": false, "https://mirror.test/f?x=1": false, "https://u@mirror.test/f": false,
	} {
		if ValidDownloadBase(value) != want {
			t.Errorf("%s: want %v", value, want)
		}
	}
}
