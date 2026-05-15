# Spine

Bootstrap and lifecycle manager for the YouEye platform.

Spine is a single Go binary that installs on the host, sets up Incus, deploys the Control Panel container, and then manages updates for both itself and the platform. It is the only component that runs directly on the host.

## What Spine Does

1. Installs and initializes Incus (container manager)
2. Creates an unprivileged `youeye-control` container
3. Downloads and deploys the Control Panel inside it
4. Exposes a Unix socket API for privileged operations (PAM auth, system updates)
5. Manages its own updates and Control Panel updates via release channels

## Install

```bash
# One-line install
curl -sSL https://get.youeye.app/install.sh | sh

# Deploy the full stack
youeye deploy
```

### Install from a Branch

```bash
curl -sSL https://get.youeye.app/install.sh | sh -s -- --branch dev
```

### Manual Install

```bash
curl -LO https://get.youeye.app/spine-linux-amd64
chmod +x spine-linux-amd64
mv spine-linux-amd64 /usr/local/bin/youeye
youeye deploy
```

## CLI Commands

```bash
# Setup
youeye deploy              # Full setup: Incus + Control Panel + all services
youeye install incus       # Install Incus only
youeye install control     # Deploy Control Panel only

# Updates
youeye update self         # Update Spine binary
youeye update control      # Update Control Panel
youeye update incus        # Update Incus package
youeye update system       # Update host OS packages

# Status
youeye status              # Platform health overview
youeye version             # Spine version
youeye logs                # View service logs

# Management
youeye branch set dev      # Switch release channel
youeye cleanup             # Clean uninstall

# API Server
youeye api start           # Start socket API (runs as systemd service)
youeye api stop            # Stop socket API
youeye api status          # Check API status
```

## Socket API

Spine runs a Unix socket server at `/var/run/youeye/youeye.sock`. The Control Panel connects to this socket (via Incus proxy device) for privileged operations.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/version` | GET | Version info |
| `/api/status` | GET | Full system status |
| `/api/updates/check` | GET | Check for available updates |
| `/api/auth/verify` | POST | PAM authentication |
| `/api/update/self` | POST | Update Spine |
| `/api/update/control` | POST | Update Control Panel |
| `/api/update/incus` | POST | Update Incus |
| `/api/update/system` | POST | Update host OS |

## Update System

Spine checks for new releases on the configured Git server. It supports branch-aware release channels:

- **Main channel**: tags like `spine-v0.3.2` (stable releases)
- **Dev channel**: tags like `spine-dev-v0.3.2.1` (development builds)
- **Branch channels**: tags like `spine-mybranch-v0.3.2.1` (per-branch builds)

Switch channels with `youeye branch set <channel>`.

## Building from Source

```bash
cd spine

# Build with version info
go build -ldflags "-X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.Version=0.3.2 \
  -X git.byka.wtf/potemsla/YouEye/spine/internal/cmd.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -o youeye ./cmd/youeye

# Cross-compile for ARM64
GOOS=linux GOARCH=arm64 go build -ldflags "..." -o youeye-linux-arm64 ./cmd/youeye
```

## Systemd Service

Spine runs as `spine.service`:

```ini
[Unit]
Description=YouEye Spine - System Management Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/spine api serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## License

[Business Source License 1.1](../LICENSE) — converts to AGPL-3.0 on 2030-05-15.
