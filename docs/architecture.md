# Architecture

YouEye uses a layered architecture where each component has a single responsibility and clear boundaries.

## System Overview

```mermaid
graph TD
    User[User Browser] -->|HTTPS| Caddy[Caddy Reverse Proxy]
    
    subgraph Host["Host (Debian/Ubuntu)"]
        Spine[Spine CLI]
    end
    
    Spine -->|manages| Container
    
    subgraph Container["Control Panel Container (Incus, unprivileged)"]
        CP[Control Panel<br/>Next.js 16]
        Caddy
        Auth[Authentik SSO]
        DB[(PostgreSQL 17)]
        DNS[Pi-Hole v6]
        UI[YouEye UI<br/>Next.js 15]
        Apps[Native Apps]
        Market[Marketplace Apps]
    end
    
    Caddy --> UI
    Caddy --> Apps
    Caddy --> Market
    Caddy --> CP
    Caddy --> Auth
    
    CP --> DB
    CP --> Auth
    CP --> DNS
    UI --> DB
    Auth --> DB
```

## Component Boundaries

### Spine (Host)

Spine is a Go binary that runs on the host system. Its responsibilities are strictly limited:

- Install and manage Incus
- Create the unprivileged container
- Deploy the Control Panel into the container
- Update itself and the Control Panel
- Report platform status

**Spine does NOT manage** the UI, native apps, marketplace apps, or any infrastructure inside the container. That's the Control Panel's job.

### Control Panel (Container)

The Control Panel is the orchestration engine. It manages everything inside the container:

- PostgreSQL database
- Authentik (SSO/OIDC)
- Caddy (reverse proxy, TLS)
- Pi-Hole (DNS)
- YouEye UI deployment
- Native app deployment
- Marketplace app lifecycle

### UI (Container)

The UI is the user-facing dashboard. It provides:

- Widget management (drag, drop, resize)
- Theme and appearance engine
- User settings
- App drawer and notifications
- Bridge API endpoints for CP communication

### Native Apps (Container)

Each native app runs as its own process with:

- Its own subdomain route via Caddy
- SSO integration via Authentik
- Access to the shared PostgreSQL database
- Theme and language synchronization with the UI

## Security Model

```mermaid
graph LR
    subgraph Public["Public Network"]
        Browser[Browser]
    end
    
    subgraph Container["Unprivileged Container"]
        Caddy[Caddy<br/>TLS termination]
        Auth[Authentik<br/>OIDC Provider]
        UI[UI]
        CP[Control Panel]
        Apps[Apps]
    end
    
    Browser -->|HTTPS only| Caddy
    Caddy -->|authenticated| UI
    Caddy -->|authenticated| Apps
    Caddy -->|admin only| CP
    
    UI -.-|"NO direct access"| CP
    CP -->|push via bridge| UI
```

Key security principles:

| Principle | Implementation |
|-----------|---------------|
| **Unprivileged container** | The entire stack runs in an unprivileged Incus container — no root on the host |
| **Single entry point** | All traffic enters through Caddy (port 443 only) |
| **Automatic TLS** | Caddy provisions and renews certificates automatically |
| **SSO everywhere** | Authentik gates every app and service — no separate logins |
| **One-way bridge** | CP pushes data to UI via bridge API; UI cannot call CP |
| **Network isolation** | UI container is firewalled from reaching CP directly |

## Data Flow

### User Authentication

```mermaid
sequenceDiagram
    participant B as Browser
    participant C as Caddy
    participant A as Authentik
    participant UI as YouEye UI
    
    B->>C: GET https://yourdomain.com
    C->>A: Check session
    A-->>C: No session
    C->>B: Redirect to /auth/login
    B->>A: POST credentials
    A-->>B: Set session cookie + redirect
    B->>C: GET / (with cookie)
    C->>A: Validate session
    A-->>C: Valid
    C->>UI: Forward request
    UI-->>B: Dashboard HTML
```

### App Installation

```mermaid
sequenceDiagram
    participant U as User
    participant UI as YouEye UI
    participant CP as Control Panel
    participant R as App Registry
    
    U->>UI: Click "Install" on app
    UI->>CP: Bridge: install request
    CP->>R: Fetch app manifest
    R-->>CP: Manifest (container config, version)
    CP->>CP: Create container, deploy app
    CP->>CP: Configure Caddy route + SSO
    CP->>UI: Bridge: installation complete
    UI-->>U: App appears in drawer
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Spine** | Go 1.21+, Cobra, Bubble Tea | Host-level CLI and TUI installer |
| **Control Panel** | Next.js 16, TypeScript | Infrastructure orchestration |
| **UI** | Next.js 15, Drizzle ORM, Radix UI, DND-Kit, Framer Motion | User dashboard |
| **Native Apps** | Next.js 15 | Wiki, Search, Notes, Cinema, Weather, Translate |
| **Database** | PostgreSQL 17 | Shared data store |
| **SSO** | Authentik | OIDC identity provider |
| **Proxy** | Caddy | Reverse proxy with automatic HTTPS |
| **DNS** | Pi-Hole v6 | DNS filtering and local resolution |
| **Containers** | Incus (LXD fork) | Lightweight system containers |

## Monorepo Structure

```
YouEye/
├── spine/              # Go CLI (Spine)
│   ├── cmd/            # CLI entry point
│   ├── internal/       # Commands, config, TUI
│   └── install.sh      # One-line installer script
├── control-panel/      # Next.js 16 (Control Panel)
│   ├── src/            # Application source
│   ├── prisma/         # Database schema (unused, legacy)
│   └── package.json
├── ui/                 # Next.js 15 (Dashboard UI)
│   ├── src/            # Application source
│   ├── drizzle/        # Database migrations
│   └── package.json
└── docs/               # This documentation
```

Each component is **versioned independently** and released with its own tag prefix (`spine-v*`, `cp-v*`, `ui-v*`).

## Update System

Spine manages updates for itself and the Control Panel. The Control Panel manages updates for everything else.

```mermaid
graph TD
    GH[GitHub Releases] -->|spine-v*| Spine
    GH -->|cp-v*| Spine
    Spine -->|deploys| CP[Control Panel]
    
    GH -->|ui-v*| CP
    GH -->|app tags| CP
    CP -->|deploys| UI[UI]
    CP -->|deploys| Apps[Native Apps]
    
    Registry[App Market Registry] -->|manifests| CP
    CP -->|deploys| Market[Marketplace Apps]
```

Updates are pulled from GitHub releases. Each component checks for newer tags matching its prefix and branch, downloads the artifact, and deploys it.
