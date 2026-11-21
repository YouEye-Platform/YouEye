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
`INCUS_CLIENT_KEY`. Both units have `SuccessExitStatus=143` (Next.js exits with 143 on SIGTERM, so a normal stop is
not logged as a failure); units written before 0.6.10 are not rewritten, so only fresh deployments have it. The same
holds for the unit template the CP writes into the dashboard, native app and Pointer containers
(`lib/infrastructure/lxd-deployer.ts`): `SuccessExitStatus=143` since 0.6.10, in units written from then on.

A CP update replaces the bundle with the one in the System release; no image rebuild or reboot
([releases.md](releases.md)).

## What runs where

The CP serves its pages on the box's main domain and on `control.<domain>`:

- `https://<domain>/settings` and `/market` are routed by Caddy to the CP (`ensureControlSettingsRoute` in
  `lib/caddy/client.ts`). Everything else on the main domain is the dashboard (`youeye-ui`).
- Settings is the only admin surface. `control.<domain>/` and the old shell paths (`/apps`, `/health`, `/people`,
  …) redirect to `/settings` (`proxy.ts`).
- On a bare IP (setup, recovery) the CP signs people in with host PAM through Spine; on a domain it uses YouEye ID
  (`lib/auth/mode.ts`). See [youeye-id.md](youeye-id.md).

Background jobs start in `src/instrumentation.ts`, only in the CP process (not in `youeye-id.service`):

- app-network bootstrap, then recovery of unfinished app updates (before anything else touches apps);
- DNS-provider and YouEye Names maintenance ([youeye-names.md](youeye-names.md));
- the app reconcile queue, then the health monitor (about every 60 s: service checks, container watchdog, disk every
  5 ticks, certificate expiry every 360 ticks, notifications on state changes; `lib/health/monitor.ts`) and the app
  prober (about every 30 s); see [App health and automatic restarts](#app-health-and-automatic-restarts);
- the Market version checker (45 s after start, then every 6 hours plus jitter), the UI and Pointer update checks
  (`lib/apps/update-cache.ts`, every 3 hours plus jitter), the backup scheduler;
- admission reconciliation and the 20 s admission push to the dashboard ([app-admission.md](app-admission.md));
- startup reconciliation of Incus containers.

## App health and automatic restarts

Three parts keep an app container that should run running, and none of them fights an update, a backup or the
owner (since 0.6.14):

- **The app prober** (`lib/market/app-prober.ts`, run by `lib/market/health-checker.ts`) checks each installed app
  and publishes its health. It never takes the app's lifecycle lock. It reads intent first: an app reserved by an
  update is `maintenance`; an app the owner stopped is "Intentionally stopped by administrator"; an app another
  operation of this process holds (the in-memory held marker that `withAppLifecycle` sets) is "Busy with another
  operation on this app". None of these counts as a failure. Then: storage reachable, the main container Running
  (L1), its service active for a native app (L2), its other containers Running (else `starting`), and its HTTP
  health check (L3; 2xx, 401 and 403 pass). A failure seen while the app was taken by an operation counts as busy.
  After `retries` failures in a row (default 3) and with auto-restart on, it asks the app's queue for a restart,
  with a backoff from 10 s doubling to 5 minutes; after two rounds at 5 minutes the app is `crash-looping` and an
  issue is raised. Ten healthy minutes reset the backoff.
- **The watchdog** (in the health monitor) lists the Incus instances each tick. It starts the platform's own
  `youeye-*` containers itself (not `youeye-control` and `youeye-pihole`), with its own crash-loop rule (below).
  App containers it only observes: one that should run (the app not stopped by the owner, its storage reachable,
  `boot.autostart` not `false`, no container maintenance) and is Stopped is a start request for the app's queue.
- **One reconcile queue per app** (`lib/apps/app-reconciler.ts`, one per process) is the only part that starts or
  restarts app containers by itself. Requests merge (start and start is one start; anything with a restart is a
  restart). Every operation that takes the app with `withAppLifecycle` (the owner's stop or start, an update, a
  backup, a restore) cancels what is pending at its begin and asks again at its end, so a container that crashed
  meanwhile is started at once. The listener hears who took the app. A user's request (anything inside
  `withUserOperationLockWait`: the owner's stop, start, restart or uninstall, an update) drops what was pending for
  good, and its end asks for a plain start. A background pass (the 30 s app reconcile, a scheduled backup) only
  postpones a restart the prober asked for: its end asks for that restart again, also when the worker was already
  working on it (it finds the app busy and gives up). If the background operation restarted the app itself, that
  restart is one too many; the two are not told apart. The queue's own work runs outside
  the context of the operation whose end asked (`outsideOperation` in `update-admission.ts`): it never waits like a
  user, is never cancelled by a user's request ending, and holds no admission of that operation. The worker takes
  the app's lock without waiting, re-checks every condition under
  it, then starts the stopped containers in the order updates use (database, cache, sidecar, worker, the main
  container last; `lib/apps/container-order.ts`), waiting after a database or cache until it accepts work as an
  update's reopen does (`pg_isready` as the app's user for its own PostgreSQL, else its declared HTTP health check;
  one that is not ready in time is logged and the rest start anyway). A restart starts the stopped dependencies the
  same way, then reads the main container's state again and restarts it cleanly (forced only after 20 s, logged:
  shorter than the 30 s a user waits for the app), or starts it when it is not running any more. If that fails, the
  dependencies it had started still count towards the crash loop. Every rule of an automatic
  start holds for a restart too: the owner's stop, container maintenance, unreachable storage, an update's
  reservation, `boot.autostart` `false` on the main container and the crash-loop pause (below) each leave the app as
  it is, and a stopped dependency that is paused or has autostart off is not started. A busy
  lock is retried after 2–5 s. A user operation waiting for the lock goes first, for at most two minutes, then the
  queue takes its turn. That also holds while the queue has the lock: the wait for a database to get ready ends as
  soon as a user waits (polled every 2 s), and a restart checks before each dependency and before it stops the main
  container; the queue gives the lock back and asks again. Only a clean stop of the main container that has begun
  is finished first (seconds for most apps, 20 s at most). An app reserved by an update or stopped by the owner is
  left alone.

