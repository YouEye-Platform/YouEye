# YouEye UI

User-facing dashboard for the YouEye platform.

The UI is what users see after logging in: a customizable home screen with drag-and-drop widgets, an app drawer, theme controls, and integration with all native apps. It runs as a standalone Next.js app inside its own Incus container.

## Features

- **Widget System**: Drag-and-drop dashboard with resizable widgets (clock, weather, notes, bookmarks, search, word art, calendar, and more)
- **App Drawer**: Launcher for all installed apps with customizable icons, names, and ordering
- **Themes**: OKLCH color system with light/dark mode toggle
- **Animated Backgrounds**: Shader-based and CSS animated wallpapers
- **i18n**: Full internationalization with language propagation to native apps
- **Timeline**: Activity feed with info cards from across the platform
- **Notifications**: Platform-wide notification center
- **Settings**: User preferences, profile, avatar, and admin controls
- **PWA**: Installable as a Progressive Web App

## Architecture

The UI receives data from the Control Panel via one-way bridge endpoints (`/api/ui-bridge/*`). It never calls the Control Panel directly. All CP data arrives via push, or the browser loads CP embeds in iframes.

User data (widgets, layout, preferences) is stored in a local PostgreSQL database via Drizzle ORM.

## Tech Stack

- Next.js 15 (App Router)
- TypeScript
- Drizzle ORM + PostgreSQL
- Radix UI (accessible components)
- DND-Kit (drag and drop)
- Framer Motion (animations)
- Tailwind CSS

## Development

```bash
pnpm install
pnpm dev
```

Runs on `http://localhost:3001` in development mode.

### Building

```bash
pnpm build
```

### Creating a Release Tarball

```bash
cd .next/standalone/ui
cp -r ../../static .next/static
cp -r ../../../public ./public
tar -cf standalone.tar .
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | HTTP server port |
| `NODE_ENV` | production | Node environment |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `UI_EXTERNAL_URL` | — | Public-facing URL for this instance |
| `NEXTAUTH_SECRET` | — | Auth session secret |

## License

[Business Source License 1.1](../LICENSE) — converts to AGPL-3.0 on 2030-05-15.
