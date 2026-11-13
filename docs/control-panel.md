# Control Panel

The Control Panel (CP) is the Next.js app in `control-panel/`. It runs the box above the host: it deploys the
system containers, installs Market apps, configures Caddy and Pi-hole, runs YouEye ID, holds settings, runs app
and platform backups, and drives updates through Spine. Spine ([spine.md](spine.md)) is the host agent; the CP asks it
to do everything that needs the host.

## Container

Spine creates the CP during first deploy (`youeye deploy`; `spine/internal/container/control.go`).

| Item | Value |
|---|---|
| Incus container | `youeye-control`, a system container from `images:debian/12` |
| App bundle | `/opt/app` (Next.js standalone). `server.js` starts the bundled Node 24.22.0 in `.youeye-runtime/` (see [web-runtime.md](web-runtime.md)) |
| Services | `youeye-control.service` (CP, port 3000) and `youeye-id.service` (YouEye ID, port 3001, `IDENTITY_SERVICE=true`); same bundle |
| Host data | the host's `/var/lib/youeye` is mounted at the same path |
| Spine API | the host socket `/var/run/youeye/youeye.sock` is proxied into the container (`lib/spine/client.ts`) |
| Incus API | HTTPS on the `incusbr0` gateway, port 8443, with a client certificate in `/etc/youeye/incus-client.*` |
| Host memory | the host's `/proc/meminfo` at `/host/proc/meminfo` |
| Local access | host `127.0.0.1:3000` is proxied to the CP (recovery and Spine calls) |

Environment in the unit: `JWT_SECRET`, `HOST_IP`, `TEST_ADMIN_SECRET` (the deploy secret; also on the host in
`/var/lib/youeye/control/.deploy_secret`), `SECURE_COOKIES=true`, `INCUS_HTTPS_URL`, `INCUS_CLIENT_CERT`,
`INCUS_CLIENT_KEY`.

A CP update replaces the bundle with the one in the System release; no image rebuild or reboot
([releases.md](releases.md)).

## What runs where

The CP serves its pages on the box's main domain and on `control.<domain>`:

- `https://<domain>/settings` and `/market` are routed by Caddy to the CP (`ensureControlSettingsRoute` in
  `lib/caddy/client.ts`). Everything else on the main domain is the dashboard (`youeye-ui`).
- Settings is the only admin surface. `control.<domain>/` and the old shell paths (`/apps`, `/health`, `/people`,
  …) redirect to `/settings` (`middleware.ts`).
- On a bare IP (setup, recovery) the CP signs people in with host PAM through Spine; on a domain it uses YouEye ID
  (`lib/auth/mode.ts`). See [youeye-id.md](youeye-id.md).

Background jobs start in `src/instrumentation.ts`, only in the CP process (not in `youeye-id.service`):

- app-network bootstrap, then recovery of unfinished app updates (before anything else touches apps);
- DNS-provider and YouEye Names maintenance ([youeye-names.md](youeye-names.md));
- health monitor every 60 s: service checks, container watchdog with crash-loop detection, disk every 5 min,
  certificate expiry every 6 h, notifications on state changes (`lib/health/monitor.ts`);
- the update queue worker, Market version and health checkers, the backup scheduler;
- admission reconciliation and the 20 s admission push to the dashboard ([app-admission.md](app-admission.md));
- startup reconciliation of Incus containers.

## Deploy job

Spine's `youeye deploy` creates the CP container, then calls `POST /api/deploy/infrastructure` with the deploy
secret in `X-Deploy-Secret` and a body `{ "host_ip", "deployment_id" }` (`app/api/deploy/infrastructure/route.ts`).
The job runs on its own; the response is a Server-Sent Events stream of its progress. The job state is kept in
`/var/lib/youeye/control/deployments/<id>`, so Spine can query `GET /api/deploy/infrastructure/jobs/<id>` after a
dropped stream and retry with the same ID without starting a second job.

`deployInfrastructure` (`lib/infrastructure/deployer.ts`) runs five steps:

1. **PostgreSQL** (`youeye-postgres`, OCI): password from `/var/lib/youeye/postgres/.pg_password`; waits until it
   accepts connections.
2. **Caddy** (`youeye-caddy`, OCI): writes a base Caddyfile (admin API on its `incusbr0` address only,
   on-demand TLS asking the CP at `/api/setup/config`, internal issuer, everything proxied to the CP), then adds
   the default, ping and header-stripping routes.
