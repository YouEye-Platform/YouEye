// Package config provides configuration management for Spine.
// Configuration is loaded from multiple sources with the following precedence:
// 1. CLI flags (highest priority)
// 2. Environment variables (SPINE_*)
// 3. Config file (/var/lib/youeye/config, /etc/youeye, ~/.youeye or ./config.yaml)
// 4. Default values (lowest priority)
package config

// Config is the root configuration structure for Spine.
type Config struct {

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
