package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

var (
	// globalConfig holds the loaded configuration
	globalConfig *Config

	// configFile holds the path to the loaded config file (if any)
	configFile string
)

// Load loads configuration from all sources with proper precedence.
// It returns the merged configuration or an error if loading fails.
func Load() (*Config, error) {
	v := viper.New()

	// Set config file settings
	v.SetConfigName("config")
	v.SetConfigType("yaml")

	// Add config file search paths (in priority order)
	v.AddConfigPath("/etc/spine/")
	if home, err := os.UserHomeDir(); err == nil {
		v.AddConfigPath(filepath.Join(home, ".spine"))
	}
	v.AddConfigPath(".")

	// Enable environment variable support
	// Environment variables: SPINE_RELEASES_BASE_URL, SPINE_DEPLOYMENT_CONTAINER_NAME, etc.
	v.SetEnvPrefix("SPINE")
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	// Set all defaults from our Default() function
	setDefaults(v)

	// Try to read config file (not required - defaults are fine)
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			// Config file was found but has errors
			return nil, fmt.Errorf("error reading config file: %w", err)
		}
		// No config file found - that's okay, we'll use defaults
	} else {
		configFile = v.ConfigFileUsed()
	}

	// Unmarshal into our Config struct
	cfg := &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("error parsing config: %w", err)
	}

	// Validate the configuration
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	globalConfig = cfg
	return cfg, nil
}

// LoadFromFile loads configuration from a specific file path.
func LoadFromFile(path string) (*Config, error) {
	v := viper.New()

	v.SetConfigFile(path)

	// Enable environment variable support
	v.SetEnvPrefix("SPINE")
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	// Set all defaults
	setDefaults(v)

	// Read the specified config file
	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("error reading config file %s: %w", path, err)
	}

	configFile = path

	// Unmarshal into our Config struct
	cfg := &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("error parsing config: %w", err)
	}

	// Validate the configuration
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	globalConfig = cfg
	return cfg, nil
}

// Get returns the global configuration.
// If not loaded yet, it loads using default paths.
func Get() *Config {
	if globalConfig == nil {
		cfg, err := Load()
		if err != nil {
			// If loading fails, return defaults
			return Default()
		}
		return cfg
	}
	return globalConfig
}

// GetConfigFile returns the path to the loaded config file, or empty string if none.
func GetConfigFile() string {
	return configFile
}

