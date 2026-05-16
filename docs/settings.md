# Settings

Access settings from the user menu (top-right avatar → Settings) or navigate directly to `/settings`.

## Profile

<p align="center">
  <img src="assets/screenshots/settings/profile.png" alt="Profile settings" width="800">
</p>

Manage your account identity:

- **Display Name** — How your name appears across the platform
- **Email** — Your login email address
- **Avatar** — Upload a profile picture
- **Password** — Change your account password

---

## Appearance

<p align="center">
  <img src="assets/screenshots/settings/appearance.png" alt="Appearance settings" width="800">
</p>

Customize the look and feel of your dashboard:

- **Color Theme** — Choose from preset color palettes or create your own using the OKLCH color picker
- **Mode** — Switch between light and dark mode, or set it to follow your system preference
- **Animated Background** — Enable or disable the shader gradient background
- **Widget Style** — Adjust widget transparency and border radius

The OKLCH color system ensures perceptually uniform colors — themes look consistent across light and dark modes.

---

## Apps

<p align="center">
  <img src="assets/screenshots/settings/apps.png" alt="Apps settings" width="800">
</p>

View and manage all installed apps:

- See which apps are installed and their current versions
- Uninstall apps you no longer use
- Apps include both native (built-in) and marketplace (third-party) apps

---

## Language

<p align="center">
  <img src="assets/screenshots/settings/language.png" alt="Language settings" width="800">
</p>

Set your preferred language. The choice propagates across the entire platform:

- Dashboard UI
- All native apps
- System notifications
- Settings interface

Supported languages are added with each release.

---

## Users

<p align="center">
  <img src="assets/screenshots/settings/users.png" alt="Users settings" width="800">
</p>

Manage platform users (admin only):

- **Invite users** — Add new users to your platform
- **View all users** — See registered accounts
- **Manage roles** — Assign admin or regular user permissions
- **Remove users** — Revoke access

Users are managed through Authentik SSO — changes here sync across all apps automatically.

---

## System

<p align="center">
  <img src="assets/screenshots/settings/system.png" alt="System settings" width="800">
</p>

Platform-wide system settings:

- **Platform Name** — Customize the name shown in the UI and browser tab
- **Domain** — View and change your platform's domain
- **Updates** — Check for and apply platform updates
- **Backups** — Configure backup schedules and view backup history
- **Maintenance** — System maintenance operations

---

## Network

<p align="center">
  <img src="assets/screenshots/settings/network.png" alt="Network settings" width="800">
</p>

Network and connectivity configuration:

- **DNS** — View DNS filtering status (Pi-Hole integration)
- **Reverse Proxy** — View Caddy routing configuration
- **Ports** — See which ports are in use
- **Certificates** — TLS certificate status

---

## App Market

<p align="center">
  <img src="assets/screenshots/settings/app-market.png" alt="App Market" width="800">
</p>

Browse and install apps from the marketplace:

- **Browse** — See all available apps with descriptions and screenshots
- **Search** — Find apps by name or category
- **Install** — One-click install deploys the app automatically
- **Categories** — Filter by type (productivity, media, utilities, etc.)

See [Apps → Marketplace](apps.md#marketplace) for more details.
