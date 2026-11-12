package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := Default()

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

	// A retired releases block from an old config file is ignored.
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
	// Valid YAML but invalid config (unknown log level)
	content := `
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
  level: "loud"
  format: "text"
`
	if err := os.WriteFile(cfgPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	Reset()
	_, err := LoadFromFile(cfgPath)
	if err == nil {
		t.Error("expected validation error for an invalid log level")
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
	originalLoad := loadConfig
	loadConfig = func() (*Config, error) {
		return nil, errors.New("test load failure")
	}
	t.Cleanup(func() { loadConfig = originalLoad })
	Reset()
	cfg := Get()
	if cfg == nil {
		t.Fatal("Get() should never return nil")
	}
	if cfg.Deployment.Container.Name != "youeye-control" {
		t.Errorf("Get() should return defaults when loading fails, got container %q", cfg.Deployment.Container.Name)
	}
}
