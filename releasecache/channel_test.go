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
		`"pointer":{"repository":"https://a.test/o/r","tag":"dev-v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `"}`,
		`"pointer":{"repository":"http://a.test/o/r","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `"}`,
		`"pointer":{"repository":"https://a.test/o/r","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("a", 64) + `","download_base":"https://x.test/f?sig=1"}`,
		`"pointer":7`,
	} {
		parsed, err := ParseChannelIndex([]byte(index("dev", entry+`,"wiki":{"repository":"https://a.test/o/w","tag":"v1.0.0-dev.1","version":"1.0.0-dev.1","build":"1.0.0-dev.1","document":"product-release.json","sha256":"`+strings.Repeat("a", 64)+`"}`)))
		if err != nil || parsed.Invalid["pointer"] == "" || len(parsed.Products) != 0 || parsed.Invalid["wiki"] != "" {
			t.Errorf("case %d: %v %+v", i, err, parsed)
		}
	}
	good := index("beta", `"pointer":{"repository":"https://github.com/YouEye-Platform/Pointer","tag":"v0.6.1-dev.2","version":"0.6.1-dev.2","build":"0.6.1-dev.2","document":"product-release.json","sha256":"`+strings.Repeat("b", 64)+`"},"market":{"repository":"https://github.com/YouEye-Platform/YE-AppMarket","tag":"catalog-v0.6.1-dev.1","version":"0.6.1-dev.1","build":"0.6.1-dev.1","document":"product-release.json","sha256":"`+strings.Repeat("c", 64)+`"},"notes":{"repository":"https://github.com/YouEye-Platform/Notes","tag":"v0.6.4","version":"0.6.4","document":"product-release.json","sha256":"`+strings.Repeat("e", 64)+`"}`)
	// The frozen market entry (for boxes up to 0.6.10) and the frozen native app entries (for boxes up to 0.6.19,
	// YE-142) are skipped like any product this reader does not take.
	if parsed, err := ParseChannelIndex([]byte(good)); err != nil || len(parsed.Products) != 1 || len(parsed.Invalid) != 0 || parsed.Products["pointer"].Tag != "v0.6.1-dev.2" {
		t.Fatal(err, parsed)
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
	 "pointer":{"repository":"https://github.com/YouEye-Platform/Pointer","tag":"v0.9.0","version":"0.9.0","build":"0.9.0-dev.1","document":"product-release.json","sha256":"` + strings.Repeat("d", 64) + `","channel_note":"y"}}}`
	parsed, err := ParseChannelIndex([]byte(future))
	if err != nil {
		t.Fatal(err)
	}
	core := parsed.Products["youeye"]
	if len(parsed.Products) != 2 || core.DownloadBase != "https://releases.youeye.me/v1/files" || len(core.SteppingStones) != 1 || core.SteppingStones[0].Version != "0.7.0" || core.SteppingStones[0].Sequence != 0 {
		t.Fatalf("future index read wrongly: %+v", parsed)
	}
	if core.DocumentURL() != "https://releases.youeye.me/v1/files/youeye-v0.9.0/core-release.json" {
		t.Fatalf("download base not used: %s", core.DocumentURL())
	}
}

// coreDoc returns a variant of the fixture as release version with the given
// sequence, minimum_release and reader, and its digest. With build empty the
// document has the shape without build names.
func coreDoc(t *testing.T, version, build string, sequence int64, minimum string, reader int) (string, string) {
	raw := mutate(t, func(d map[string]any) {
		d["version"], d["tag"], d["sequence"] = version, "youeye-v"+version, sequence
		if build == "" {
			delete(d, "build")
			for _, m := range d["members"].([]any) {
				delete(m.(map[string]any), "build_version")
			}
		} else {
			d["build"] = build
		}
		d["compatibility"].(map[string]any)["minimum_release"] = minimum
		d["minimum_reader"] = reader
	})
	sum := sha256.Sum256(raw)
	return string(raw), hex.EncodeToString(sum[:])
}

func installedAt(t *testing.T, version string, sequence int64) InstalledRelease {
	t.Helper()
	key, err := KeyOfVersion(version, sequence)
	if err != nil {
		t.Fatal(err)
	}
	return InstalledRelease{Key: key, Version: version}
}

// stoneChannel serves a channel whose documents and stones the test adds.
type stoneChannel struct {
	t     *testing.T
	repo  string
	files map[string]string
}

func newStoneChannel(t *testing.T) *stoneChannel {
	return &stoneChannel{t: t, repo: "https://forge.example.test/owner/YouEye", files: map[string]string{}}
}

func (c *stoneChannel) document(version, build string, sequence int64, minimum string, reader int) string {
	raw, digest := coreDoc(c.t, version, build, sequence, minimum, reader)
	c.files["forge.example.test/owner/YouEye/releases/download/youeye-v"+version+"/core-release.json"] = raw
	return digest
}

// entry is a head entry; entryBuild is the temporary field (empty: absent).
func (c *stoneChannel) entry(version, entryBuild, digest string) string {
	build := ""
	if entryBuild != "" {
		build = `"build":"` + entryBuild + `",`
	}
	return `"repository":"` + c.repo + `","tag":"youeye-v` + version + `","version":"` + version + `",` + build + `"document":"core-release.json","sha256":"` + digest + `"`
}

// stone is a stone entry; indexSequence 0 leaves the field out (an index
// written before 0.6.12).
func (c *stoneChannel) stone(version, build string, sequence, indexSequence int64, minimum string, reader int) string {
	digest := c.document(version, build, sequence, minimum, reader)
	extra := ""
	if build != "" {
		extra += `"build":"` + build + `",`
	}
	if indexSequence != 0 {
		extra += fmt.Sprintf(`"sequence":%d,`, indexSequence)
	}
	return fmt.Sprintf(`{"tag":"youeye-v%s","version":"%s",%s"document":"core-release.json","sha256":"%s","minimum_release":"%s","minimum_reader":%d}`, version, version, extra, digest, minimum, reader)
}

func (c *stoneChannel) publish(channel, head string, stones ...string) *http.Client {
	c.files["forge.example.test/owner/YouEye/releases/download/channel-"+channel+"/index.json"] = index(channel, `"youeye":{`+head+`,"stepping_stones":[`+strings.Join(stones, ",")+`]}`)
	return serve(c.t, c.files, nil)
}

func TestSteppingStoneWalk(t *testing.T) {
	c := newStoneChannel(t)
	ctx := context.Background()
	// Old-shape stones without a sequence in the index (what 0.6.11 tools
	// wrote): the stone's document says its sequence.
	s1 := c.stone("0.6.2-dev.1", "0.6.2-dev.1", 200, 0, "0.6.0", 1)
	s2 := c.stone("0.6.3", "0.6.3-dev.5", 300, 300, "0.6.2-dev.1", 1)
	head := c.entry("0.6.4", "0.6.4-dev.2", c.document("0.6.4", "0.6.4-dev.2", 400, "0.6.3-dev.5", 1))
	client := c.publish("stable", head, s2, s1)
	// N → stone 1 → stone 2 → head: never skipping a stone.
	walk := []struct {
		installed InstalledRelease
		want      string
	}{
		{installedAt(t, "0.6.1", 100), "0.6.2-dev.1"},
		{installedAt(t, "0.6.2-dev.1", 200), "0.6.3"},
		{installedAt(t, "0.6.2-beta.1", 200), "0.6.3"}, // the same build under another name
		{installedAt(t, "0.6.3", 300), "0.6.4"},
		{installedAt(t, "0.6.3-dev.9", 350), "0.6.4"}, // a later build of the stone's line needs no stone
		{installedAt(t, "0.6.4", 400), "0.6.4"},
	}
	for _, step := range walk {
		choice, err := ChooseCoreRelease(ctx, client, c.repo, "stable", step.installed)
		if err != nil || choice.Release.Version != step.want || choice.Stone != (step.want != "0.6.4") || choice.Head.Version != "0.6.4" {
			t.Fatalf("from %s: %v %+v", step.installed.Version, err, choice.Release.Version)
		}
		if choice.Stone && !strings.Contains(choice.HeadRefused, "0.6.4 needs YouEye 0.6.3 or later") {
			t.Fatalf("from %s: head refused as %q", step.installed.Version, choice.HeadRefused)
		}
	}
	// Too old for every stone. The message names versions only.
	_, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.5.9", 50))
	if !errors.Is(err, ErrNoInstallableRelease) || !strings.Contains(err.Error(), "no stepping stone fits 0.5.9") || strings.Contains(err.Error(), "dev.") {
		t.Fatalf("expected no installable release: %v", err)
	}
	// A fresh install takes the head, whatever its minimum_release.
	if _, release, _, err := FetchCoreRelease(ctx, client, c.repo, "stable"); err != nil || release.Version != "0.6.4" {
		t.Fatalf("head: %v", err)
	}
	// An installed release that is not known is not a fresh install: it gets
	// neither the head nor a stone.
	if _, err := ChooseCoreRelease(ctx, client, c.repo, "stable", InstalledRelease{}); !errors.Is(err, ErrNoInstallableRelease) {
		t.Fatalf("an unknown installed release was offered something: %v", err)
	}
}

// The 0.6.11 → 0.6.12 → 0.6.13 walk as reader 2 sees it: the head is a
// document without build names (minimum_reader 2, minimum_release a line), the
// stone an old-shape document. Index entries carry the temporary build field
// or not; it is never compared.
func TestSteppingStoneWalkAcrossShapes(t *testing.T) {
	c := newStoneChannel(t)
	ctx := context.Background()
	stone := c.stone("0.6.12", "0.6.12-dev.4", 1795100000, 1795100000, "0.6.5-dev.2", 1)
	for _, entryBuild := range []string{"", "0.6.13", "9.9.9-dev.9"} {
		head := c.entry("0.6.13", entryBuild, c.document("0.6.13", "", 1795200000, "0.6.12", 2))
		client := c.publish("stable", head, stone)
		// A 0.6.11 box (reader 2 only after the stone, but line 0.6.11 here).
		choice, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.11", 1795042574))
		if err != nil || !choice.Stone || choice.Release.Version != "0.6.12" || choice.Release.Build != "0.6.12-dev.4" || choice.Entry.Version != "0.6.12" {
			t.Fatalf("entry build %q: stone not chosen: %v %+v", entryBuild, err, choice.Release.Version)
		}
		// On the stone (under any of its names) the head is installable.
		for _, name := range []string{"0.6.12", "0.6.12-dev.4", "0.6.12-alpha.1"} {
			choice, err = ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, name, 1795100000))
			if err != nil || choice.Stone || choice.Release.Version != "0.6.13" || choice.Release.Build != "" {
				t.Fatalf("entry build %q, on %s: %v %+v", entryBuild, name, err, choice.Release.Version)
			}
		}
		// A dev box on a later build of the head's line still gets the head
		// offered here; refusing the downgrade is the caller's check.
		choice, err = ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.13-dev.7", 1795300000))
		if err != nil || choice.Stone || choice.Release.Version != "0.6.13" {
			t.Fatalf("later build of the line: %v", err)
		}
	}
}

func TestSteppingStoneChoiceRules(t *testing.T) {
	ctx := context.Background()
	// A head that needs a newer reader sends the box to a stone; a fresh
	// install (an installer that is too old) gets the reader error.
	c := newStoneChannel(t)
	s1 := c.stone("0.6.2", "", 200, 200, "0.6.0", 2)
	client := c.publish("stable", c.entry("0.6.4", "", c.document("0.6.4", "", 400, "0.6.0", 3)), s1)
	choice, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.1", 100))
	if err != nil || !choice.Stone || choice.Release.Version != "0.6.2" || !strings.Contains(choice.HeadRefused, "reader") {
		t.Fatalf("reader stone: %v %+v", err, choice.HeadRefused)
	}
	if _, _, _, err := FetchCoreRelease(ctx, client, c.repo, "stable"); !errors.Is(err, ErrNeedsNewerReader) {
		t.Fatalf("fresh install on a newer-reader head: %v", err)
	}
	// A stone that itself needs a newer reader is not offered.
	c = newStoneChannel(t)
	client = c.publish("stable", c.entry("0.6.4", "", c.document("0.6.4", "", 400, "0.6.0", 3)), c.stone("0.6.3", "", 300, 300, "0.6.0", 3))
	if _, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.1", 100)); !errors.Is(err, ErrNoInstallableRelease) {
		t.Fatalf("stone for a newer reader offered: %v", err)
	}
	// The index sequence of a stone must be its document's.
	c = newStoneChannel(t)
	client = c.publish("stable", c.entry("0.6.4", "", c.document("0.6.4", "", 400, "0.6.3", 2)), c.stone("0.6.3", "", 300, 301, "0.6.0", 2))
	if _, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.1", 100)); err == nil || !strings.Contains(err.Error(), "differs from its channel index entry") {
		t.Fatalf("stone with another sequence accepted: %v", err)
	}
	// A box never takes a stone it already has or has passed: with nothing
	// newer that fits, it waits.
	c = newStoneChannel(t)
	client = c.publish("stable", c.entry("0.6.5", "", c.document("0.6.5", "", 500, "0.6.4", 2)),
		c.stone("0.6.3", "", 300, 300, "0.6.0", 2), c.stone("0.6.2", "", 200, 0, "0.6.0", 2))
	for _, installed := range []InstalledRelease{installedAt(t, "0.6.3", 300), installedAt(t, "0.6.3-dev.8", 350)} {
		if choice, err := ChooseCoreRelease(ctx, client, c.repo, "stable", installed); !errors.Is(err, ErrNoInstallableRelease) {
			t.Fatalf("from %s: took %s: %v", installed.Version, choice.Release.Version, err)
		}
	}
	// The newest stone that fits is taken, whatever the order in the index.
	choice, err = ChooseCoreRelease(ctx, client, c.repo, "stable", installedAt(t, "0.6.1", 100))
	if err != nil || choice.Release.Version != "0.6.3" {
		t.Fatalf("newest stone: %v %+v", err, choice.Release.Version)
	}
	// A document that names another version than its entry is refused.
	c = newStoneChannel(t)
	_, digest := coreDoc(t, "0.6.4-beta.1", "", 400, "0.6.0", 2)
	raw, _ := coreDoc(t, "0.6.4-beta.1", "", 400, "0.6.0", 2)
	c.files["forge.example.test/owner/YouEye/releases/download/youeye-v0.6.4/core-release.json"] = raw
	client = c.publish("stable", c.entry("0.6.4", "", digest))
	if _, _, _, err := FetchCoreRelease(ctx, client, c.repo, "stable"); err == nil || !strings.Contains(err.Error(), "the channel index 0.6.4") {
		t.Fatalf("document of another version accepted: %v", err)
	}
}

// From 0.6.13 an entry's build is a temporary copy of its version for readers
// up to 0.6.11; this reader accepts entries with it, without it and with a
// value it would not accept as a version, and reads a stone's sequence.
func TestChannelIndexBuildIsOptionalAndIgnored(t *testing.T) {
	digest := strings.Repeat("a", 64)
	entry := func(extra string) string {
		return `"youeye":{"repository":"https://github.com/YouEye-Platform/YouEye","tag":"youeye-v0.6.13","version":"0.6.13",` + extra + `"document":"core-release.json","sha256":"` + digest + `",
		 "stepping_stones":[{"tag":"youeye-v0.6.12","version":"0.6.12","build":"0.6.12-dev.4","sequence":1795100000,"document":"core-release.json","sha256":"` + digest + `","minimum_release":"0.6.5-dev.2","minimum_reader":1},
		  {"tag":"youeye-v0.6.11","version":"0.6.11","document":"core-release.json","sha256":"` + digest + `","minimum_release":"0.6.5","minimum_reader":1},
		  {"tag":"youeye-v0.6.10","version":"0.6.10","sequence":-4,"document":"core-release.json","sha256":"` + digest + `","minimum_release":"0.6.5","minimum_reader":1}]},
		"pointer":{"repository":"https://github.com/YouEye-Platform/Pointer","tag":"v0.6.4","version":"0.6.4",` + extra + `"document":"product-release.json","sha256":"` + digest + `"}`
	}
	for _, extra := range []string{``, `"build":"0.6.13",`, `"build":"not a version",`} {
		parsed, err := ParseChannelIndex([]byte(index("stable", entry(extra))))
		if err != nil || len(parsed.Invalid) != 0 || len(parsed.Products) != 2 {
			t.Fatalf("%q: %v %+v", extra, err, parsed.Invalid)
		}
		stones := parsed.Products["youeye"].SteppingStones
		if len(stones) != 2 || stones[0].Sequence != 1795100000 || stones[0].Build != "0.6.12-dev.4" || stones[1].Sequence != 0 || stones[1].Build != "" {
			t.Fatalf("%q: stones read wrongly: %+v", extra, stones)
		}
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
