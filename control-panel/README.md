# Control Panel

Orchestration engine for the YouEye platform.

The Control Panel is a Next.js application that runs inside an Incus container and manages all platform infrastructure: database, SSO, reverse proxy, DNS, the user-facing UI, native apps, and marketplace apps.

## What Control Panel Does

- **Setup Wizard**: Guided first-run configuration (domain, DNS, SSO, services)
- **Dashboard**: System health monitoring with service status and resource usage
- **App Management**: Install, update, start, stop, and remove apps (native and marketplace)
- **Reverse Proxy**: Caddy route management with automatic TLS
- **DNS**: Pi-Hole configuration, blocklists, local DNS records
- **SSO**: Authentik integration for single sign-on across all apps
- **Updates**: Check and apply updates for all platform components
- **Backups**: Multi-container backup engine with scheduling

## Architecture

Control Panel runs as a standalone Next.js app inside the `youeye-control` Incus container. It communicates with other services via:

- **Incus socket**: Container lifecycle management (create, start, stop, exec)
- **Spine socket**: Privileged host operations (PAM auth, system updates)
- **Bridge network**: Direct API calls to containers (Caddy, Pi-Hole, Authentik, PostgreSQL)
- **UI Bridge API**: One-way push endpoints for the UI (`/api/ui-bridge/*`)

The UI bridge is one-way: Control Panel pushes data to the UI. The UI never calls back to Control Panel.

## Development

```bash
pnpm install
pnpm dev
```

Runs on `http://localhost:3000` in development mode.

### Building

```bash
pnpm build
```

The standalone output is in `.next/standalone/control-panel/`.

### Creating a Release Tarball

```bash
cd .next/standalone/control-panel
cp -r ../../static .next/static
cp -r ../../../public ./public
tar -cf standalone.tar .
```

The tarball must be created from inside the component subdirectory with `server.js` at the root level. Use `tar -cf` (uncompressed), not `tar -czf`.

## Key API Routes

| Route | Description |
|-------|-------------|
| `/api/auth/login` | PAM authentication via Spine |
| `/api/apps/unified` | Unified app listing (native + marketplace) |
| `/api/apps/install` | Install an app from the marketplace |
| `/api/caddy/*` | Caddy reverse proxy management |
| `/api/pihole/*` | Pi-Hole DNS management |
| `/api/deploy/*` | Setup wizard deployment steps |
| `/api/updates` | Check for available updates |
| `/api/ui-bridge/*` | Data push endpoints for the UI |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP server port |
| `NODE_ENV` | production | Node environment |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `CONTROL_EXTERNAL_URL` | — | Public-facing URL for this instance |

## License

[Business Source License 1.1](../LICENSE) — converts to AGPL-3.0 on 2030-05-15.