**Crash loops.** Three automatic starts of one app container within 5 minutes pause its automatic starts and raise
the issue `container.<name>.crash-loop` ("`<name>` keeps crashing", "Automatic starts are paused; one more try 10
minutes after the last start."). A restart the prober asked for is an automatic start: it counts (for the main
container and for each dependency it had to start), and while a container is paused neither the watchdog's start nor
the prober's restart touches it. Ten minutes after the last start one more round is allowed. The record and the
issue clear when the container has run for 10 minutes after its last automatic start, if that was a start of a
stopped container; if it was a restart the prober asked for, the container ran all along without answering, so they
clear only when the prober finds the app healthy 10 minutes or more after that restart (an app that runs but never
gets healthy keeps its issue). They also clear when the owner starts or
restarts the app, or at the next watchdog tick once no install record owns the container any more (the app was
uninstalled). The platform's own containers follow the same numbers in the watchdog: 3 starts in 5 minutes, one
more try 10 minutes after the last, cleared after 10 minutes without a restart.

**Timers** (`lib/health/jittered-timer.ts`): the prober and the health monitor each run first at a random point
60–90 s after the Control Panel starts, then every period ±15 % (30 s and 60 s). Their ticks never line up for
long. The memory throttle check runs every 15 s on a plain interval.

The queue logs every action as `[app-reconciler] <app>: …`: "started `<container>` (`<reason>`)", "restarted
(`<reason>`)", "busy, retrying in N s", "a user operation goes first, retrying in N s", "automatic recovery
failed: …", "`<container>` keeps crashing; automatic starts paused, one more try in 10 minutes". An automatic
restart is also written to the Timeline.

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

