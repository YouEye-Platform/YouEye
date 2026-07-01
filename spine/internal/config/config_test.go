package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := Default()

	if cfg.Releases.RepoURL != "https://github.com/youeye-platform/YouEye" {
		t.Errorf("default RepoURL = %q, want %q", cfg.Releases.RepoURL, "https://github.com/youeye-platform/YouEye")
	}
	if cfg.CoreReleaseRepo().Organization != "youeye-platform" {
		t.Errorf("default Organization = %q, want %q", cfg.CoreReleaseRepo().Organization, "youeye-platform")
	}
	if cfg.Releases.Repositories.Spine != "YouEye" {
		t.Errorf("default Spine repo = %q, want %q", cfg.Releases.Repositories.Spine, "YouEye")
	}
	if cfg.Releases.Repositories.ControlPanel != "YouEye" {
		t.Errorf("default ControlPanel repo = %q", cfg.Releases.Repositories.ControlPanel)
	}
	if cfg.Deployment.Container.Name != "youeye-control" {
		t.Errorf("default container name = %q", cfg.Deployment.Container.Name)
	}
	if cfg.Deployment.ControlPanel.Port != 3000 {
		t.Errorf("default CP port = %d, want 3000", cfg.Deployment.ControlPanel.Port)
	}
	if cfg.Deployment.UI.AppDir != "/opt/youeye-ui" {
		t.Errorf("default UI app dir = %q, want /opt/youeye-ui", cfg.Deployment.UI.AppDir)
	}
	if cfg.API.Auth.MaxAttempts != 5 {
		t.Errorf("default MaxAttempts = %d, want 5", cfg.API.Auth.MaxAttempts)
	}
	if cfg.Logging.Level != "info" {
		t.Errorf("default log level = %q, want %q", cfg.Logging.Level, "info")
	}
	if cfg.Logging.Format != "text" {
		t.Errorf("default log format = %q, want %q", cfg.Logging.Format, "text")
	}
}

func TestValidateDefaultConfig(t *testing.T) {
	cfg := Default()
	err := cfg.Validate()
	if err != nil {
		t.Errorf("default config should be valid, got error: %v", err)
	}
}

func TestValidateEmptyBaseURL(t *testing.T) {
	cfg := Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.BaseURL = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty BaseURL")
	}
}

func TestValidateEmptyOrganization(t *testing.T) {
	cfg := Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.Organization = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty Organization")
	}
}

func TestValidateEmptySpineRepo(t *testing.T) {
	cfg := Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.Repositories.Spine = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty Spine repo")
	}
}

func TestValidateEmptyControlPanelRepo(t *testing.T) {
	cfg := Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.Repositories.ControlPanel = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty ControlPanel repo")
	}
}

func TestValidateEmptyContainerName(t *testing.T) {
	cfg := Default()
	cfg.Deployment.Container.Name = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty container name")
	}
}

func TestValidateInvalidPort(t *testing.T) {
	tests := []struct {
		name string
		port int
	}{
		{"zero port", 0},
		{"negative port", -1},
		{"too high port", 65536},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Default()
			cfg.Deployment.ControlPanel.Port = tt.port
			err := cfg.Validate()
			if err == nil {
				t.Errorf("expected error for port %d", tt.port)
			}
		})
	}
}

func TestValidateValidPort(t *testing.T) {
	tests := []int{1, 80, 443, 3000, 8080, 65535}

	for _, port := range tests {
		cfg := Default()
		cfg.Deployment.ControlPanel.Port = port
		err := cfg.Validate()
		if err != nil {
			t.Errorf("port %d should be valid, got error: %v", port, err)
		}
	}
}

func TestValidateEmptySocketPath(t *testing.T) {
	cfg := Default()
	cfg.API.SocketPath = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty SocketPath")
	}
}

func TestValidateInvalidMaxAttempts(t *testing.T) {
	cfg := Default()
	cfg.API.Auth.MaxAttempts = 0
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for MaxAttempts=0")
	}
}

func TestValidateInvalidWindowMinutes(t *testing.T) {
	cfg := Default()
	cfg.API.Auth.WindowMinutes = 0
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for WindowMinutes=0")
	}
}

func TestValidateInvalidLogLevel(t *testing.T) {
	cfg := Default()
	cfg.Logging.Level = "trace"
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for invalid log level")
	}
}

func TestValidateValidLogLevels(t *testing.T) {
	for _, level := range []string{"debug", "info", "warn", "error"} {
		cfg := Default()
		cfg.Logging.Level = level
		err := cfg.Validate()
		if err != nil {
			t.Errorf("level %q should be valid, got: %v", level, err)
		}
	}
}

func TestValidateInvalidLogFormat(t *testing.T) {
	cfg := Default()
	cfg.Logging.Format = "xml"
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for invalid log format")
	}
}

func TestValidateValidLogFormats(t *testing.T) {
	for _, format := range []string{"text", "json"} {
		cfg := Default()
		cfg.Logging.Format = format
		err := cfg.Validate()
		if err != nil {
			t.Errorf("format %q should be valid, got: %v", format, err)
		}
	}
}

func TestGetReleasesAPIURL(t *testing.T) {
	cfg := Default()
	url := cfg.GetReleasesAPIURL()
	expected := "https://api.github.com/repos/youeye-platform/YouEye/releases?per_page=50"
	if url != expected {
		t.Errorf("GetReleasesAPIURL() = %q, want %q", url, expected)
	}
}