3. **Pi-hole** (`youeye-pihole`, OCI): DNS bound to the host IP; the web password is set through a one-shot exec.
4. **Dashboard** (`youeye-ui`, Incus system container) from the release's UI component; health and egress ACL
   checked.
5. **Pointer** (`youeye-pointer`): deferred until setup has set the domain; then deployed, health-checked and
   routed.

Image references for PostgreSQL, Caddy and Pi-hole come from the Market's `system/` manifests
(`lib/infrastructure/system-market-manifests.ts`). Each container gets the `critical` resource policy.

`POST /api/deploy/infrastructure/reconcile` (used by `youeye deploy --resume`) creates only missing containers and
re-checks the security posture; it never replaces running ones.

## Settings

The platform settings file is **`/var/lib/youeye/config/youeye.yaml`** on the host. Spine owns it. The CP reads it
with `GET /api/config` on the Spine socket and writes with `PATCH /api/config` (`lib/settings/service.ts`); it never
writes the file itself. Reads are cached for 5 s. If Spine cannot be reached, the CP reads the file directly.

Keys the CP uses:

| Key | Meaning |
|---|---|
| `site_name` | server name shown in titles |
| `domain` | the box's domain, e.g. `sandy-spring.ui.bingo` |
| `subdomains` | `identity` (YouEye ID host, setup proposes `id`), `control`, `dns`, optional `ui` |
| `setup_completed` | the setup wizard finished |
| `language` | instance default language |
| `smtp_host`, `smtp_port`, `smtp_username`, `smtp_from`, `smtp_require_tls` | outgoing mail (password in `/var/lib/youeye/control/.secret_smtp_password`) |
| `identity` | `provider: youeye-id`, optional display `name` |
| `extra` | free key/value settings |

The backup schedule is also in `youeye.yaml`, but Spine reads and writes it (`spine/internal/backup/scheduler.go`).
The release channel is Spine's host policy (`youeye channel get|set`, `/api/releases/channel`).

### Settings pages

`app/settings/(shell)/` and `components/settings-shell/`. The menu shows Profile, Appearance, Privacy, Apps, AI
and Language to every user, and Users, System, Network, Backup and About to admins. Sub-pages cover branding, TLS,
DNS, proxy, remote access, containers, permissions, system health and SSH keys. Admin APIs check `session.isAdmin`,
and changes also need a CSRF token (`X-CSRF-Token`).

## Data on the host

| Path | Contents |
|---|---|
| `/var/lib/youeye/config/` | `youeye.yaml`, `tls/` (certificates), `cli-token`, `server-url-change.json` |
| `/var/lib/youeye/control/` | deploy secret, UI bridge token, SMTP password, `deployments/` |
| `/var/lib/youeye/state/` | `installed-apps.json`, `update-queue.json`, `update-status.json`, `app-updates/` (update journals), `app-service-credentials/`, `container-maintenance/`, `core-component-schemas/` |
| `/var/lib/youeye/app-<id>/` | per app: `install.json`, `secrets/` (mode 0600), app volumes |
| `/var/lib/youeye/<service>/` | secrets and data of `postgres`, `caddy`, `pihole`, `ui`, `ui-data`, `pointer` |
| `/var/lib/youeye/networks/` | app network allocations (`ipam.json`, operations) |
| `/var/lib/youeye/backups/` | backup staging, imports from a drive, restore status |
| `/opt/youeye-control-data/` (inside the container) | YouEye Names and own-domain state, telemetry |

YouEye ID and the admission tables are in PostgreSQL (`youeye` database); the dashboard uses `youeye_ui`, Pointer
`pointer`.

## Updates

| What | How |
|---|---|
| Spine, CP, dashboard, image | the System release, applied by Spine. Settings → System; `GET /api/appliance/core-update/check`, then `POST …/core-update/{stage,activate,resume,recover,cancel}` with exact request, command and manifest IDs. The CP only forwards; see [releases.md](releases.md) and [spine.md](spine.md). `POST /api/updates/{spine,control,ui}` is refused (`409 system_release`). |
| Release channel | `GET`/`PUT /api/releases/channel` (`dev`, `alpha`, `beta`, `stable`). The box never downgrades. |
| PostgreSQL, Caddy, Pi-hole | Settings → System: `GET`/`POST /api/deploy/infrastructure/system-updates` compares each container with the image in the Market's `system/` manifest and rebuilds it (`lib/infrastructure/system-updater.ts`). |
| Incus, host packages | `POST /api/updates/{incus,system}` asks Spine to update Incus or the host packages (`system` is refused while a critical health issue is open). A queue (`POST /api/apps/<name>/enqueue`, `lib/updates/queue.ts`, `update-queue.json`) runs such updates one at a time. The Settings pages call neither today. |
| Market apps | `POST /api/market/update`; a journaled, recoverable transaction. Status and recovery: `GET /api/market/update/status?appId=…`, `POST /api/market/update/recovery`. See [app-update-transactions.md](app-update-transactions.md). |