The images of PostgreSQL, Caddy and Pi-hole are pinned by digest in `lib/infrastructure/system-images.ts`. They
ship with the Control Panel and change only with a System release; no Market source can supply or replace them, so
first deployment does not need the Market for them. Each container records its image in the Incus keys
`user.youeye.market.image` and `user.youeye.market.version` (the names are older than the pins and are kept so that
existing containers stay tracked). Each container gets the `critical` resource policy.

Pi-hole's own update check is off: Pi-hole changes only with a System release. The pinned image has no setting for
it (its `start.sh` runs `pihole updatechecker` at every start and its crontab daily, and that script asks
`api.github.com` and `git ls-remote https://github.com/pi-hole/…`), so `lib/infrastructure/pihole-update-check.ts`
replaces each line of `/opt/pihole/updatecheck.sh` that asks GitHub with `echo "null"`; the local versions that
`pihole -v` and the web interface show are still recorded. A new container is created stopped and edited before its
first start (deploy, reconcile, repair, image rebuild), and the Control Panel edits an existing one at every start.
The edit never fails a deploy or an update, and Pi-hole always starts after it: only whole simple lines are replaced
(no continuation, keyword or brace, balanced quotes), the result must name no GitHub address and pass `bash -n`, and
otherwise (a future pin with another form, or a failed write, which puts the original back) the original script
stays and `[Pi-hole] Update check left as it is: …` is logged.
Pi-hole's block list still comes from GitHub (`raw.githubusercontent.com`, weekly) until it moves to a YouEye host.

`POST /api/deploy/infrastructure/reconcile` (used by `youeye deploy --resume`) creates only missing containers and
re-checks the security posture; it never replaces running ones.

## Who may call what