// setDefaults sets all default values in the viper instance.
func setDefaults(v *viper.Viper) {
	defaults := Default()

	// Releases
	v.SetDefault("releases.provider", defaults.Releases.Provider)
	v.SetDefault("releases.base_url", defaults.Releases.BaseURL)
	v.SetDefault("releases.api_path", defaults.Releases.APIPath)
	v.SetDefault("releases.organization", defaults.Releases.Organization)
	v.SetDefault("releases.repositories.spine", defaults.Releases.Repositories.Spine)
	v.SetDefault("releases.repositories.control_panel", defaults.Releases.Repositories.ControlPanel)
	v.SetDefault("releases.repositories.ui", defaults.Releases.Repositories.UI)
	v.SetDefault("releases.repositories.spine_tag_prefix", defaults.Releases.Repositories.SpineTagPrefix)
	v.SetDefault("releases.repositories.control_panel_tag_prefix", defaults.Releases.Repositories.ControlPanelTagPrefix)
	v.SetDefault("releases.repositories.ui_tag_prefix", defaults.Releases.Repositories.UITagPrefix)

	// Deployment - Container
	v.SetDefault("deployment.container.name", defaults.Deployment.Container.Name)
	v.SetDefault("deployment.container.image", defaults.Deployment.Container.Image)
	v.SetDefault("deployment.container.privileged", defaults.Deployment.Container.Privileged)

	// Deployment - Control Panel
	v.SetDefault("deployment.control_panel.port", defaults.Deployment.ControlPanel.Port)
	v.SetDefault("deployment.control_panel.app_dir", defaults.Deployment.ControlPanel.AppDir)
	v.SetDefault("deployment.control_panel.node_version", defaults.Deployment.ControlPanel.NodeVersion)

	// Deployment - UI
	v.SetDefault("deployment.ui.container_name", defaults.Deployment.UI.ContainerName)
	v.SetDefault("deployment.ui.port", defaults.Deployment.UI.Port)
	v.SetDefault("deployment.ui.app_dir", defaults.Deployment.UI.AppDir)
	v.SetDefault("deployment.ui.node_version", defaults.Deployment.UI.NodeVersion)

	// Deployment - Incus
	v.SetDefault("deployment.incus.network", defaults.Deployment.Incus.Network)
	v.SetDefault("deployment.incus.storage_pool", defaults.Deployment.Incus.StoragePool)
	v.SetDefault("deployment.incus.storage_driver", defaults.Deployment.Incus.StorageDriver)
	v.SetDefault("deployment.incus.storage_path", defaults.Deployment.Incus.StoragePath)

	// API
	v.SetDefault("api.socket_path", defaults.API.SocketPath)
	v.SetDefault("api.socket_permissions", defaults.API.SocketPermissions)
	v.SetDefault("api.auth.max_attempts", defaults.API.Auth.MaxAttempts)
	v.SetDefault("api.auth.window_minutes", defaults.API.Auth.WindowMinutes)
	v.SetDefault("api.auth.cleanup_interval_minutes", defaults.API.Auth.CleanupIntervalMinutes)

	// Paths
	v.SetDefault("paths.incus_socket", defaults.Paths.IncusSocket)
	v.SetDefault("paths.spine_binary", defaults.Paths.SpineBinary)
	v.SetDefault("paths.systemd_services", defaults.Paths.SystemdServices)
	v.SetDefault("paths.config_dir", defaults.Paths.ConfigDir)

	// Security
	v.SetDefault("security.jwt_secret_length", defaults.Security.JWTSecretLength)
	v.SetDefault("security.enable_csrf", defaults.Security.EnableCSRF)
	v.SetDefault("security.secure_cookies", defaults.Security.SecureCookies)
	v.SetDefault("security.backup_on_update", defaults.Security.BackupOnUpdate)

	// Logging
	v.SetDefault("logging.level", defaults.Logging.Level)
	v.SetDefault("logging.format", defaults.Logging.Format)
}

// Validate checks the configuration for errors.
func (c *Config) Validate() error {
	// Validate releases configuration
	if c.Releases.BaseURL == "" {
		return fmt.Errorf("releases.base_url cannot be empty")
	}
	if c.Releases.Organization == "" {
		return fmt.Errorf("releases.organization cannot be empty")
	}
	if c.Releases.Repositories.Spine == "" {
		return fmt.Errorf("releases.repositories.spine cannot be empty")
	}
	if c.Releases.Repositories.ControlPanel == "" {
		return fmt.Errorf("releases.repositories.control_panel cannot be empty")
	}

	// Validate deployment configuration
	if c.Deployment.Container.Name == "" {
		return fmt.Errorf("deployment.container.name cannot be empty")
	}
	if c.Deployment.ControlPanel.Port < 1 || c.Deployment.ControlPanel.Port > 65535 {
		return fmt.Errorf("deployment.control_panel.port must be between 1 and 65535")
	}

	// Validate API configuration
	if c.API.SocketPath == "" {
		return fmt.Errorf("api.socket_path cannot be empty")
	}
	if c.API.Auth.MaxAttempts < 1 {
		return fmt.Errorf("api.auth.max_attempts must be at least 1")
	}
	if c.API.Auth.WindowMinutes < 1 {
		return fmt.Errorf("api.auth.window_minutes must be at least 1")
	}

	// Validate logging configuration
	validLevels := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}
	if !validLevels[c.Logging.Level] {
		return fmt.Errorf("logging.level must be one of: debug, info, warn, error")
	}
	validFormats := map[string]bool{"text": true, "json": true}
	if !validFormats[c.Logging.Format] {
		return fmt.Errorf("logging.format must be one of: text, json")
	}

	return nil
}

// Reset clears the global configuration (useful for testing).
func Reset() {
	globalConfig = nil
	configFile = ""
}
