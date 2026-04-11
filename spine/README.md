# YE-Spine

Minimal bootstrap and management tool for YouEye infrastructure.

**Current Version:** v0.1.105.2

## Quick Install (Fresh LXC/Server)

Run this on a fresh Proxmox LXC or Debian/Ubuntu server:

```bash
# One-liner install (works even without curl)
apt-get update && apt-get install -y curl && \
  curl -sSL https://git.byka.wtf/potemsla/YE-Spine/raw/branch/main/install.sh | sh
```

Or copy and run these commands step by step:

```bash
# Step 1: Update package list and install curl
apt-get update
apt-get install -y curl

# Step 2: Download and run installer
curl -sSL https://git.byka.wtf/potemsla/YE-Spine/raw/branch/main/install.sh | sh

# Step 3: Deploy full stack (installs Incus + Control Panel automatically!)
spine deploy
```

**That's it!** After `spine deploy`, the Control Panel will be running at `http://<your-ip>:3000`

### What `spine deploy` Does

1. Installs Incus container manager
2. Creates `youeye-control` container (unprivileged, secure)
3. Installs Node.js 22 in the container
4. Downloads the latest Control Panel release from Gitea
5. Deploys the application to `/opt/app`
6. Creates and starts the systemd service
7. Health-checks to ensure everything is working

### Manual Installation (No Internet Bootstrap)

If you can't access the internet from the LXC, download the binary on another machine and copy it:

```bash
# On your workstation (download for your target arch)
curl -LO https://git.byka.wtf/potemsla/YE-Spine/releases/latest/download/spine-linux-amd64
# or for ARM64: spine-linux-arm64

# Copy to LXC (replace <lxc-ip> with your LXC IP)
scp spine-linux-amd64 root@<lxc-ip>:/usr/local/bin/spine

# On the LXC
chmod +x /usr/local/bin/spine
spine version
```

## Overview

YE-Spine is a Go binary that runs on the host system to:
- Install and initialize Incus (from Zabbly stable repository, v6.21+)
- Configure Docker OCI remote for container deployment (docker.io)
- Deploy and update the Control Panel container (fully automated!)
- Provide a Unix socket API for Control Panel communication
- Handle PAM authentication on behalf of Control Panel (allows unprivileged containers)

### OCI Container Support

Spine v0.1.6+ automatically configures Incus with OCI container support:
- Installs Incus 6.21+ from Zabbly stable repository (Ubuntu 24.04 ships with 6.0.0 LTS)
- Configures Docker OCI remote: `docker` → `https://docker.io` with `protocol=oci`
- Enables Control Panel to deploy Docker Hub containers: Caddy, Alpine, etc.
- OCI containers show as type `CONTAINER (APP)` in `incus list`

Manual OCI container testing:
```bash
incus launch docker:alpine test-alpine
incus launch docker:caddy test-caddy
incus list  # Should show type: CONTAINER (APP)
```

## Commands

```bash
# Setup
spine install incus      # Install & initialize Incus
spine install control    # Deploy Control Panel container + app
spine deploy             # Full setup (incus + control) - RECOMMENDED

# API Server
spine api start          # Start API server (via systemd)
spine api stop           # Stop API server
spine api status         # Check API server status
spine api restart        # Restart API server

# Updates
spine update self        # Update Spine binary
spine update incus       # Update Incus package
spine update system      # Update host OS packages
spine update control     # Update Control Panel container

# Status
spine status             # Show system status
spine version            # Show Spine version
spine logs               # View service logs
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/version` | GET | Version information |
| `/api/status` | GET | System status |
| `/api/updates/check` | GET | Check for available updates |
| `/api/auth/verify` | POST | PAM authentication |
| `/api/update/self` | POST | Update Spine |
| `/api/update/incus` | POST | Update Incus |
| `/api/update/system` | POST | Update host OS |
| `/api/update/control` | POST | Update Control Panel |

## Updates System

Spine manages updates for both itself and the Control Panel by checking Gitea releases.

### Version Detection

The `/api/updates/check` endpoint returns:
```json
{
  "checked_at": "2026-01-28T08:46:04Z",
  "control": {
    "available": false,
    "current": "0.0.4",
    "latest": "0.0.4"
  },
  "spine": {
    "available": true,
    "current": "0.0.3",
    "latest": "0.0.4"
  }
}
```

### Control Panel Updates

When updating Control Panel:
1. Spine fetches the latest release from Gitea API
2. Downloads `standalone.tar` from release assets
3. Extracts tarball to container filesystem
4. Restarts the Control Panel service
5. Validates health before completing

### Release Asset Downloads

Spine uses the Gitea releases API to get download URLs:
```
GET /api/v1/repos/potemsla/YE-ControlPanel/releases
```

The `getAssetDownloadURL()` function finds the `browser_download_url` for the specified asset (e.g., `standalone.tar`).

## Socket Location

The API server listens on a Unix socket at `/var/run/spine/spine.sock`.

Control Panel connects via a proxy device:
```bash
incus config device add youeye-control spine-socket proxy \
  listen=unix:/var/run/spine/spine.sock \
  connect=unix:/var/run/spine/spine.sock \
  bind=container
```

## Building from Source

```bash
# Clone the repo
git clone https://git.byka.wtf/potemsla/YE-Spine.git
cd YE-Spine

# Build for Linux AMD64
GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=0.0.1" -o spine-linux-amd64 ./cmd/spine

# Build for Linux ARM64
GOOS=linux GOARCH=arm64 go build -ldflags "-X main.version=0.0.1" -o spine-linux-arm64 ./cmd/spine
```

## Systemd Service

Spine runs as a systemd service (`spine.service`):

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

MIT