- **The proxy** (`src/proxy.ts`, Next 16's name for middleware; Node.js runtime) runs before every page and API
  route. Outside its `PUBLIC_ROUTES` and `/embed`, it needs a valid session cookie, or, for `/api/*`, the CLI token:
  an `X-CLI-Token` header passes only when it equals `/etc/youeye/cli-token` (`lib/auth/cli-token.ts`), else 401.
  Without `JWT_SECRET` it refuses everything non-public (503).
- **Same-origin writes:** a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` must carry an `Origin` equal to the
  request's own origin (scheme from `X-Forwarded-Proto`), or no `Origin` and no cross-site `Sec-Fetch-Site`; else 403.
  The session cookie is `SameSite=None` on HTTPS names, so this is what stops other sites posting with it.
- **In the handler:** admin routes call `requireAdmin()`, and admin writes `requireAdminCsrf(request)`
  (`lib/auth/rbac.ts`; the CLI token passes both), or guard with `if (!session?.isAdmin)`. `tests/route-auth.spec.ts`
  walks every `route.ts`: each handler checks for an admin, or is listed there as public or as one a standard user may
  call, with the reason. A session check alone is not enough: the standard-user list holds reads (the Market, the
  Apps list, the domain, branding) and the caller's own account (profile, avatar, password, consents, sign-out).
  The Pi-hole, Caddy, TLS, Names, bridges, people and container reads are admin-only. There is no SQL console
  (0.6.15 deleted `/api/apps/postgres/*`, whose `query` let any signed-in user run SQL and a root shell in
  `youeye-postgres`).
- **Waiting for a busy app:** user-facing lifecycle routes (install, remove, start/stop, update and recovery,
  connections and suggestions, access, credentials, AI Settings, bundles, restore, URL and Names changes, Health's
  Fix) run as user operations (`withUserOperationLockWait`, `lib/http/lifecycle-busy.ts`): every app, inventory and
  app-network lock they take waits up to 30 s for its holder. Background passes never wait, skip a busy app, and an
  automatic start yields to a waiting user. Still busy after 30 s: `409 {"code": "operation_in_progress"}`, never a
  500. Other failures are logged with their cause chain (`[Market] <operation> failed: …`) and answered with a fixed
  message.
- **Market sources:** an install, bundle install, app update or source switch reads only the official Market, a
  custom market the owner accepted, or an app added by URL with its own confirmation (`lib/market/source.ts`; see
  [market.md](market.md#markets-and-consent)). Markets are read as static files from their HTTPS address and kept in
  `/var/lib/youeye/markets/` ([market-format.md](market-format.md)); pages read that copy, never the network.
- **Orphans** (`/api/admin/orphans`, `youeye orphans [clean]`): admin only. Only resources an install left behind are
  listed: installation-tagged containers no record names, Market app routes (id `app-route-<app>-…`, since 0.6.8) of
  apps with no install or kept-data record, app databases and YouEye app storage no record names. Platform routes,
  hand-made routes and platform databases are never listed; cleanup re-checks each item before removing it.

## Setup hosts and cookies

- **Setup hosts** (`isLocalSetupHost` in `lib/auth/mode.ts`): an IPv4 literal or exactly `youeye.local` /
  `youeye-<N>.local` (the names Avahi publishes), on any port except 3000, and never the platform domain or a name
  under it. `youeye(-N).local` is refused as a platform domain. Setup hosts serve only the onboarding surface: claim
  and setup before setup is complete; afterwards only setup-complete, reset-owner and what those pages call
  (`lib/auth/setup-host-paths.ts`). A password sign-in over plain HTTP on a setup host is refused. Every other host
  is a named host (YouEye ID sign-in, dashboard, apps).
- **HTTP on setup hosts:** Caddy's `:80` server `setup_http` (`lib/caddy/servers.ts`) proxies setup hosts to the
  Control Panel and redirects every other host to HTTPS (308). Caddy's own redirects are off only while `setup_http`
  exists; the CP adds it at every start (`lib/caddy/setup-http-startup.ts`), so updated boxes keep redirecting. Every writer of the live
  Caddy config picks the `:443` server by its listen address and never puts routes on `setup_http`.
- **Cookies** (`secureCookieFor`): on setup hosts (and loopback) `Secure` follows `X-Forwarded-Proto`, so a claim
  over HTTP keeps its session; named hosts always get `Secure`. No HSTS is sent anywhere.
- **Internal certificates:** 7-day leaves and a 30-day intermediate under the box CA (Spine places its root before
  Caddy starts); `on_demand_tls` asks `/api/setup/config` (`permission http`). The Caddyfile is built in
  `lib/caddy/caddyfile.ts`. `GET /api/setup/ca-fingerprint` (setup hosts only) gives the root's SHA-256, which the
  "Use a secure connection" panel shows next to the download; tty1 and the Preparing page show the same value.
- HTTP pages aren't a secure context: the setup pages avoid the Clipboard API (`lib/copy-text.ts` falls back to a
  selected text field), `crypto.subtle`, service workers and WebAuthn.

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

Changed settings reach installed apps through their containers' environment (`lib/market/propagation.ts`): saving
SMTP settings writes `SMTP_*` to every app whose manifest declares `capabilities.smtp`, and a reconfigure writes
`YOUEYE_SITE_NAME`, `YOUEYE_TIMEZONE`, `YOUEYE_LOCALE` and `YOUEYE_PLATFORM_VERSION` to every app. An app whose
containers already hold every value is left alone: no lock, no write, no restart, so a reconfigure that changed none
of them restarts no app. Any other app is changed under its lifecycle lock; its running containers are then restarted
as one (clean stops in stop order, forced only after each role's timeout, then starts in start order). A stopped
container reads the new values at its next start. A domain change restarts each app once: its URL step writes the
four platform keys before its own restart, and the propagation after it finds them in place.

Every such write also sets `user.youeye.env-restart-pending: "1"` on the container, in the same request; the mark
is removed once the container has been stopped or restarted (a stopped one loses it at once). While it is set the
container does not count as holding the values, so a write whose restart never happened (the Control Panel died, a
stop failed, a URL change threw after writing its keys) is finished by the next propagation: it restarts the app's
running containers and clears the mark. The URL step sets the same mark with the domain values it writes, and an
env file it changed is marked before it is rewritten. The restart happens only when at least one marked container
is Running or Stopped: a container that is Frozen, or whose state can't be read, keeps its mark without restarting
the app's other containers at every propagation. The owner's start clears the mark of each container it starts (one
that already ran keeps it), and the owner's restart clears it on every container. A mark that can't be cleared is
logged and costs one more restart at the next propagation; it never leaves stopped containers unstarted.

The backup schedule is also in `youeye.yaml`, but Spine reads and writes it (`spine/internal/backup/scheduler.go`).
The release channel is Spine's host policy (`youeye channel get|set`, `/api/releases/channel`).

### Settings pages

`app/settings/(shell)/` and `components/settings-shell/`. The menu shows Profile, Appearance, Privacy, Apps, AI
and Language to every user, and Users, System, Network, Backup and About to admins. Sub-pages cover branding, TLS,
DNS, proxy, remote access, containers, permissions, system health and SSH keys. Admin APIs check `session.isAdmin`,
and changes also need a CSRF token (`X-CSRF-Token`).

### The installed release

What the box shows and reports as its YouEye version is the `version` of the System release document Spine
accepted (`lib/releases/installed-release.ts`): `0.6.13-dev.5` on dev, `0.6.13-alpha.1`, `0.6.13-beta.1` or
`0.6.13` for the same files promoted ([releases.md](releases.md#what-a-box-shows)). It is read from the recorded
selection (`/var/lib/youeye-state/core-selection/core-release.json` in `youeye-control`), else from Spine's
`GET /api/version` `release`. A version baked into a file (`version.json`, Spine's own `version`) is never shown.

- **About** shows the version and a details line, `<version> · <short git tree>` (`0.6.13 · b39fe307`), with a Copy
  button for support. Settings → System, Settings → Apps (Spine, Control Panel and UI), the UI's app list and
  backups show release versions too; the AI page and service health show Pointer's release version.
- **YouEye Names:** the heartbeat sends it as `youeyeVersion`.
- **Apps:** the platform context (`lib/market/platform-env.ts`) carries it, and `requires.youeye` is checked
  against it by line.
- **The dashboard** cannot read State, so the Control Panel writes `/etc/youeye/release.json` (`{version,
  source_tree}`, mode 0644) into `youeye-ui`. A publisher started by `instrumentation.ts` looks at the accepted
  document every 60 s, reads the UI's copy and writes it when it differs (a core update, a promotion that only
  renamed the release, or a UI container replaced by `apply-ui` after the new Control Panel started); after a failure
  it retries at 30 s, doubling up to 30 minutes. The UI reports that version in its platform API and in the
  telemetry export (`youeye_version`, [telemetry.md](telemetry.md)); without the file it falls back to its own
  `version.json`, and a development server reports `development`.

## Data on the host

| Path | Contents |
|---|---|
| `/var/lib/youeye/config/` | `youeye.yaml`, `tls/` (certificates), `cli-token`, `server-url-change.json` |
| `/var/lib/youeye/control/` | deploy secret, UI bridge token, SMTP password, `deployments/` |
| `/var/lib/youeye/state/` | `installed-apps.json`, `update-status.json`, `app-updates/` (update journals), `app-service-credentials/`, `container-maintenance/`, `core-component-schemas/` |
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
| Spine, CP, dashboard, image (Incus and the host packages with it) | the System release, applied by Spine. Settings → System; `GET /api/appliance/core-update/check`, then `POST …/core-update/{stage,activate,resume,recover,cancel}` with exact request, command and manifest IDs. The CP only forwards; see [releases.md](releases.md) and [spine.md](spine.md). |
| Release channel | `GET`/`PUT /api/releases/channel` (`dev`, `alpha`, `beta`, `stable`). The box never downgrades. |
| PostgreSQL, Caddy, Pi-hole | Settings → System: `GET`/`POST /api/deploy/infrastructure/system-updates` compares each container with the image pinned in `system-images.ts` and rebuilds it on that image (`lib/infrastructure/system-updater.ts`). Settings → Apps and the `/embed/apps` page use `POST /settings/api/apps/{postgres,caddy,pihole}/update` with the same acknowledgements (`confirmMaintenanceWindow`, `confirmContainerName`, and `allowDatabaseUpdate` for PostgreSQL). `POST /api/apps/{postgres,caddy,pihole}/update` (the progress stream behind `youeye app update <id>`) runs the same action (`lib/apps/system-container-update.ts`) when the body carries those acknowledgements; without them, as from the CLI, which has no flags for them, its stream ends `failed` with "… is a system container … Update it in Settings → Apps" before anything is touched. The two JSON routes answer HTTP 423 naming the issue while a critical health issue is open. The `/settings/api/apps/<id>/update` route ignores that container's own issue (`service.<id>.down`, `container.<name>.crash-loop`), which the update may repair; `system-updates` makes no such exception. There is no moving-tag update path (`updateOCIApp`, which no built-in app could use, was deleted in 0.6.15). |
| Incus, host packages | only with the image of a System release. There is no apt route: `/settings/api/apps/<id>/update` and `/api/apps/<id>/update` answer that Spine, the Control Panel, the UI and Incus have no app update (HTTP 404, nothing recorded). |
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
  `/var/lib/youeye/{caddy,pihole,config,networks,ui,ui-data,pointer}`, and the Market's sources and apps added by
  URL (`market/`, listed as `marketFiles` in `backup-meta.json`; see [market.md](market.md#backups)). The system
  containers are frozen briefly while their volumes are copied. (`networks` is in the archive as a record of the
  box; no restore applies it.)
- one archive per selected app (`app-backup.ts`): its frozen manifest, `install.json`, secrets, database dump,
  volumes and admission metadata.

Each archive is encrypted by Spine (`openssl enc`, AES-256-CBC, the key from the passphrase by PBKDF2-SHA256 with
10,000 iterations; `spine/internal/backup/encryption.go`) and authenticated by an HMAC-SHA256 file beside it
(`.hmac`, `integrity.go`). Since 0.6.15 the HMAC key is derived from the passphrase by PBKDF2 too (the same digest and
iterations, salted with the label `youeye-backup-archive-mac:` and the archive's own OpenSSL salt), so guessing the
passphrase against the `.hmac` file costs as much as against the ciphertext. Spine passes every parameter to OpenSSL
and reports them with the finished archive. Since 0.6.15 the set records them in `backup-set.json` as
`encryption: {cipher, kdf, digest, iterations, mac}` (`mac: "hmac-sha256-pbkdf2"`), and a restore sends them back
with each archive of the set (`readBackupEncryption` in `full-restore.ts`; an app's rollback archive uses its own
backup's). A set with no `backup-set.json`, or one with no `encryption` (made up to 0.6.14), or one without `mac`,
is read with the parameters of that time, which are the same values, and its `.hmac` file is checked with the raw
passphrase as its key. A `backup-set.json` that is there but cannot be read, or is not a JSON object, is refused
with "The backup set's record (backup-set.json) is damaged" (never read as an older set, which would fail as a wrong
passphrase). Spine refuses parameters it cannot read. The set is then written to a restic repository on the
drive, checked, and the local copy deleted. A failed set is deleted; it is never a recovery point. A set left `creating` by a backup that
ended midway (a power cut) is deleted by the next backup, before it writes anything. One whose store to the drive
never finished is complete (its record already says `completed`, which restic reads; `sets/<id>.storing` marks it
from just before the store until its local copy is gone) and may be the only complete copy of that backup, so it
goes only when a later set that holds what it holds is safe: written, and stored on the drive when it was made for
one. The same holds when the store ends without Spine's answer (Spine restarted under it, as a System update may
do: a store holds only the backup operation lock; its socket was not there or refused at that moment; or it did
not answer within the step's limit; all three are a `SpineTransportError` of the Spine client): the backup fails, but the set is kept as such a set instead of
being deleted as a failed one (since 0.6.15; a store that Spine refuses, or that fails on the drive, still deletes
it). Every set holds the core, so "holds" means each of the kept set's apps that is still installed (its
`backup-set.json` lists them); a set of fewer apps (a scheduled backup of the apps that are due, a selection, a
set that skipped an app with an unfinished update) leaves it alone (the first cut let any successful set delete
it, and with it the only complete copy of the other apps). A backup that fails
keeps it (before that, it was deleted before anything was written, and a backup that then failed left no complete
copy). Of several such sets, one that a newer one of them holds goes when the next backup starts, and so does one
whose record is missing or does not say `completed` (not a recovery point). Until such a backup succeeds it takes
a whole backup's space on
Data; `rm -rf /var/lib/youeye/backups/sets/<id> /var/lib/youeye/backups/sets/<id>.storing` removes it by hand. A
completed set without the marker (made without a drive, or a pre-restore backup the drive
could not take) is a local recovery point and stays. The set records
the source's identity (`youeye.backup.source.v1`, `lib/backup/compatibility.ts`): runtime kind, image, Spine, the
State/Data schema versions and, since 0.6.12, the installed releases as `release` (YouEye), `control_panel` and `ui`
(the YouEye release with each part's own git tree) and `pointer` (its product release), each `{version, line,
sequence, source_tree}`. The older build-name fields (`control_panel_version`, `ui_version`, `pointer_version`) are
still written next to them until the Release cleanup. A backup shows the YouEye release version it was made by.

**Schedule.** `POST /api/backup/media` with `action: schedule`: daily or weekly at a time (default 03:00), each app
daily or weekly. The CP checks every minute whether a backup is due. `action: schedule, enabled: false` turns it
off. A manual backup: `POST /api/backup/core` with the key, the drive and the app IDs.

**Restore** (`POST /api/backup/restore`, admin) needs:

- the drive (`mediaId`) and the recovery point (`backupId`) on it;
- the recovery key;
- `confirm: true` and a fresh `operationId` (UUID v4);
- `restoreCore: true` and/or `appIds`.

Rules:

- The recovery point must be compatible: same runtime kind, not made by a newer System (higher State or Data
  schema), and not made by a newer Control Panel, UI or Pointer. Releases are compared by line and sequence (the
  same git tree is the same software); a backup from before 0.6.12 has build names only and is compared by line,
  and within one line by the old build rule only between two dev build names. Update the box first in that case
  (`compatibility.ts`).
- **Platform restore** (`restoreCore`, `full-restore.ts`) first runs the checks that can refuse it (below), then
  makes a pre-restore backup of the current box, then restores the core (settings, secrets, databases, Caddy,
  Pi-hole) and the chosen apps, and restarts the CP.
  - **Apps.** The chosen apps (`appIds`, possibly none) are replaced by their archives: removed, then reinstalled.
    Every other installed app is kept and is never removed, by the restore or by its rollback. A kept app is
    stopped while the core is replaced, then its service credential is reconciled and it is started again if it
    was running. An installed app the backup's core does not know (installed or reinstalled after the backup) can't
    be kept: the restore refuses before it changes anything ("Retained `<app>` requires a matching core identity or
    its app archive"). An app in the backup that is neither chosen nor installed stays absent, and what the
    restored core recorded for it (route, sign-in client, DNS) is removed.
  - **App networks.** The backup's `/var/lib/youeye/networks` is never applied. The allocator (`ipam.json`)
    describes the bridges on the box now: kept apps keep their `yeapp<N>` bridge and subnet, a removed app's lease
    was released with it, and a restored app gets a network like any install (the lowest free bridge and subnet,
    which can differ from the ones in the backup; nothing else in a backup refers to them). A lease still held by
    an app that is not installed is released before the app is reinstalled.
  - **YouEye ID sign-in.** The apps' YouEye ID clients are rows of the restored `youeye` database. A kept app
    still holds the client secret it was given last, so its client row (secret, redirect addresses, scopes, role
    claim) is read before the databases are replaced and written back after: the box's own client, not the
    backup's. Nothing changes inside the app and no setup file runs. (A restored app is reinstalled and gets a new
    client. Forward-auth sign-in has no client.) The rollback of a failed restore writes back the same rows.
  - **AI Settings.** Pointer's database comes back from the backup, and Pointer keeps only the hashes of the app keys
    it issued. A kept app still holds the key it was given last, so after its credential is reconciled its AI
    connection is checked against Pointer (`reconcileKeptManagedAI` in `managed-ai.ts`): when Pointer still has that
    key, the model group (while it still has models) and the enabled state the owner chose since the backup are
    applied again; when it does not (AI connected
    after the backup), the backup's record is archived and the app gets a new connection for the same owner, in its
    group (or the owner's default group), in the state it had, with a new key written into it. When that is not
    possible (Pointer not ready, the owner or every model group gone), the restore still finishes and its log asks
    the owner to connect the app's AI again.
  - **App service credentials.** The dashboard's credential table comes back with its database; the Control
    Panel's credential store is outside every restored volume. A kept app is reconciled, a restored app gets a new
    credential, and every other app either side knows is revoked at one revision on both sides, so that it can be
    installed again later ([app-service-credentials.md](app-service-credentials.md#restore)).
  - **Failure.** A restore refused before it changed anything is not rolled back ("Restore refused, nothing on the
    server was changed"); the refusing checks run before the pre-restore backup is made. An app that cannot be
    restored does not stop the apps after it: they are restored, and the restore then fails naming every app
    that did not come back (the same in the rollback). Otherwise the rollback is a restore of the same kind from
    the pre-restore backup: the apps that were being replaced come back from it, an app the failed restore added is removed, the core services
    it left stopped are started, and the kept apps are reconciled and started. A rollback that fails is run once
    more from where it stopped. If that fails too, the kept apps are still installed (see
    [troubleshooting.md](troubleshooting.md#a-restore-failed)), the message gives the rollback's own error, and
    the pre-restore backup is written to the backup drive as a recovery point (it stays in
    `/var/lib/youeye/backups/sets/<id>` only when the drive cannot take it).
  - **Core services.** The restore stops Caddy, Pi-hole, the dashboard and Pointer while it replaces their data
    and starts them again itself. From its first change to its end, rollback included, the watchdog does not start
    them and the health monitor does not report them as down (`holdContainersForOperation` in
    `lib/maintenance/container-maintenance.ts`; in memory only, so it ends with the Control Panel process). Each
    step of the restore and of the rollback is written to the Control Panel's log (`[restore] …`).
- **App restore** (`app-restore.ts`) replaces one app: uninstall, restore secrets and database, reinstall in restore
  mode, restore volumes, restart and health-check. Ownership and admission are checked against the current box;
  see [app-admission.md](app-admission.md). App service credentials are never taken from the archive
  ([app-service-credentials.md](app-service-credentials.md)).
  - The reinstall does not run `setup/install.yaml`: the app's first-run state is in the restored data. It runs
    `setup/sso.yaml` when sign-in is on, and a failure there is reported without failing the restore
    ([app-manifest.md](app-manifest.md#setup-files-setupyaml)).
  - When the reinstall fails, the secrets (`/var/lib/youeye/app-<id>`) and the shared database and role the
    restore had put in place are removed again, so the app can be restored or installed afterwards. The data is
    still in the archive.
  - With several apps and no core (`restoreCore` false), an app that cannot be restored does not stop the apps
    after it; the request fails at the end with "Failed to restore `<app>`: …" for each and "(restored: …)".
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
