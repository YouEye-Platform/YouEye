# YE-ControlPanel

Web-based management interface for YouEye infrastructure. Provides system monitoring, service control, and configuration through a modern dashboard.

**Current Version:** v0.1.102

## Features

- **Dashboard**: System overview with resource monitoring
- **Reverse Proxy**: Manage Caddy reverse proxy with domain routing and TLS configuration
- **DNS**: Manage Pi-Hole DNS filtering, blocklists, local DNS records, and query logs
- **Apps**: View status and control Spine-deployed services (Caddy, Pi-Hole)
- **Updates Tab**: Check and apply updates for Spine and Control Panel
- **Responsive Design**: Works on desktop and mobile devices

## Architecture

Control Panel runs as a Next.js standalone application inside an Incus container. It communicates with other services via:
- **Incus socket proxy**: Manages containers via Incus REST API
- **Spine socket proxy**: PAM authentication, system updates, status monitoring
- **Incus bridge network**: Reaches other containers (Caddy, Pi-Hole) for API calls

All app deployment is handled by Spine (`spine deploy`). Control Panel only monitors and controls already-deployed services.

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Build for production
pnpm build
```

## Deployment

### Building the Release Tarball

```bash
# Build standalone output
pnpm build

# Create release tarball
tar -cvf standalone.tar -C .next/standalone . -C ../.. .next/static public
```

### Creating a Gitea Release

Use the Gitea API to create releases with the standalone.tar attached:

```bash
# Create release
curl -X POST "https://git.byka.wtf/api/v1/repos/potemsla/YE-ControlPanel/releases" \
  -H "Authorization: token YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name": "v0.0.4", "name": "v0.0.4", "body": "Release notes"}'

# Upload asset (get release ID from response)
curl -X POST "https://git.byka.wtf/api/v1/repos/potemsla/YE-ControlPanel/releases/RELEASE_ID/assets?name=standalone.tar" \
  -H "Authorization: token YOUR_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @standalone.tar
```

### Container Deployment

The container requires:
- Node.js 22+
- Spine socket mounted via disk device

```bash
# Extract tarball
tar -xf standalone.tar
cp -r .next/standalone/. /opt/app/
cp -r .next/static /opt/app/.next/
cp -r public /opt/app/

# Install runtime dependencies
cd /opt/app
npm install next styled-jsx sharp

# Start with PORT environment variable
PORT=3000 node server.js
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/login` | POST | PAM authentication via Spine |
| `/api/updates` | GET | Check for available updates |
| `/api/updates/spine` | POST | Trigger Spine self-update |
| `/api/updates/control` | POST | Trigger Control Panel update |
| `/api/apps` | GET | List available apps from registry |
| `/api/apps/install` | POST | Install an app container |
| `/api/apps/[name]/status` | GET | Get app status |
| `/api/apps/[name]/control` | POST | Start/stop/restart/remove app |
| `/api/caddy/status` | GET | Get Caddy status |
| `/api/caddy/routes` | GET/POST | List or add proxy routes |
| `/api/caddy/routes/[id]` | PUT/DELETE | Update or delete route |
| `/api/caddy/config` | GET/PUT | Get or set Caddy config |
| `/api/caddy/tls` | GET/PUT | Get or set TLS configuration |

## Updates System

The Updates tab displays version information for:
- **Spine**: Current vs latest from Gitea releases
- **Control Panel**: Current vs latest from Gitea releases

Updates are performed by Spine:
1. Downloads new version from Gitea releases
2. Stops Control Panel service
3. Extracts and installs new files
4. Restarts Control Panel service
5. Validates health before completing

## OCI Container Deployment

Control Panel v0.1.4+ supports deploying OCI containers from Docker Hub. Key features:

- **Manifest System**: Type-safe app definitions with image source, ports, environment variables
- **Automatic Port Proxying**: HTTP, HTTPS, and admin port proxies configured automatically
- **Correct API Format**: Uses `{type:"image", server:"https://docker.io", protocol:"oci", alias:"library/imagename"}`
- **Admin Port Support**: Automatically exposes admin APIs (e.g., Caddy's :2019 port)

Example: Deploying Caddy
```typescript
{
  name: "youeye-caddy",
  image: "docker.io/caddy:2.9-alpine",
  adminPort: 2019,
  environment: {
    CADDY_ADMIN: "0.0.0.0:2019"
  }
}
```

See `src/lib/apps/manifest.ts` for implementation details.

## Caddy Reverse Proxy Configuration

Control Panel v0.1.6+ properly configures Caddy proxy routes with:

### Route Ordering
New routes are added at the **beginning** of Caddy's routes array. This ensures proxy routes are evaluated before any default catch-all routes (like `file_server`).

### Path Matching
Paths are automatically configured with a `*` suffix for prefix matching:
- Input: `/control` → Caddy matcher: `/control*`
- This matches `/control`, `/control/`, `/control/dashboard`, `/control/login`, etc.

### Path Stripping
When proxying sub-paths (e.g., `/control` → backend), a `rewrite` handler strips the path prefix:
```json
{
  "handler": "rewrite",
  "strip_path_prefix": "/control"
}
```
This transforms `/control/dashboard` → `/dashboard` before sending to the backend.

**Example route configuration:**
```json
{
  "match": [{ "host": ["example.com"], "path": ["/control*"] }],
  "handle": [
    { "handler": "rewrite", "strip_path_prefix": "/control" },
    { "handler": "reverse_proxy", "upstreams": [{ "dial": "backend:3000" }] }
  ]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP server port |
| `NODE_ENV` | production | Node environment |

## Version

Current: **v0.1.6**

## License

MIT
