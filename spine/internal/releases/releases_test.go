package releases

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YouEye-Platform/YouEye/spine/internal/config"
)

func TestIsMainTag(t *testing.T) {
	tests := []struct {
		name string
		tag  string
		want bool
	}{
		{"standard main tag", "v0.1.50", true},
		{"single digit", "v1", true},
		{"major version", "v2.0.0", true},
		{"branch tag john", "john-v0.1.50", false},
		{"branch tag dev", "dev-v0.2.5.1", false},
		{"empty string", "", false},
		{"just v", "v", false},
		{"no v prefix", "0.1.50", false},
		{"v with letter", "vtest", false},
		{"uppercase V", "V0.1.50", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsMainTag(tt.tag)
			if got != tt.want {
				t.Errorf("IsMainTag(%q) = %v, want %v", tt.tag, got, tt.want)
			}
		})
	}
}

func TestIsBranchTag(t *testing.T) {
	tests := []struct {
		name   string
		tag    string
		branch string
		want   bool
	}{
		{"matching branch tag", "john-v0.1.50", "john", true},
		{"different branch", "john-v0.1.50", "mike", false},
		{"main tag not branch", "v0.1.50", "john", false},
		{"dev branch tag", "dev-v0.2.5.1", "dev", true},
		{"empty tag", "", "john", false},
		{"empty branch", "john-v0.1.50", "", false},
		{"partial match", "john-v0.1.50", "jo", false},
		{"tag without version", "john-x0.1.50", "john", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsBranchTag(tt.tag, tt.branch)
			if got != tt.want {
				t.Errorf("IsBranchTag(%q, %q) = %v, want %v", tt.tag, tt.branch, got, tt.want)
			}
		})
	}
}

func TestExtractVersion(t *testing.T) {
	tests := []struct {
		name   string
		tag    string
		branch string
		want   string
	}{
		{"main tag", "v0.1.50", "", "0.1.50"},
		{"main tag with main branch", "v0.1.50", "main", "0.1.50"},
		{"branch tag", "john-v0.2.5.1", "john", "0.2.5.1"},
		{"branch tag different branch", "john-v0.2.5.1", "mike", "john-v0.2.5.1"},
		{"dev branch tag", "dev-v0.2.5.1", "dev", "0.2.5.1"},
		{"no prefix", "0.1.50", "", "0.1.50"},
		{"branch tag no branch specified", "john-v0.2.5.1", "", "john-v0.2.5.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractVersion(tt.tag, tt.branch)
			if got != tt.want {
				t.Errorf("ExtractVersion(%q, %q) = %q, want %q", tt.tag, tt.branch, got, tt.want)
			}
		})
	}
}

func TestBuildTag(t *testing.T) {
	tests := []struct {
		name   string
		ver    string
		branch string
		want   string
	}{
		{"main branch", "0.2.5", "main", "v0.2.5"},
		{"empty branch", "0.2.5", "", "v0.2.5"},
		{"john branch", "0.2.5.1", "john", "john-v0.2.5.1"},
		{"dev branch", "0.2.5.1", "dev", "dev-v0.2.5.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BuildTag(tt.ver, tt.branch, "")
			if got != tt.want {
				t.Errorf("BuildTag(%q, %q, \"\") = %q, want %q", tt.ver, tt.branch, got, tt.want)
			}
		})
	}
}

func TestBuildDownloadURL(t *testing.T) {
	cfg := config.Default()

	url := BuildDownloadURL(cfg, "TestSpine", "v0.2.5", "spine-linux-amd64")
	expected := "https://github.com/YouEye-Platform/TestSpine/releases/download/v0.2.5/spine-linux-amd64"
	if url != expected {
		t.Errorf("BuildDownloadURL() = %q, want %q", url, expected)
	}

	// Branch tag
	url2 := BuildDownloadURL(cfg, "TestCP", "john-v0.2.5.1", "standalone.tar")
	expected2 := "https://github.com/YouEye-Platform/TestCP/releases/download/john-v0.2.5.1/standalone.tar"
	if url2 != expected2 {
		t.Errorf("BuildDownloadURL() = %q, want %q", url2, expected2)
	}
}

