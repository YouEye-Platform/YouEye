package config

// Default returns a Config with all default values.
// These defaults maintain backwards compatibility with pre-0.1.0 installations.
func Default() *Config {
	return &Config{
		Releases: ReleasesConfig{
			Provider:     "gitea",
			BaseURL:      "https://git.byka.wtf",
			APIPath:      "/api/v1",
			Organization: "potemsla",
			Repositories: RepositoriesConfig{
				Spine:                 "YouEye",
				ControlPanel:          "YouEye",
				UI:                    "YouEye",
				SpineTagPrefix:        "spine",
				ControlPanelTagPrefix: "cp",
				UITagPrefix:           "ui",
			},
		},
		Deployment: DeploymentConfig{
			Container: ContainerConfig{
				Name:       "youeye-control",
				Image:      "images:debian/12",
				Privileged: false,
			},
			ControlPanel: ControlPanelConfig{
				Port:        3000,
				AppDir:      "/opt/app",
				NodeVersion: "22.x",
			},
			UI: UIConfig{
				ContainerName: "youeye-ui",
				Port:          3000,
				AppDir:        "/opt/app",
				NodeVersion:   "22.x",
			},
			Incus: IncusConfig{
				Network:       "incusbr0",
				StoragePool:   "default",
				StorageDriver: "dir",
				StoragePath:   "/var/lib/incus/storage-pools/default",
			},
		},
		API: APIConfig{
			SocketPath:        "/var/run/youeye/youeye.sock",
			SocketPermissions: 0666,
			Auth: AuthConfig{
				MaxAttempts:            5,
				WindowMinutes:          5,
				CleanupIntervalMinutes: 1,
			},
		},
		Paths: PathsConfig{
			IncusSocket:     "/var/lib/incus/unix.socket",
			SpineBinary:     "/usr/local/bin/youeye",
			SystemdServices: "/etc/systemd/system",
			ConfigDir:       "/etc/youeye",
		},
		Security: SecurityConfig{
			JWTSecretLength: 64,
			EnableCSRF:      true,
			SecureCookies:   false,
			BackupOnUpdate:  true,
		},
		Logging: LoggingConfig{
			Level:  "info",
			Format: "text",
		},
	}
}
