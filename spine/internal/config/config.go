// Package config provides configuration management for Spine.
// Configuration is loaded from multiple sources with the following precedence:
// 1. CLI flags (highest priority)
// 2. Environment variables (SPINE_*)
// 3. Config file (/etc/spine/config.yaml or ~/.spine/config.yaml)
// 4. Default values (lowest priority)
package config

import (
	"fmt"
	"net/url"
	"strings"
)

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
	// RepoURL is the canonical core monorepo URL for Spine, Control Panel, and UI releases.
	RepoURL string `mapstructure:"repo_url" yaml:"repo_url"`

	// Provider is the release provider type: "gitea", "github", or "custom"
	// Deprecated: derived from RepoURL. Kept for old config files.
	Provider string `mapstructure:"provider" yaml:"provider"`

	// BaseURL is the base URL of the release server
	// Deprecated: derived from RepoURL. Kept for old config files.
	BaseURL string `mapstructure:"base_url" yaml:"base_url"`

	// APIPath is the API path prefix (e.g., "/api/v1" for Gitea)
	// Deprecated: derived from RepoURL. Kept for old config files.
	APIPath string `mapstructure:"api_path" yaml:"api_path"`

	// Organization is the owner/organization name
	// Deprecated: derived from RepoURL. Kept for old config files.
	Organization string `mapstructure:"organization" yaml:"organization"`

	// Repositories maps component names to repository names
	// Deprecated: core components now share RepoURL. Kept for old config files.
	Repositories RepositoriesConfig `mapstructure:"repositories" yaml:"repositories"`
}

// ReleaseRepo describes the normalized core release repository.
type ReleaseRepo struct {
	Provider     string
	BaseURL      string
	APIPath      string
	Organization string
	Repository   string
	RepoURL      string
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

	// Storage configures host and Incus storage stewardship.
	Storage StorageConfig `mapstructure:"storage" yaml:"storage"`
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

// StorageConfig configures appliance-style host storage management.
type StorageConfig struct {
	// Mode controls storage automation. "appliance" is the default.
	Mode string `mapstructure:"mode" yaml:"mode"`

	// AutoExpandRoot grows safe root LVM layouts before deployment.
	AutoExpandRoot bool `mapstructure:"auto_expand_root" yaml:"auto_expand_root"`

	// AutoGrowIncus grows managed loop-backed Incus pools upward.
	AutoGrowIncus bool `mapstructure:"auto_grow_incus" yaml:"auto_grow_incus"`

	// HostReserveGB leaves this much normal root filesystem headroom.
	HostReserveGB int `mapstructure:"host_reserve_gb" yaml:"host_reserve_gb"`

	// MaxIncusPoolPercent caps Incus pool size as a percent of root filesystem size.
	MaxIncusPoolPercent int `mapstructure:"max_incus_pool_percent" yaml:"max_incus_pool_percent"`
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
	repo := c.CoreReleaseRepo()
	if repo.Provider == "github" {
		return "https://api.github.com/repos/" + repo.Organization + "/" + repo.Repository + "/releases?per_page=50"
	}
	return repo.BaseURL + repo.APIPath + "/repos/" + repo.Organization + "/" + repo.Repository + "/releases?limit=50"
}

// GetSpineRepoPath returns the full repository path for Spine.
func (c *Config) GetSpineRepoPath() string {
	repo := c.CoreReleaseRepo()
	return repo.Organization + "/" + repo.Repository
}

// GetControlPanelRepoPath returns the full repository path for Control Panel.
func (c *Config) GetControlPanelRepoPath() string {
	repo := c.CoreReleaseRepo()
	return repo.Organization + "/" + repo.Repository
}

// GetUIRepoPath returns the full repository path for YE-UI.
func (c *Config) GetUIRepoPath() string {
	repo := c.CoreReleaseRepo()
	return repo.Organization + "/" + repo.Repository
}

// CoreReleaseRepo returns the normalized core monorepo release source.
// RepoURL is canonical; old multi-field config is accepted as a migration fallback.
func (c *Config) CoreReleaseRepo() ReleaseRepo {
	repo, err := ParseReleaseRepoURL(c.Releases.RepoURL)
	if err == nil {
		return repo
	}

	base := strings.TrimRight(c.Releases.BaseURL, "/")
	org := strings.Trim(c.Releases.Organization, "/")
	repoName := c.Releases.Repositories.Spine
	if repoName == "" {
		repoName = c.Releases.Repositories.ControlPanel
	}
	if repoName == "" {
		repoName = c.Releases.Repositories.UI
	}
	if repoName == "" {
		repoName = "YouEye"
	}
	if base == "" {
		base = "https://github.com"
	}
	if org == "" {
		org = "youeye-platform"
	}

	provider := c.Releases.Provider
	if provider == "" {
		provider = detectReleaseProvider(base)
	}
	apiPath := c.Releases.APIPath
	if apiPath == "" && provider != "github" {
		apiPath = "/api/v1"
	}
	return ReleaseRepo{
		Provider:     provider,
		BaseURL:      base,
		APIPath:      apiPath,
		Organization: org,
		Repository:   repoName,
		RepoURL:      base + "/" + org + "/" + repoName,
	}
}

// ParseReleaseRepoURL validates and normalizes a core release repository URL.
func ParseReleaseRepoURL(raw string) (ReleaseRepo, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ReleaseRepo{}, fmt.Errorf("repo URL is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ReleaseRepo{}, fmt.Errorf("invalid repo URL: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return ReleaseRepo{}, fmt.Errorf("repo URL must start with http:// or https://")
	}
	if u.Host == "" {
		return ReleaseRepo{}, fmt.Errorf("repo URL host is required")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return ReleaseRepo{}, fmt.Errorf("repo URL must include owner and repository")
	}
	org := parts[0]
	repo := strings.TrimSuffix(parts[1], ".git")
	baseURL := u.Scheme + "://" + u.Host
	provider := detectReleaseProvider(baseURL)
	apiPath := ""
	if provider != "github" {
		apiPath = "/api/v1"
	}
	return ReleaseRepo{
		Provider:     provider,
		BaseURL:      baseURL,
		APIPath:      apiPath,
		Organization: org,
		Repository:   repo,
		RepoURL:      baseURL + "/" + org + "/" + repo,
	}, nil
}

func detectReleaseProvider(baseURL string) string {
	u, err := url.Parse(baseURL)
	host := ""
	if err == nil {
		host = strings.ToLower(u.Host)
	}
	if host == "" {
		host = strings.ToLower(strings.TrimPrefix(strings.TrimPrefix(baseURL, "https://"), "http://"))
	}
	if host == "github.com" || strings.HasSuffix(host, ".github.com") {
		return "github"
	}
	return "gitea"
}