func TestGetRepoPath(t *testing.T) {
	cfg := Default()

	if path := cfg.GetSpineRepoPath(); path != "youeye-platform/YouEye" {
		t.Errorf("GetSpineRepoPath() = %q", path)
	}
	if path := cfg.GetControlPanelRepoPath(); path != "youeye-platform/YouEye" {
		t.Errorf("GetControlPanelRepoPath() = %q", path)
	}
	if path := cfg.GetUIRepoPath(); path != "youeye-platform/YouEye" {
		t.Errorf("GetUIRepoPath() = %q", path)
	}
}

func TestParseReleaseRepoURLForgejo(t *testing.T) {
	repo, err := ParseReleaseRepoURL("https://forge.example.org/acme/YouEye.git")
	if err != nil {
		t.Fatalf("ParseReleaseRepoURL() error: %v", err)
	}
	if repo.Provider != "gitea" {
		t.Errorf("Provider = %q, want gitea", repo.Provider)
	}
	if repo.BaseURL != "https://forge.example.org" {
		t.Errorf("BaseURL = %q", repo.BaseURL)
	}
	if repo.Organization != "acme" || repo.Repository != "YouEye" {
		t.Errorf("repo = %s/%s, want acme/YouEye", repo.Organization, repo.Repository)
	}
	if repo.APIPath != "/api/v1" {
		t.Errorf("APIPath = %q, want /api/v1", repo.APIPath)
	}
}

func TestCoreReleaseRepoLegacyFallback(t *testing.T) {
	cfg := Default()
	cfg.Releases.RepoURL = ""
	cfg.Releases.Provider = "gitea"
	cfg.Releases.BaseURL = "https://forge.example.org"
	cfg.Releases.APIPath = "/api/v1"
	cfg.Releases.Organization = "acme"
	cfg.Releases.Repositories.Spine = "YouEye"

	repo := cfg.CoreReleaseRepo()
	if repo.RepoURL != "https://forge.example.org/acme/YouEye" {
		t.Errorf("RepoURL = %q", repo.RepoURL)
	}
	if repo.Provider != "gitea" {
		t.Errorf("Provider = %q", repo.Provider)
	}
}

func TestWriteCoreRepoURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(`releases:
  provider: github
  base_url: https://github.com
  organization: youeye-platform
  repositories:
    spine: YouEye
deployment:
  control_panel:
    app_dir: /opt/app
`), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := WriteCoreRepoURL(path, "https://forge.example.org/acme/YouEye"); err != nil {
		t.Fatalf("WriteCoreRepoURL() error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, "repo_url: https://forge.example.org/acme/YouEye") {
		t.Fatalf("repo_url not written:\n%s", text)
	}
	if strings.Contains(text, "provider:") || strings.Contains(text, "base_url:") || strings.Contains(text, "organization:") || strings.Contains(text, "repositories:") {
		t.Fatalf("deprecated release source keys were not removed:\n%s", text)
	}
}

func TestLoadFromFile(t *testing.T) {
	// Create a temp config file
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	content := `
releases:
  repo_url: "https://custom.example.com/testorg/TestSpine"
deployment:
  container:
    name: "test-container"
  control_panel:
    port: 8080
api:
  socket_path: "/tmp/test.sock"
  auth:
    max_attempts: 3
    window_minutes: 10
logging:
  level: "debug"
  format: "json"
`
	if err := os.WriteFile(cfgPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	Reset() // Clear global state
	cfg, err := LoadFromFile(cfgPath)
	if err != nil {
		t.Fatalf("LoadFromFile() error: %v", err)
	}

	if cfg.CoreReleaseRepo().BaseURL != "https://custom.example.com" {
		t.Errorf("BaseURL = %q, want custom URL", cfg.CoreReleaseRepo().BaseURL)
	}
	if cfg.CoreReleaseRepo().Organization != "testorg" {
		t.Errorf("Organization = %q, want testorg", cfg.CoreReleaseRepo().Organization)
	}
	if cfg.Deployment.ControlPanel.Port != 8080 {
		t.Errorf("Port = %d, want 8080", cfg.Deployment.ControlPanel.Port)
	}
	if cfg.Logging.Level != "debug" {
		t.Errorf("Level = %q, want debug", cfg.Logging.Level)
	}
	if cfg.Logging.Format != "json" {
		t.Errorf("Format = %q, want json", cfg.Logging.Format)
	}
}

func TestLoadFromFileInvalidYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("invalid: [yaml: broken"), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	Reset()
	_, err := LoadFromFile(cfgPath)
	if err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func TestLoadFromFileNotFound(t *testing.T) {
	Reset()
	_, err := LoadFromFile("/nonexistent/config.yaml")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestLoadFromFileInvalidConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	// Valid YAML but invalid config (empty repo_url)
	content := `
releases:
  repo_url: "not-a-url"
deployment:
  container:
    name: "c"
  control_panel:
    port: 3000
api:
  socket_path: "/tmp/s.sock"
  auth:
    max_attempts: 1
    window_minutes: 1
logging:
  level: "info"
  format: "text"
`
	if err := os.WriteFile(cfgPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	Reset()
	_, err := LoadFromFile(cfgPath)
	if err == nil {
		t.Error("expected validation error for invalid repo_url")
	}
}

func TestReset(t *testing.T) {
	Reset()
	if configFile != "" {
		t.Error("Reset should clear configFile")
	}
	if globalConfig != nil {
		t.Error("Reset should clear globalConfig")
	}
}

func TestGetReturnsDefault(t *testing.T) {
	Reset()
	cfg := Get()
	if cfg == nil {
		t.Fatal("Get() should never return nil")
	}
	if cfg.CoreReleaseRepo().RepoURL != "https://github.com/youeye-platform/YouEye" {
		t.Errorf("Get() should return defaults when loading fails, got BaseURL=%q", cfg.Releases.BaseURL)
	}
}
