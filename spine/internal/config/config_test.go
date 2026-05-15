package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := Default()

	if cfg.Releases.BaseURL != "https://github.com" {
		t.Errorf("default BaseURL = %q, want %q", cfg.Releases.BaseURL, "https://github.com")
	}
	if cfg.Releases.Organization != "YouEye-Platform" {
		t.Errorf("default Organization = %q, want %q", cfg.Releases.Organization, "YouEye-Platform")
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
	cfg.Releases.BaseURL = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty BaseURL")
	}
}

func TestValidateEmptyOrganization(t *testing.T) {
	cfg := Default()
	cfg.Releases.Organization = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty Organization")
	}
}

func TestValidateEmptySpineRepo(t *testing.T) {
	cfg := Default()
	cfg.Releases.Repositories.Spine = ""
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for empty Spine repo")
	}
}

func TestValidateEmptyControlPanelRepo(t *testing.T) {
	cfg := Default()
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
	expected := "https://github.com"
	if url != expected {
		t.Errorf("GetReleasesAPIURL() = %q, want %q", url, expected)
	}
}

func TestGetRepoPath(t *testing.T) {
	cfg := Default()

	if path := cfg.GetSpineRepoPath(); path != "YouEye-Platform/YouEye" {
		t.Errorf("GetSpineRepoPath() = %q", path)
	}
	if path := cfg.GetControlPanelRepoPath(); path != "YouEye-Platform/YouEye" {
		t.Errorf("GetControlPanelRepoPath() = %q", path)
	}
	if path := cfg.GetUIRepoPath(); path != "YouEye-Platform/YouEye" {
		t.Errorf("GetUIRepoPath() = %q", path)
	}
}

func TestLoadFromFile(t *testing.T) {
	// Create a temp config file
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	content := `
releases:
  base_url: "https://custom.example.com"
  organization: "testorg"
  repositories:
    spine: "TestSpine"
    control_panel: "TestCP"
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

	if cfg.Releases.BaseURL != "https://custom.example.com" {
		t.Errorf("BaseURL = %q, want custom URL", cfg.Releases.BaseURL)
	}
	if cfg.Releases.Organization != "testorg" {
		t.Errorf("Organization = %q, want testorg", cfg.Releases.Organization)
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
	// Valid YAML but invalid config (empty base_url)
	content := `
releases:
  base_url: ""
  organization: "test"
  repositories:
    spine: "s"
    control_panel: "cp"
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
		t.Error("expected validation error for empty base_url")
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
	if cfg.Releases.BaseURL != "https://github.com" {
		t.Errorf("Get() should return defaults when loading fails, got BaseURL=%q", cfg.Releases.BaseURL)
	}
}