func TestFindAsset(t *testing.T) {
	release := &Release{
		TagName: "v0.2.5",
		Assets: []Asset{
			{Name: "spine-linux-amd64", BrowserDownloadURL: "https://example.com/spine", Size: 1024},
			{Name: "standalone.tar", BrowserDownloadURL: "https://example.com/tar", Size: 2048},
		},
	}

	t.Run("found", func(t *testing.T) {
		asset := release.FindAsset("spine-linux-amd64")
		if asset == nil {
			t.Fatal("expected to find asset")
		}
		if asset.Size != 1024 {
			t.Errorf("expected size 1024, got %d", asset.Size)
		}
	})

	t.Run("not found", func(t *testing.T) {
		asset := release.FindAsset("nonexistent")
		if asset != nil {
			t.Error("expected nil for nonexistent asset")
		}
	})

	t.Run("empty assets", func(t *testing.T) {
		empty := &Release{TagName: "v0.1.0", Assets: nil}
		asset := empty.FindAsset("anything")
		if asset != nil {
			t.Error("expected nil for empty assets")
		}
	})
}

// mockReleaseServer creates a test server that returns mock release data.
// When provider is "github", it validates the required GitHub headers.
func mockReleaseServer(t *testing.T, releases []Release) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(releases)
	}))
}

// mockGiteaServer creates a test server that returns mock release data
func mockGiteaServer(t *testing.T, releases []Release) *httptest.Server {
	return mockReleaseServer(t, releases)
}

func testConfig(serverURL string) *config.Config {
	cfg := config.Default()
	cfg.Releases.BaseURL = serverURL
	cfg.Releases.APIPath = "/api/v1"
	cfg.Releases.Organization = "testorg"
	cfg.Releases.Repositories.Spine = "TestSpine"
	cfg.Releases.Repositories.ControlPanel = "TestCP"
	return cfg
}

func testGitHubConfig(serverURL string) *config.Config {
	cfg := config.Default()
	cfg.Releases.Provider = "github"
	cfg.Releases.BaseURL = serverURL
	cfg.Releases.Organization = "youeye-platform"
	cfg.Releases.Repositories.Spine = "YouEye"
	cfg.Releases.Repositories.ControlPanel = "YouEye"
	return cfg
}

