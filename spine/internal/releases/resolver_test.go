package releases

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
)

// resolverConfig returns a config whose core repo points at the mock server.
func resolverConfig(serverURL string) *config.Config {
	cfg := config.Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.Provider = "gitea"
	cfg.Releases.BaseURL = serverURL
	cfg.Releases.APIPath = "/api/v1"
	cfg.Releases.Organization = "potemsla"
	cfg.Releases.Repositories.Spine = "YouEye"
	cfg.Releases.Repositories.ControlPanel = "YouEye"
	cfg.Releases.Repositories.UI = "YouEye"
	return cfg
}

func ch(branch string, fallback ...string) channels.Channel {
	c := channels.Channel{Branch: branch}
	if fallback != nil {
		c.Fallback = fallback
	}
	return c
}

// disabledFallback returns a channel with fallback explicitly disabled.
func disabledFallback(branch string) channels.Channel {
	return channels.Channel{Branch: branch, Fallback: []string{}}
}

func TestResolveFallbackChainOrder(t *testing.T) {
	// f-x has an older release; project p has a newer one; chain [f-x -> p -> main].
	rels := []Release{
		{TagName: "spine-f-x-v0.5.11.0.0.0.1"},
		{TagName: "spine-p-proj-v0.5.11.0.0.0.5"},
		{TagName: "spine-v0.5.10"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, ch("f-x", "p-proj", "main"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-p-proj-v0.5.11.0.0.0.5" {
		t.Errorf("picked %q, want the newer p-proj release", cand.Tag)
	}
	if cand.Branch != "p-proj" {
		t.Errorf("branch = %q, want p-proj", cand.Branch)
	}
}

func TestResolveDisabledFallbackHoldsAgainstNewerMain(t *testing.T) {
	rels := []Release{
		{TagName: "spine-f-x-v0.5.11.0.0.0.1"},
		{TagName: "spine-v0.9.0"}, // much newer main
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, disabledFallback("f-x"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-f-x-v0.5.11.0.0.0.1" {
		t.Errorf("picked %q, want f-x (fallback disabled must hold against newer main)", cand.Tag)
	}
}

func TestResolveMainOvertakeWithDefaultChain(t *testing.T) {
	// Chain [f-x -> main]; main is newer, so it overtakes the feature line.
	rels := []Release{
		{TagName: "spine-f-x-v0.5.11.0.0.0.1"},
		{TagName: "spine-v0.5.12"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, ch("f-x", "main"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-v0.5.12" {
		t.Errorf("picked %q, want newer main 0.5.12", cand.Tag)
	}
	if cand.Branch != "main" {
		t.Errorf("branch = %q, want main", cand.Branch)
	}
}

func TestResolveTiePrefersOwnBranch(t *testing.T) {
	// Same version on own branch and main → own branch wins (earlier chain pos).
	rels := []Release{
		{TagName: "spine-v0.5.11"},
		{TagName: "spine-f-x-v0.5.11"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, ch("f-x", "main"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Branch != "f-x" {
		t.Errorf("tie went to %q, want own branch f-x", cand.Branch)
	}
}

func TestResolveHistoricalTagsInert(t *testing.T) {
	// Old-style tags on retired branches must not be selected for a modern
	// feature branch with fallback [main].
	rels := []Release{
		{TagName: "spine-dev-v0.4.11.2"},
		{TagName: "spine-sebastian-v0.2.21.1"},
		{TagName: "spine-v0.5.11"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, ch("f-x", "main"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-v0.5.11" {
		t.Errorf("picked %q, want spine-v0.5.11 (historical tags must stay inert)", cand.Tag)
	}
}

func TestResolveSkipsTooDeepTag(t *testing.T) {
	// An 11-segment version must be skipped; the 3-segment main wins.
	rels := []Release{
		{TagName: "spine-v0.5.11.0.0.0.0.0.0.0.9"}, // 11 segments — invalid
		{TagName: "spine-v0.5.11"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	cand, err := resolveWithChannel(cfg, ch("main"), "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-v0.5.11" {
		t.Errorf("picked %q, want spine-v0.5.11 (deep tag must be skipped)", cand.Tag)
	}
}

func TestResolvePerSourceOverride(t *testing.T) {
	// Two servers: the default core repo and an override source. The channel's
	// source must be honored, not the core repo.
	coreRels := []Release{{TagName: "spine-v0.1.0"}}
	overrideRels := []Release{{TagName: "spine-f-x-v0.5.11.0.0.0.1"}}

	coreServer := mockGiteaServer(t, coreRels)
	defer coreServer.Close()
	overrideServer := mockGiteaServer(t, overrideRels)
	defer overrideServer.Close()

	cfg := resolverConfig(coreServer.URL)
	// Override source points at the second server (parsed as gitea by host).
	eff := channels.Channel{
		Source:   overrideServer.URL + "/potemsla/YouEye",
		Branch:   "f-x",
		Fallback: []string{},
	}
	cand, err := resolveWithChannel(cfg, eff, "", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-f-x-v0.5.11.0.0.0.1" {
		t.Errorf("picked %q from wrong source", cand.Tag)
	}
}

func TestResolveComponentReadsChannelFile(t *testing.T) {
	rels := []Release{
		{TagName: "spine-f-x-v0.5.11.0.0.0.1"},
		{TagName: "spine-v0.5.10"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	// Point channels config at a temp file that overrides spine to f-x, no fallback.
	dir := t.TempDir()
	p := filepath.Join(dir, "youeye.yaml")
	yaml := "release_channels:\n  default: { branch: main, fallback: [main] }\n  spine: { branch: f-x, fallback: [] }\n"
	if err := os.WriteFile(p, []byte(yaml), 0644); err != nil {
		t.Fatal(err)
	}
	old := channels.ConfigPath
	channels.ConfigPath = p
	defer func() { channels.ConfigPath = old }()

	cand, err := ResolveComponent(cfg, channels.ComponentSpine, "YouEye", "spine")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != "spine-f-x-v0.5.11.0.0.0.1" {
		t.Errorf("ResolveComponent picked %q, want f-x tag", cand.Tag)
	}
	if cand.Branch != "f-x" {
		t.Errorf("branch = %q", cand.Branch)
	}
}

func TestResolveAssetURLForChannelConstructsURL(t *testing.T) {
	rels := []Release{
		{TagName: "cp-v0.5.11", Assets: []Asset{{Name: "standalone.tar", BrowserDownloadURL: "https://example.test/cp/standalone.tar"}}},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	url, err := AssetURLForChannel(cfg, ch("main"), "YouEye", "standalone.tar", "cp")
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://example.test/cp/standalone.tar" {
		t.Errorf("asset url = %q, want the browser_download_url", url)
	}

	// When the release has no matching asset entry, URL is constructed.
	rels2 := []Release{{TagName: "cp-v0.5.11"}}
	server2 := mockGiteaServer(t, rels2)
	defer server2.Close()
	cfg2 := resolverConfig(server2.URL)
	url2, err := AssetURLForChannel(cfg2, ch("main"), "YouEye", "standalone.tar", "cp")
	if err != nil {
		t.Fatal(err)
	}
	if url2 == "" || url2[len(url2)-len("/cp-v0.5.11/standalone.tar"):] != "/cp-v0.5.11/standalone.tar" {
		t.Errorf("constructed url = %q", url2)
	}
}

func TestResolveExactTagDoesNotDriftToNewerDev(t *testing.T) {
	rels := []Release{
		{TagName: "cp-dev-v1.2.3"},
		{TagName: "cp-dev-v1.2.4"},
		{TagName: "cp-v9.0.0"},
	}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)
	eff := disabledFallback("dev")
	eff.Tag = "cp-dev-v1.2.3"

	cand, err := resolveWithChannel(cfg, eff, "YouEye", "cp")
	if err != nil {
		t.Fatal(err)
	}
	if cand.Tag != eff.Tag || cand.Version != "1.2.3" || cand.Branch != "dev" {
		t.Fatalf("unexpected exact candidate: %+v", cand)
	}
}

func TestResolveExactTagFailsClosed(t *testing.T) {
	rels := []Release{{TagName: "cp-dev-v1.2.3"}, {TagName: "cp-v1.2.3"}}
	server := mockGiteaServer(t, rels)
	defer server.Close()
	cfg := resolverConfig(server.URL)

	for _, tag := range []string{"cp-dev-v1.2.4", "cp-v1.2.3", "ui-dev-v1.2.3"} {
		eff := disabledFallback("dev")
		eff.Tag = tag
		if _, err := resolveWithChannel(cfg, eff, "YouEye", "cp"); err == nil {
			t.Fatalf("exact tag %q unexpectedly resolved", tag)
		}
	}
}
