# Settings

Access settings from the user menu (top-right avatar → Settings) or navigate directly to `/settings`. The `/settings` surface is served by Control Panel on the root domain.

## Profile

Manage your account identity:

- **Display Name** — How your name appears across the platform
- **Email** — Your login email address
- **Avatar** — Upload a profile picture
- **Password** — Change your account password

---

## Appearance

Customize the look and feel of your dashboard:

- **Color Theme** — Choose from preset color palettes or create your own using the OKLCH color picker
- **Mode** — Switch between light and dark mode, or set it to follow your system preference
- **Animated Background** — Choose canvas-based backgrounds or disable animation
- **Widget Style** — Adjust widget transparency and border radius

The OKLCH color system ensures perceptually uniform colors — themes look consistent across light and dark modes.

---

## Apps

View and manage all installed apps:

- See which apps are installed and their current versions
- Uninstall apps you no longer use
- Apps include both native apps and Market-installed apps
- AI-capable apps have an **AI** tab for their YouEye AI connection, selected
  model group, key preview, and explicit administrator takeover

---

## Language

Set your preferred language. The choice propagates across the entire platform:

- Dashboard UI
- All native apps
- System notifications
- Settings interface

Supported languages are added with each release.

---

## Users

Manage platform users (admin only):

- **Create users** — Add new users to your platform
- **View all users** — See registered accounts
- **Manage roles** — Create accounts as admin or regular user
- **Remove users** — Revoke access

Users are managed through YouEye's provider-neutral identity layer — changes sync across all apps automatically.

---

## System

Platform-wide system settings:

- **Core Update Source** — Set Release Branch and Repo URL for Spine, Control Panel, and UI updates
- **Host Info** — View hostname, OS, kernel, and uptime
- **Resources** — View CPU, memory, disk, and container summary
- **System Manifests** — Check Market-tracked infrastructure images
- **Backups** — Configure backup schedules and view backup history
- **Maintenance** — System maintenance operations

---

## Network

Network and connectivity configuration:

- **DNS** — View DNS filtering status (Pi-Hole integration)
- **Reverse Proxy** — View Caddy routing configuration
- **Ports** — See which ports are in use
- **Certificates** — TLS certificate status

---

## Market

Browse and install apps from Market:

- **Browse** — See all available apps with descriptions and screenshots
- **Search** — Find apps by name or category
- **Install** — One-click install deploys the app automatically
- **Categories** — Filter by type (productivity, media, utilities, etc.)

See [Apps -> Market](apps.md#market) for more details.
