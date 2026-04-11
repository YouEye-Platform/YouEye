package releases

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
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
			got := BuildTag(tt.ver, tt.branch)
			if got != tt.want {
				t.Errorf("BuildTag(%q, %q) = %q, want %q", tt.ver, tt.branch, got, tt.want)
			}
		})
	}
}

func TestBuildDownloadURL(t *testing.T) {
	cfg := config.Default()

	url := BuildDownloadURL(cfg, "YE-Spine", "v0.2.5", "spine-linux-amd64")
	expected := "https://git.byka.wtf/potemsla/YouEye/spine/releases/download/v0.2.5/spine-linux-amd64"
	if url != expected {
		t.Errorf("BuildDownloadURL() = %q, want %q", url, expected)
	}

	// Branch tag
	url2 := BuildDownloadURL(cfg, "YE-ControlPanel", "john-v0.2.5.1", "standalone.tar")
	expected2 := "https://git.byka.wtf/potemsla/YE-ControlPanel/releases/download/john-v0.2.5.1/standalone.tar"
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

// mockGiteaServer creates a test server that returns mock release data
func mockGiteaServer(t *testing.T, releases []Release) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(releases)
	}))
}

func testConfig(serverURL string) *config.Config {
	cfg := config.Default()
	cfg.Releases.BaseURL = serverURL
	cfg.Releases.APIPath = "/api/v1"
	cfg.Releases.Organization = "potemsla"
	cfg.Releases.Repositories.Spine = "YE-Spine"
	cfg.Releases.Repositories.ControlPanel = "YE-ControlPanel"
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john")
	if got != "0.2.5" {
		t.Errorf("GetLatestVersionForBranch(john, no john releases) = %q, want %q", got, "0.2.5")
	}
}

func TestGetLatestVersionForBranch_EmptyReleases(t *testing.T) {
	server := mockGiteaServer(t, []Release{})
	defer server.Close()

	cfg := testConfig(server.URL)

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "john")
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

	got := GetLatestVersionForBranch(cfg, "YE-Spine", "main")
	if got != "unknown" {
		t.Errorf("GetLatestVersionForBranch(server error) = %q, want %q", got, "unknown")
	}
}

func TestClientGetReleases(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.5", Assets: []Asset{{Name: "spine-linux-amd64", Size: 1024}}},
		{TagName: "v0.2.4"},
		{TagName: "v0.2.3"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)
	client := NewClient(cfg)

	t.Run("all releases", func(t *testing.T) {
		rels, err := client.GetReleases("YE-Spine", 0)
		if err != nil {
			t.Fatalf("GetReleases() error: %v", err)
		}
		if len(rels) != 3 {
			t.Errorf("expected 3 releases, got %d", len(rels))
		}
	})

	t.Run("limited releases", func(t *testing.T) {
		rels, err := client.GetReleases("YE-Spine", 1)
		if err != nil {
			t.Fatalf("GetReleases() error: %v", err)
		}
		if len(rels) != 1 {
			t.Errorf("expected 1 release, got %d", len(rels))
		}
	})

	t.Run("version parsed", func(t *testing.T) {
		rels, err := client.GetReleases("YE-Spine", 1)
		if err != nil {
			t.Fatalf("GetReleases() error: %v", err)
		}
		if rels[0].Version != "0.2.5" {
			t.Errorf("expected version 0.2.5, got %s", rels[0].Version)
		}
	})
}

func TestClientGetLatestRelease(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.5"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)
	client := NewClient(cfg)

	t.Run("success", func(t *testing.T) {
		rel, err := client.GetLatestRelease("YE-Spine")
		if err != nil {
			t.Fatalf("GetLatestRelease() error: %v", err)
		}
		if rel.TagName != "v0.2.5" {
			t.Errorf("expected tag v0.2.5, got %s", rel.TagName)
		}
	})

	t.Run("empty releases", func(t *testing.T) {
		emptyServer := mockGiteaServer(t, []Release{})
		defer emptyServer.Close()

		emptyCfg := testConfig(emptyServer.URL)
		emptyClient := NewClient(emptyCfg)

		_, err := emptyClient.GetLatestRelease("YE-Spine")
		if err == nil {
			t.Error("expected error for empty releases")
		}
	})
}

func TestClientGetLatestVersion(t *testing.T) {
	mockReleases := []Release{
		{TagName: "v0.2.5"},
	}

	server := mockGiteaServer(t, mockReleases)
	defer server.Close()

	cfg := testConfig(server.URL)
	client := NewClient(cfg)

	ver, err := client.GetLatestVersion("YE-Spine")
	if err != nil {
		t.Fatalf("GetLatestVersion() error: %v", err)
	}
	if ver != "0.2.5" {
		t.Errorf("expected 0.2.5, got %s", ver)
	}
}

func TestClientDownloadURLs(t *testing.T) {
	cfg := config.Default()
	client := NewClient(cfg)

	t.Run("spine download URL", func(t *testing.T) {
		url := client.GetSpineDownloadURL("0.2.5", "amd64")
		expected := "https://git.byka.wtf/potemsla/YouEye/spine/releases/download/v0.2.5/spine-linux-amd64"
		if url != expected {
			t.Errorf("GetSpineDownloadURL() = %q, want %q", url, expected)
		}
	})

	t.Run("control panel download URL", func(t *testing.T) {
		url := client.GetControlPanelDownloadURL("0.2.5")
		expected := "https://git.byka.wtf/potemsla/YE-ControlPanel/releases/download/v0.2.5/standalone.tar"
		if url != expected {
			t.Errorf("GetControlPanelDownloadURL() = %q, want %q", url, expected)
		}
	})
}

func TestClientServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	client := NewClient(cfg)

	_, err := client.GetReleases("YE-Spine", 0)
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

func TestClientInvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("not valid json"))
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	client := NewClient(cfg)

	_, err := client.GetReleases("YE-Spine", 0)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}
