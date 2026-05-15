# YouEye

**Self-hosted personal cloud that feels like a consumer product.**

One command installs a full platform: dashboard with widgets, six native apps, SSO, reverse proxy, DNS, and an app marketplace. Runs on any Debian/Ubuntu server or Proxmox LXC.

<!-- TODO: add hero screenshot of the dashboard here -->

## Quick Start

```bash
curl -sSL https://get.youeye.app/install.sh | sh
youeye deploy
```

That's it. Open `https://your-server-ip` in your browser, create your account, and start customizing.

> Requires a fresh Debian 12+ or Ubuntu 24.04+ system with root access. See [full install guide](#install-options) for Proxmox LXC, branch installs, and manual setup.

## Features

| | |
|---|---|
| **Dashboard** | Customizable home screen with drag-and-drop widgets (clock, weather, notes, bookmarks, search, word art, and more) |
| **Native Apps** | Six built-in apps: Wiki, Search, Notes, Cinema, Weather, Translate |
| **App Marketplace** | Install third-party apps from the catalog with one click |
| **Single Sign-On** | Authentik-powered SSO across all apps and services |
| **Themes** | OKLCH color system with light/dark mode and animated backgrounds |
| **Internationalization** | Full i18n support with language propagation across all apps |
| **Reverse Proxy** | Caddy with automatic HTTPS and domain routing |
| **DNS Filtering** | Pi-Hole integration for network-wide ad blocking |
| **Backups** | Multi-container backup engine with scheduled snapshots |
| **PWA** | Install as a Progressive Web App on any device |

<!-- TODO: add 4-6 screenshots showing dashboard, app drawer, control panel, setup wizard -->

## Architecture

```
Host (Debian/Ubuntu)
  youeye (Spine CLI)  ── manages itself + Control Panel
    Control Panel container (Incus)
      PostgreSQL 17
      Authentik (SSO/OIDC)
      Caddy (reverse proxy, HTTPS)
      Pi-Hole v6 (DNS)
      YouEye UI (user dashboard)
      Native apps (Wiki, Search, Notes, Cinema, Weather, Translate)
      Marketplace apps
```

**Spine** is a Go binary that bootstraps the entire stack. It installs Incus, creates an unprivileged container, deploys the Control Panel inside it, and then gets out of the way. The Control Panel orchestrates everything else: database, SSO, reverse proxy, DNS, the UI, and all apps.

## Tech Stack

| Component | Stack |
|-----------|-------|
| **Spine** | Go 1.21+, Cobra CLI, Unix socket API |
| **Control Panel** | Next.js 16, TypeScript, Incus API, Authentik API |
| **UI** | Next.js 15, Drizzle ORM, Radix UI, DND-Kit, Framer Motion |
| **Native Apps** | Next.js 15, YouEye Canvas SDK |
| **Infrastructure** | Incus (LXD), PostgreSQL 17, Authentik, Caddy, Pi-Hole v6 |

## Native Apps

Six apps ship with the platform, each running in its own container with full SSO integration:

| App | Description |
|-----|-------------|
| **Wiki** | Wikipedia-style article browser with infobox parsing, search, and reading lists |
| **Search** | Unified search across all platform apps and services |
| **Notes** | Card-based note-taking with tags, checklists, reminders, and dashboard widgets |
| **Cinema** | Movie and TV discovery powered by TMDB with watchlists and sharing |
| **Weather** | Multi-location weather with Open-Meteo, forecasts, and dashboard widgets |
| **Translate** | Privacy-friendly translation with history, bookmarks, and auto-detect |

Each app provides dashboard widgets and integrates with the platform's theme, language, and notification systems.

## Monorepo Structure

This repository contains the three core components:

| Directory | Component | Description |
|-----------|-----------|-------------|
| `spine/` | [Spine](spine/) | Go CLI that bootstraps and manages the platform |
| `control-panel/` | [Control Panel](control-panel/) | Next.js orchestration engine for all infrastructure |
| `ui/` | [UI](ui/) | Next.js user-facing dashboard with widgets and themes |

Each component is versioned and released independently.

## Current Versions

| Component | Version |
|-----------|---------|
| Spine | 0.3.2 |
| Control Panel | 0.3.6 |
| UI | 0.3.4 |

## Related Repositories

| Repository | Description |
|------------|-------------|
| [YE-AppMarket](https://git.byka.wtf/potemsla/YE-AppMarket) | App marketplace catalog (YAML manifests) |
| [YouEye-Canvas](https://git.byka.wtf/potemsla/YouEye-Canvas) | SDK and starter template for building native apps |
| [YE-App-Wiki](https://git.byka.wtf/potemsla/YE-App-Wiki) | Wiki native app |
| [YE-App-Search](https://git.byka.wtf/potemsla/YE-App-Search) | Search native app |
| [YE-App-Notes](https://git.byka.wtf/potemsla/YE-App-Notes) | Notes native app |
| [YE-App-Cinema](https://git.byka.wtf/potemsla/YE-App-Cinema) | Cinema native app |
| [YE-App-Weather](https://git.byka.wtf/potemsla/YE-App-Weather) | Weather native app |
| [YE-App-Translate](https://git.byka.wtf/potemsla/YE-App-Translate) | Translate native app |

## Install Options

### One-Line Install (recommended)

```bash
curl -sSL https://get.youeye.app/install.sh | sh
youeye deploy
```

### Install from a Branch

```bash
curl -sSL https://get.youeye.app/install.sh | sh -s -- --branch dev
```

### Manual Install

```bash
# Download Spine binary
curl -LO https://get.youeye.app/spine-linux-amd64
chmod +x spine-linux-amd64
mv spine-linux-amd64 /usr/local/bin/youeye

# Deploy
youeye deploy
```

### Proxmox LXC

Create an unprivileged Debian 12 LXC with nesting enabled, then run the one-line install inside it.

## Platform Management

```bash
youeye status          # Full platform health check
youeye deploy          # Deploy the entire stack
youeye update self     # Update Spine
youeye update control  # Update Control Panel
youeye cleanup         # Clean uninstall
youeye branch set dev  # Switch release channel
```

## Development

```bash
# Spine (Go)
cd spine && go build ./cmd/youeye

# Control Panel (Next.js 16)
cd control-panel && pnpm install && pnpm dev

# UI (Next.js 15)
cd ui && pnpm install && pnpm dev
```

**Always use pnpm**, never npm. Branch from `dev`, never from `main`.

## Contributing

YouEye is in public beta. Contributions are welcome:

1. Fork the repository
2. Create your branch from `dev`
3. Make your changes
4. Submit a pull request

## License

YouEye source code is licensed under the [Business Source License 1.1](LICENSE). After four years, each version converts to [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

The "YouEye" name and logo are trademarks. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
