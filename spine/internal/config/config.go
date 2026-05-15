// Package config provides configuration management for Spine.
// Configuration is loaded from multiple sources with the following precedence:
// 1. CLI flags (highest priority)
// 2. Environment variables (SPINE_*)
// 3. Config file (/etc/spine/config.yaml or ~/.spine/config.yaml)
// 4. Default values (lowest priority)
package config

// Config is the root configuration structure for Spine.
type Config struct {
	// Releases configures where to fetch updates from
	Releases ReleasesConfig `mapstructure:"releases" yaml:"releases"`

	// Deployment configures container and application settings
	Deployment DeploymentConfig `mapstructure:"deployment" yaml:"deployment"`

	// API configures the Unix socket API server
	API APIConfig `mapstructure:"api" yaml:"api"`

	// Paths configures filesystem locations
	Paths PathsConfig `mapstructure:"paths" yaml:"paths"`

	// Security configures security-related settings
	Security SecurityConfig `mapstructure:"security" yaml:"security"`

	// Logging configures log output
	Logging LoggingConfig `mapstructure:"logging" yaml:"logging"`
}

// ReleasesConfig configures the release source for updates.
type ReleasesConfig struct {
	// Provider is the release provider type: "gitea", "github", or "custom"
	Provider string `mapstructure:"provider" yaml:"provider"`

	// BaseURL is the base URL of the release server
	BaseURL string `mapstructure:"base_url" yaml:"base_url"`

	// APIPath is the API path prefix (e.g., "/api/v1" for Gitea)
	APIPath string `mapstructure:"api_path" yaml:"api_path"`

	// Organization is the owner/organization name
	Organization string `mapstructure:"organization" yaml:"organization"`

	// Repositories maps component names to repository names
	Repositories RepositoriesConfig `mapstructure:"repositories" yaml:"repositories"`
}

// RepositoriesConfig maps components to their repository names and tag prefixes.
// In the YouEye monorepo, all three repos point to "YouEye" and the tag prefix
// distinguishes releases: spine-v0.2.21, cp-v0.2.21, ui-v0.2.21.
type RepositoriesConfig struct {
	// Spine is the repository name for Spine releases
	Spine string `mapstructure:"spine" yaml:"spine"`

	// ControlPanel is the repository name for Control Panel releases
	ControlPanel string `mapstructure:"control_panel" yaml:"control_panel"`

	// UI is the repository name for UI releases
	UI string `mapstructure:"ui" yaml:"ui"`

	// SpineTagPrefix is the tag prefix for Spine releases (e.g. "spine" → "spine-v0.2.21")
	SpineTagPrefix string `mapstructure:"spine_tag_prefix" yaml:"spine_tag_prefix"`

	// ControlPanelTagPrefix is the tag prefix for Control Panel releases (e.g. "cp" → "cp-v0.2.21")
	ControlPanelTagPrefix string `mapstructure:"control_panel_tag_prefix" yaml:"control_panel_tag_prefix"`

	// UITagPrefix is the tag prefix for UI releases (e.g. "ui" → "ui-v0.2.21")
	UITagPrefix string `mapstructure:"ui_tag_prefix" yaml:"ui_tag_prefix"`
}

// DeploymentConfig configures deployment settings.
type DeploymentConfig struct {
	// Container configures the Incus container
	Container ContainerConfig `mapstructure:"container" yaml:"container"`

	// ControlPanel configures the Control Panel application
	ControlPanel ControlPanelConfig `mapstructure:"control_panel" yaml:"control_panel"`

	// UI configures the YouEye UI application
	UI UIConfig `mapstructure:"ui" yaml:"ui"`

	// Incus configures Incus settings
	Incus IncusConfig `mapstructure:"incus" yaml:"incus"`
}

// ContainerConfig configures the container settings.
type ContainerConfig struct {
	// Name is the container name
	Name string `mapstructure:"name" yaml:"name"`

	// Image is the container image to use
	Image string `mapstructure:"image" yaml:"image"`

	// Privileged controls whether to try unprivileged first
	Privileged bool `mapstructure:"privileged" yaml:"privileged"`
}

// ControlPanelConfig configures the Control Panel application.
type ControlPanelConfig struct {
	// Port is the HTTP port to listen on
	Port int `mapstructure:"port" yaml:"port"`

	// AppDir is the application installation directory inside the container
	AppDir string `mapstructure:"app_dir" yaml:"app_dir"`

	// NodeVersion is the Node.js major version to install
	NodeVersion string `mapstructure:"node_version" yaml:"node_version"`
}

