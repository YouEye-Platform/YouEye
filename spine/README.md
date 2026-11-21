# Spine

Bootstrap and lifecycle manager for the YouEye platform.

Spine is a single Go binary that installs on the host, sets up Incus, deploys the Control Panel container, and then manages updates for both itself and the platform. It is the only component that runs directly on the host.

## What Spine Does

1. Installs and initializes Incus (container manager)
2. Creates an unprivileged `youeye-control` container
3. Downloads and deploys the Control Panel inside it
4. Exposes a Unix socket API for privileged operations (PAM auth, system updates)
5. Manages its own updates and Control Panel updates via release channels

## Installation boundary

Spine is installed as an exact component of a YouEye appliance release (checked by
SHA-256; signing is off before the public release). Use the
[YouEye Installer](../docs/install.md) from the ISO or its Proxmox mode. Installing a Spine binary onto an arbitrary mutable
Debian/Ubuntu host is no longer a supported platform installation path.

For source development, `go build ./cmd/youeye` builds a local binary. Running
`youeye deploy` is an appliance lifecycle operation and must not be treated as
a replacement for the image installer.

## CLI Commands

```bash
# Setup
youeye deploy              # Full setup: Incus + Control Panel + all services
youeye install incus       # Install Incus only
youeye install control     # Deploy Control Panel only

# Updates
youeye update core check   # System release (Spine, Control Panel, UI, image); see docs/core-release-contract.md
youeye update system       # Appliance image slot state (the image changes only with a System release)

# Status
youeye status              # Platform health overview
youeye version             # Spine version
youeye logs                # View service logs

# Management
youeye channel set dev     # Switch release channel
youeye cleanup             # Clean uninstall

# API Server
youeye api serve           # Run the socket API (youeye.service runs this)
youeye api stop            # Stop socket API
```

## Socket API

Spine runs a Unix socket server at `/var/run/youeye/youeye.sock`. The Control Panel connects to this socket (via Incus proxy device) for privileged operations.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/version` | GET | Version info |
| `/api/status` | GET | Full system status |
| `/api/auth/verify` | POST | PAM authentication |
| `/api/appliance/core-update/*` | GET/POST | System release: status, check, stage, activate, resume, recover, cancel |

The full list of route groups is in [docs/spine.md](../docs/spine.md#the-api). Spine has no route that updates a
container image by tag; the Control Panel rebuilds the core containers on the images it pins.

## Update System

Spine is one member of the System release (`core-release.json`) and is updated with it, as a trial on State without
a reboot ([docs/spine.md](../docs/spine.md), [docs/core-release-contract.md](../docs/core-release-contract.md)). The
box follows one channel (`dev`, `alpha`, `beta`, `stable`); switch with `youeye channel set <channel>`.

## Building from Source

```bash
cd spine

# Build with version info
go build -ldflags "-X github.com/youeye-platform/YouEye/spine/internal/cmd.Version=0.5.2 \
  -X github.com/youeye-platform/YouEye/spine/internal/cmd.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -o youeye ./cmd/youeye

# Cross-compile for ARM64
GOOS=linux GOARCH=arm64 go build -ldflags "..." -o youeye-linux-arm64 ./cmd/youeye
```

## Systemd Service

Spine runs as `youeye.service` (`/usr/local/bin/youeye api serve`, `Restart=always`).

## License

[Business Source License 1.1](../LICENSE) — converts to AGPL-3.0 on 2030-05-15.

## Troubleshooting: deploy log

If `youeye deploy` reports a stage failure, the full deploy transcript is at `/var/log/youeye-deploy.log` on the host. `youeye deploy` is not idempotent — recover with a clean reinstall on a fresh VM rather than re-running it.
