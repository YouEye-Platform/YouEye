# Getting Started

## Requirements

- **OS:** Debian 12+ or Ubuntu 24.04+
- **RAM:** 4 GB minimum (8 GB recommended)
- **Disk:** 20 GB free space
- **Access:** Root privileges
- **Network:** Public IP or LAN with port 443 accessible

YouEye also runs inside a Proxmox LXC — create an unprivileged Debian 12 container with nesting enabled.

## Installation

### One-Line Install

```bash
curl -sSL https://raw.githubusercontent.com/YouEye-Platform/YouEye/main/spine/install.sh | sh && youeye deploy
```

This downloads the `youeye` CLI (called **Spine**) and deploys the full platform. The installer:

1. Detects your environment (bare metal, VM, or LXC)
2. Installs Incus (container runtime)
3. Creates an unprivileged container
4. Deploys the full platform stack inside it
5. Shows a live progress bar throughout

The entire process takes approximately 5 minutes depending on your connection.

### Manual Install

```bash
# Download Spine binary
curl -LO https://github.com/YouEye-Platform/YouEye/releases/download/spine-v0.4.1/spine-linux-amd64
chmod +x spine-linux-amd64
mv spine-linux-amd64 /usr/local/bin/youeye

# Deploy
youeye deploy
```

## First Login

Once deployment finishes, open `https://your-server-ip` in your browser.

1. **Create your account** — The setup wizard appears on first visit. Enter your name, email, and password.
2. **Choose your domain** — Optionally configure a custom domain. The platform uses Caddy with on-demand TLS, so any domain pointing at your server will work with automatic HTTPS.
3. **Start using YouEye** — After setup, you land on the dashboard. Your account is the admin.

> The platform uses self-signed certificates by default. If you haven't configured a domain with proper DNS, your browser will show a certificate warning — this is expected.

## Platform Management

After installation, use the `youeye` CLI to manage the platform:

```bash
youeye status          # Full platform health check
youeye update self     # Update Spine to latest version
youeye update control  # Update Control Panel
youeye installer       # Re-launch the interactive TUI
youeye cleanup         # Full uninstall (removes all data)
```

## Next Steps

- [Customize your dashboard](dashboard.md) with widgets and themes
- [Explore native apps](apps.md) — Wiki, Search, Notes, Cinema, Weather, Translate
- [Configure settings](settings.md) — appearance, language, users
- [Administer the platform](control-panel.md) via the Control Panel