// UIConfig configures the YouEye UI application.
type UIConfig struct {
	// ContainerName is the Incus container name for the UI
	ContainerName string `mapstructure:"container_name" yaml:"container_name"`

	// Port is the HTTP port the UI listens on
	Port int `mapstructure:"port" yaml:"port"`

	// AppDir is the application installation directory inside the container
	AppDir string `mapstructure:"app_dir" yaml:"app_dir"`

	// NodeVersion is the Node.js major version to install
	NodeVersion string `mapstructure:"node_version" yaml:"node_version"`
}

// IncusConfig configures Incus settings.
type IncusConfig struct {
	// Network is the bridge network name
	Network string `mapstructure:"network" yaml:"network"`

	// StoragePool is the storage pool name
	StoragePool string `mapstructure:"storage_pool" yaml:"storage_pool"`

	// StorageDriver is the storage driver type
	StorageDriver string `mapstructure:"storage_driver" yaml:"storage_driver"`

	// StoragePath is the storage pool path
	StoragePath string `mapstructure:"storage_path" yaml:"storage_path"`
}

// APIConfig configures the API server.
type APIConfig struct {
	// SocketPath is the Unix socket file path
	SocketPath string `mapstructure:"socket_path" yaml:"socket_path"`

	// SocketPermissions is the Unix permissions for the socket file
	SocketPermissions int `mapstructure:"socket_permissions" yaml:"socket_permissions"`

	// Auth configures authentication settings
	Auth AuthConfig `mapstructure:"auth" yaml:"auth"`
}

// AuthConfig configures authentication rate limiting.
type AuthConfig struct {
	// MaxAttempts is the maximum login attempts per window
	MaxAttempts int `mapstructure:"max_attempts" yaml:"max_attempts"`

	// WindowMinutes is the rate limit window in minutes
	WindowMinutes int `mapstructure:"window_minutes" yaml:"window_minutes"`

	// CleanupIntervalMinutes is how often to clean expired entries
	CleanupIntervalMinutes int `mapstructure:"cleanup_interval_minutes" yaml:"cleanup_interval_minutes"`
}

// PathsConfig configures filesystem paths.
type PathsConfig struct {
	// IncusSocket is the Incus Unix socket path
	IncusSocket string `mapstructure:"incus_socket" yaml:"incus_socket"`

	// SpineBinary is the Spine binary installation path
	SpineBinary string `mapstructure:"spine_binary" yaml:"spine_binary"`

	// SystemdServices is the systemd service directory
	SystemdServices string `mapstructure:"systemd_services" yaml:"systemd_services"`

	// ConfigDir is the Spine configuration directory
	ConfigDir string `mapstructure:"config_dir" yaml:"config_dir"`
}

// SecurityConfig configures security settings.
type SecurityConfig struct {
	// JWTSecretLength is the byte length for auto-generated JWT secrets
	JWTSecretLength int `mapstructure:"jwt_secret_length" yaml:"jwt_secret_length"`

	// EnableCSRF enables CSRF protection
	EnableCSRF bool `mapstructure:"enable_csrf" yaml:"enable_csrf"`

	// SecureCookies enables secure cookie flag (HTTPS only)
	SecureCookies bool `mapstructure:"secure_cookies" yaml:"secure_cookies"`

	// BackupOnUpdate creates backups before updates
	BackupOnUpdate bool `mapstructure:"backup_on_update" yaml:"backup_on_update"`
}

// LoggingConfig configures logging output.
type LoggingConfig struct {
	// Level is the log level: "debug", "info", "warn", "error"
	Level string `mapstructure:"level" yaml:"level"`

	// Format is the output format: "text" or "json"
	Format string `mapstructure:"format" yaml:"format"`
}

// GetReleasesAPIURL returns the full API URL for releases.
func (c *Config) GetReleasesAPIURL() string {
	return c.Releases.BaseURL + c.Releases.APIPath
}

// GetSpineRepoPath returns the full repository path for Spine.
func (c *Config) GetSpineRepoPath() string {
	return c.Releases.Organization + "/" + c.Releases.Repositories.Spine
}

// GetControlPanelRepoPath returns the full repository path for Control Panel.
func (c *Config) GetControlPanelRepoPath() string {
	return c.Releases.Organization + "/" + c.Releases.Repositories.ControlPanel
}

// GetUIRepoPath returns the full repository path for YE-UI.
func (c *Config) GetUIRepoPath() string {
	return c.Releases.Organization + "/" + c.Releases.Repositories.UI
}