func TestGetLatestVersionForBranch_MainBranch(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.3"},
		{TagName: "v0.2.5"},
		{TagName: "v0.2.4"},
		{TagName: "john-v0.2.5.1"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main", "")
	if got != "0.2.5" {
		t.Errorf("GetLatestVersionForBranch(main) = %q, want %q", got, "0.2.5")
	}
}

func TestGetLatestVersionForBranch_EmptyBranch(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.3"},
		{TagName: "v0.2.5"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "", "")
	if got != "0.2.5" {
		t.Errorf("GetLatestVersionForBranch('') = %q, want %q", got, "0.2.5")
	}
}

func TestGetLatestVersionForBranch_BranchNewerThanMain(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.5"},
		{TagName: "john-v0.2.5.1"},
		{TagName: "john-v0.2.5.2"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john", "")
	if got != "0.2.5.2" {
		t.Errorf("GetLatestVersionForBranch(john) = %q, want %q", got, "0.2.5.2")
	}
}

func TestGetLatestVersionForBranch_MainNewerThanBranch(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.6"},
		{TagName: "john-v0.2.5.1"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john", "")
	if got != "0.2.6" {
		t.Errorf("GetLatestVersionForBranch(john, main newer) = %q, want %q", got, "0.2.6")
	}
}

func TestGetLatestVersionForBranch_NoBranchReleases(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.5"},
		{TagName: "mike-v0.2.5.1"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john", "")
	if got != "0.2.5" {
		t.Errorf("GetLatestVersionForBranch(john, no john releases) = %q, want %q", got, "0.2.5")
	}
}

func TestGetLatestVersionForBranch_EmptyReleases(t *testing.T) {
	server := mockGiteaServer(t, []Release{})
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main", "")
	if got != "unknown" {
		t.Errorf("GetLatestVersionForBranch(empty) = %q, want %q", got, "unknown")
	}
}

func TestGetLatestVersionForBranch_OnlyBranchReleases(t *testing.T) {
	mockReleases := []Release{
		{TagName: "john-v0.2.5.1"},
		{TagName: "john-v0.2.5.2"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john", "")
	if got != "0.2.5.2" {
		t.Errorf("GetLatestVersionForBranch(john only) = %q, want %q", got, "0.2.5.2")
	}
}

func TestGetLatestVersionForBranch_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main", "")
	if got != "unknown" {
		t.Errorf("GetLatestVersionForBranch(server error) = %q, want %q", got, "unknown")
	}
}

func TestBuildReleasesAPIURL_GitHub(t *testing.T) {
	cfg := config.Default()
	url := buildReleasesAPIURL(cfg, "YouEye")
	expected := "https://api.github.com/repos/YouEye-Platform/YouEye/releases?per_page=50"
	if url != expected {
		t.Errorf("buildReleasesAPIURL(github) = %q, want %q", url, expected)
	}
}

func TestBuildReleasesAPIURL_Gitea(t *testing.T) {
	cfg := config.Default()
	cfg.Releases.Provider = "gitea"
	cfg.Releases.BaseURL = "https://gitea.example.com"
	cfg.Releases.APIPath = "/api/v1"
	cfg.Releases.Organization = "testorg"
	url := buildReleasesAPIURL(cfg, "YouEye")
	expected := "https://gitea.example.com/api/v1/repos/testorg/YouEye/releases?limit=50"
	if url != expected {
		t.Errorf("buildReleasesAPIURL(github) = %q, want %q", url, expected)
	}
}

func TestGitHubProviderHeaders(t *testing.T) {
	// Verify that Gitea provider does NOT send GitHub-specific headers
	var gotAccept string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]Release{{TagName: "spine-v0.3.2"}})
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	_, _ = fetchReleases(cfg, "YouEye")
	if gotAccept != "" {
		t.Errorf("Gitea provider should not send Accept header, got %q", gotAccept)
	}
}

func TestGetLatestVersionForBranch_GitHubProvider(t *testing.T) {
	// GitHub uses the same JSON format, so mock server works identically
	mockReleases := []Release{
		{TagName: "spine-v0.3.2"},
		{TagName: "spine-v0.3.1"},
		{TagName: "spine-sebastian-v0.3.2.1"},
	}

	server := mockReleaseServer(t, mockReleases)
	defer server.Close()

	// Use gitea provider pointing at mock server (response format is identical)
	cfg := testConfig(server.URL)
	cfg.Releases.Repositories.Spine = "YouEye"

	got := GetLatestVersionForBranch(cfg, "YouEye", "main", "spine")
	if got != "0.3.2" {
		t.Errorf("GetLatestVersionForBranch(main, spine prefix) = %q, want %q", got, "0.3.2")
	}

	got2 := GetLatestVersionForBranch(cfg, "YouEye", "sebastian", "spine")
	if got2 != "0.3.2.1" {
		t.Errorf("GetLatestVersionForBranch(sebastian, spine prefix) = %q, want %q", got2, "0.3.2.1")
	}
}

func TestBuildDownloadURL_GitHub(t *testing.T) {
	cfg := config.Default()
	cfg.Releases.Provider = "github"
	cfg.Releases.BaseURL = "https://github.com"
	cfg.Releases.Organization = "youeye-platform"

	url := BuildDownloadURL(cfg, "YouEye", "spine-v0.3.2", "spine-linux-amd64")
	expected := "https://github.com/youeye-platform/YouEye/releases/download/spine-v0.3.2/spine-linux-amd64"
	if url != expected {
		t.Errorf("BuildDownloadURL(github) = %q, want %q", url, expected)
	}
}
