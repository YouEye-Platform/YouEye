package installer

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDefaultConfigUsesPublicGitHubSources(t *testing.T) {
	cfg := newConfig()

	if cfg.CoreRepoURL != DefaultCoreRepoURL {
		t.Fatalf("CoreRepoURL = %q, want %q", cfg.CoreRepoURL, DefaultCoreRepoURL)
	}
	if cfg.MarketRepoURL != DefaultMarketRepoURL {
		t.Fatalf("MarketRepoURL = %q, want %q", cfg.MarketRepoURL, DefaultMarketRepoURL)
	}
	if cfg.ReleaseChannel != DefaultReleaseChannel {
		t.Fatalf("ReleaseChannel = %q, want %q", cfg.ReleaseChannel, DefaultReleaseChannel)
	}
}

func TestRawFileURLUsesProviderSpecificPublicPaths(t *testing.T) {
	got, err := rawFileURL(DefaultCoreRepoURL, "main", "spine/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://raw.githubusercontent.com/youeye-platform/YouEye/main/spine/install.sh"
	if got != want {
		t.Fatalf("GitHub raw URL = %q, want %q", got, want)
	}

	got, err = rawFileURL("https://example.test/acme/YouEye", "dev", "spine/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	want = "https://example.test/acme/YouEye/raw/branch/dev/spine/install.sh"
	if got != want {
		t.Fatalf("forge-compatible raw URL = %q, want %q", got, want)
	}
}

func TestSpineInstallCommandUsesConfiguredSource(t *testing.T) {
	cfg := newConfig()
	cfg.CoreRepoURL = "https://example.test/acme/YouEye"
	cfg.ReleaseChannel = "dev"

	cmd, err := spineInstallCommand(cfg)
	if err != nil {
		t.Fatal(err)
	}

	for _, needle := range []string{
		"https://example.test/acme/YouEye/raw/branch/dev/spine/install.sh",
		"RELEASE_REPO_URL='https://example.test/acme/YouEye'",
		"BRANCH='dev'",
	} {
		if !strings.Contains(cmd, needle) {
			t.Fatalf("install command %q missing %q", cmd, needle)
		}
	}
}

func TestMarketSourceJSONUsesGitHubShape(t *testing.T) {
	legacy, multi, err := marketSourceJSON(DefaultMarketRepoURL)
	if err != nil {
		t.Fatal(err)
	}

	var legacyDoc struct {
		RepoURL string `json:"repo_url"`
	}
	if err := json.Unmarshal(legacy, &legacyDoc); err != nil {
		t.Fatal(err)
	}
	if legacyDoc.RepoURL != DefaultMarketRepoURL {
		t.Fatalf("legacy repo_url = %q, want %q", legacyDoc.RepoURL, DefaultMarketRepoURL)
	}

	var multiDoc struct {
		ActiveSources []marketSourceRecord `json:"active_sources"`
	}
	if err := json.Unmarshal(multi, &multiDoc); err != nil {
		t.Fatal(err)
	}
	if len(multiDoc.ActiveSources) != 1 {
		t.Fatalf("active_sources len = %d, want 1", len(multiDoc.ActiveSources))
	}
	source := multiDoc.ActiveSources[0]
	if source.Provider != "github" || source.APIPath != "" {
		t.Fatalf("source provider/api_path = %q/%q, want github/empty", source.Provider, source.APIPath)
	}
	if source.Organization != "youeye-platform" || source.Repository != "Market" {
		t.Fatalf("source repo = %s/%s, want youeye-platform/Market", source.Organization, source.Repository)
	}
}

func TestConfigFromOptionsAllowsCustomAutomationSource(t *testing.T) {
	cfg, err := configFromEnvAndOptions(envInfo{IsProxmox: false}, CLIOptions{
		Silent:         true,
		Yes:            true,
		Mode:           "host",
		CoreRepoURL:    "https://example.test/YouEye-Platform/YouEye",
		MarketRepoURL:  "https://example.test/YouEye-Platform/Market",
		ReleaseChannel: "dev",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != modeHost {
		t.Fatalf("Mode = %v, want modeHost", cfg.Mode)
	}
	if cfg.CoreRepoURL != "https://example.test/YouEye-Platform/YouEye" {
		t.Fatalf("CoreRepoURL = %q", cfg.CoreRepoURL)
	}
	if cfg.MarketRepoURL != "https://example.test/YouEye-Platform/Market" {
		t.Fatalf("MarketRepoURL = %q", cfg.MarketRepoURL)
	}
	if cfg.ReleaseChannel != "dev" {
		t.Fatalf("ReleaseChannel = %q, want dev", cfg.ReleaseChannel)
	}
}

func TestParseOptionsAcceptsReuseBundlePaths(t *testing.T) {
	opts, err := ParseOptions([]string{
		"--silent",
		"--yes",
		"--names-bundle", "/tmp/names.bundle.json",
		"--domain-bundle", "/tmp/domain.bundle.json",
	}, strings.NewReader(""), ioDiscard{})
	if err != nil {
		t.Fatal(err)
	}
	if opts.NamesBundlePath != "/tmp/names.bundle.json" {
		t.Fatalf("NamesBundlePath = %q", opts.NamesBundlePath)
	}
	if opts.DomainBundlePath != "/tmp/domain.bundle.json" {
		t.Fatalf("DomainBundlePath = %q", opts.DomainBundlePath)
	}

	cfg := newConfig()
	applyOptionsToConfig(&cfg, opts)
	if cfg.NamesBundlePath != opts.NamesBundlePath || cfg.DomainBundlePath != opts.DomainBundlePath {
		t.Fatalf("bundle paths were not copied to config: %+v", cfg)
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) {
	return len(p), nil
}