All update routes need an admin session; changes also need a CSRF token.

## Backups

Backups go to an external drive. The code is `lib/backup/` (CP) and `spine/internal/backup/` (Spine).

**Drive.** A drive must have an ext4 partition labelled `YOUEYE-BACKUP`. Settings → Backup can prepare (format) a
blank drive (`POST /api/backup/media` with `action: prepare`, `confirm: true`). When a drive is plugged in, the
CP shows a notification that links to Settings → Backup.

**Recovery key.** Every backup is encrypted with a passphrase of 12–256 characters. For scheduled backups Spine
stores it at `/var/lib/youeye/backup/.passphrase`, encrypted with a key derived from the deploy secret. Lose the
key and the backups cannot be read.

**What a backup holds** (`createPlatformBackup` in `platform-backup.ts`): one backup set,
`backup-<UTC time>-<random>`, with

- a **core** archive (`core-backup.ts`): dumps of the `youeye`, `youeye_ui` and `pointer` databases, `youeye.yaml`,
  the installed-apps list, infrastructure secrets, Caddy and Pi-hole configuration, and the data of
  `/var/lib/youeye/{caddy,pihole,config,networks,ui,ui-data,pointer}`. The system containers are frozen briefly
  while their volumes are copied.
- one archive per selected app (`app-backup.ts`): its frozen manifest, `install.json`, secrets, database dump,
  volumes and admission metadata.

Each archive is encrypted (`openssl` AES-256-CBC with PBKDF2). The set is then written to a restic repository on the
drive, checked, and the local copy deleted. A failed set is deleted; it is never a recovery point. The set records
the source's runtime kind, image, Spine, CP and UI versions and State/Data schema versions.

**Schedule.** `POST /api/backup/media` with `action: schedule`: daily or weekly at a time (default 03:00), each app
daily or weekly. The CP checks every minute whether a backup is due. `action: schedule, enabled: false` turns it
off. A manual backup: `POST /api/backup/core` with the key, the drive and the app IDs.

**Restore** (`POST /api/backup/restore`, admin) needs:

- the drive (`mediaId`) and the recovery point (`backupId`) on it;
- the recovery key;
- `confirm: true` and a fresh `operationId` (UUID v4);
- `restoreCore: true` and/or `appIds`.

Rules:

- The recovery point must be compatible: same runtime kind, and not made by a newer System (higher State or Data
  schema). Update the box first in that case (`compatibility.ts`).
- **Platform restore** (`restoreCore`) first makes a pre-restore backup of the current box, then restores the core
  (settings, secrets, databases, Caddy, Pi-hole) and the chosen apps, and restarts the CP. If it fails, it restores
  that pre-restore backup automatically.
- **App restore** (`app-restore.ts`) replaces one app: uninstall, restore secrets and database, reinstall in restore
  mode, restore volumes, restart and health-check. Ownership and admission are checked against the current box;
  see [app-admission.md](app-admission.md). App service credentials are never taken from the archive
  ([app-service-credentials.md](app-service-credentials.md)).
- Progress streams as SSE; the result is kept in `/var/lib/youeye/backups/.restore-status/<operationId>.json`.
  Only one backup or restore runs at a time (a kernel lock).

The setup wizard can also restore from a drive on a fresh box; that path is in
[setup-readiness.md](setup-readiness.md).

## The dashboard

The dashboard (`ui/`, container `youeye-ui`) is a separate Next.js app on the main domain. The CP deploys it,
creates its YouEye ID client and pushes data to it over the authenticated UI bridge (`/api/ui-bridge/*` on the
dashboard). Its home page holds widgets: server name, greeting, clock, bookmarks, and widgets from installed native
apps (`ui/src/components/widgets/`). It also has the Timeline ([timeline-collection.md](timeline-collection.md)),
notifications and an app drawer, and works as an installable web app.

## Troubleshooting

- `youeye deploy --resume` re-runs the reconcile job without replacing containers.
- CP logs: `incus exec youeye-control -- journalctl -u youeye-control -u youeye-id`.
- The CP answers on the host at `http://127.0.0.1:3000` even when Caddy is down.
- System Health (Settings → System → Health) lists open issues with their repair actions.
