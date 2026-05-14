# YouEye

Self-hosted personal cloud platform. One command to deploy on any Debian/Ubuntu server.

## Quick Start

```bash
curl -sSL https://git.byka.wtf/potemsla/YouEye/raw/branch/main/spine/install.sh | sh
youeye deploy
```

This installs Spine (the bootstrap tool), then deploys the full stack: Control Panel, UI, Authentik SSO, Caddy reverse proxy, Pi-Hole DNS, and PostgreSQL.

To install from a specific branch (e.g. dev):
```bash
BRANCH=dev curl -sSL https://git.byka.wtf/potemsla/YouEye/raw/branch/main/spine/install.sh | sh
```

## Architecture

```
Host (Debian/Ubuntu)
  Spine (Go binary — manages itself + Control Panel container)
    Control Panel container (Incus)
      PostgreSQL, Authentik, Caddy, Pi-Hole
      YouEye UI (user dashboard)
      Native apps (Wiki, Search, Notes, Cinema, Weather, Translate)
```

## Monorepo Structure

| Directory | Component | Stack |
|-----------|-----------|-------|
| `spine/` | Spine | Go 1.21+ |
| `control-panel/` | Control Panel | Next.js 16, TypeScript, pnpm |
| `ui/` | YouEye UI | Next.js 15, Drizzle ORM, pnpm |

Each component is built and released independently using **component-prefixed tags**:

| Component | Main tag | Dev tag |
|-----------|----------|---------|
| Spine | `spine-v0.3.2` | `spine-dev-v0.3.2.x` |
| Control Panel | `cp-v0.3.6` | `cp-dev-v0.3.6.x` |
| UI | `ui-v0.3.4` | `ui-dev-v0.3.4.x` |

## Current Versions (main)

| Component | Version |
|-----------|---------|
| Spine | 0.3.2 |
| Control Panel | 0.3.6 |
| UI | 0.3.4 |

## Related Repos

Native apps and other platform components live in their own repositories:

| Repo | Description |
|------|-------------|
| [YE-AppMarket](https://git.byka.wtf/potemsla/YE-AppMarket) | App marketplace YAML manifests |
| [YouEye-Canvas](https://git.byka.wtf/potemsla/YouEye-Canvas) | Starter template for native apps (fork to create new) |
| [YE-App-Wiki](https://git.byka.wtf/potemsla/YE-App-Wiki) | Wiki native app |
| [YE-App-Search](https://git.byka.wtf/potemsla/YE-App-Search) | Search native app |
| [YE-App-Notes](https://git.byka.wtf/potemsla/YE-App-Notes) | Notes native app |
| [YE-App-Cinema](https://git.byka.wtf/potemsla/YE-App-Cinema) | Cinema native app |
| [YE-App-Weather](https://git.byka.wtf/potemsla/YE-App-Weather) | Weather native app |
| [YE-App-Translate](https://git.byka.wtf/potemsla/YE-App-Translate) | Translate native app |
| [YE-Wiki](https://git.byka.wtf/potemsla/YE-Wiki) | Platform documentation |
| [YE-Website](https://git.byka.wtf/potemsla/YE-Website) | Public website |

## Platform Management

Spine is the single CLI for managing the entire platform:

```bash
youeye status          # Full platform status
youeye deploy          # Deploy the full stack
youeye update self     # Update Spine itself
youeye update control  # Update Control Panel
youeye cleanup         # Clean uninstall
youeye branch set dev  # Switch to dev release channel
```

Requires `sudo` for full functionality.

## Development

```bash
# Spine (Go)
cd spine && go build ./cmd/youeye

# Control Panel (Next.js 16)
cd control-panel && pnpm install && pnpm dev

# UI (Next.js 15)
cd ui && pnpm install && pnpm dev
```

Branch from `dev`, never from `main`. See `CLAUDE.md` for full agent workflow.

## License

Proprietary. All rights reserved.
