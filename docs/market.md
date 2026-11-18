# Market

How apps get from the Market catalog onto a box, and what the Control Panel (CP) does with them afterwards. The app
format itself is in [app-manifest.md](app-manifest.md); the `${…}` variables are in
[app-environment.md](app-environment.md); who may open an app is in [app-admission.md](app-admission.md).

| Piece | Where |
|---|---|
| Catalog | repository `YE-AppMarket`: `catalog.yaml`, `apps/<id>/`, `bundles/<id>/` |
| Parser and validator | `control-panel/src/lib/market/app-format/` (`parseApp`, `parseSetup`, compile to the internal model) |
| Catalog reader, sources and consent | `catalog.ts`, `catalog-release.ts`, `source.ts`, `direct-apps.ts` (apps added by URL) |
| Install, update, uninstall | `engine.ts`, `updater.ts`, `uninstaller.ts`, `install-tracker.ts`, `instance-ownership.ts` |
| Setup files and connections | `setup-runner.ts`, `setup-context.ts`, `wire-runner.ts`, `bundle-installer.ts`, `src/lib/bridges/` |
| HTTP API | `control-panel/src/app/api/market/**`, `/api/apps/<id>/{update,control}`, `/api/suggestions` |
| CLI | `youeye app …` and `youeye market …` in `spine/internal/cmd/app.go`, `market.go` (they call the CP API) |

## Where the catalog comes from

The official Market is the `market` product of the box's channel (see [releases.md](releases.md)).

1. The CP asks Spine for the channel index (`GET /api/releases/index`). It never lists releases or calls a release API.
2. It downloads the `market` entry's `product-release.json` and refuses it unless its SHA-256 matches the index.
3. It downloads two assets of that release: `catalog-snapshot.json` (the path and SHA-256 of every catalog file) and
   `catalog.tar` (exactly those files). Both are checked against the release document, and every file in the tar
   against the snapshot. The tar may hold only regular files and directories.
4. The accepted release is kept in `/var/lib/youeye/market-releases/` (`official.json` plus
   `catalog-<sha256>.tar`, mode 0600) and checked again when the CP reads it. A channel that offers an older
   Market release is refused (no downgrade); the same release is kept as is.

The catalog is re-read when the in-memory copy is older than 5 minutes. If the refresh fails, the CP keeps the
accepted release (or `/var/lib/youeye/catalog-cache.json`) and shows the error on the source.

**What is in the catalog.** `catalog.yaml` (`youeye.catalog.v1`) holds only what cannot be discovered: categories,
curation (`spotlight`, `collections`) and `native: [ids]`. Everything else is found from the folders:

- `apps/<id>/youeye-app.yaml` (`youeye.app.v1`): a container app, with its `setup/*.yaml`, icon and screenshots.
- `bundles/<id>/bundle.yaml` (`youeye.bundle.v1`): a list of member apps and the connections between them.
- Native apps named in `native:` come from their own product release on the same channel (its `youeye-app.yaml`
  asset). The catalog never names a repository or branch for them.

**Publishing.** `Tools/release/app-release YE-AppMarket` runs `scripts/catalog-snapshot.mjs release` on the commit
and publishes release `catalog-v<X.Y.Z>-dev.N`; `Tools/release/promote` moves it through the channels. The snapshot
and tar carry no version, branch or host, so the same commit gives the same bytes. The catalog repository's own
tests (`npm test`) are structural only; the full check is the CP's validator (see Tests).

## Other sources and consent

**The rule** (since 0.6.10, `source.ts`). Wherever no source is named, the official Market is used; a custom source
is used only after the owner accepted it, and an app added by URL only with its own confirmation. An installed app
stays with the source it was installed from: nothing moves it to another source by itself.

**Custom sources.** The owner can add a Git repository as a custom Market source (Market → Manage sources,
`/market/sources`; stored in `/var/lib/youeye/market-sources.json`). It is read as raw files from a branch, so it
cannot list folders: it needs a `catalog.json` (`youeye.catalog-index.v1`) that names its app and bundle ids. A
`system` list in it is accepted and ignored, and so are `system/` files: no source supplies the core containers.

- **Acceptance.** A custom source carries `accepted_at`, which only the CP sets: when the source is added with the
  tick "I trust this source" (`acceptRisk: true`), or by the accept call for a source that already exists (one
  added before 0.6.10 has none). Changing a source's address or branch clears it.
- **Not accepted.** Its apps and bundles are still listed, marked `sourceNotAccepted` ("Not accepted"), but they are
  never installed, updated or switched to.
- **Turned off or missing.** A source that is turned off or no longer configured is never used. With the official
  Market turned off, an install that names no source is refused.
- **Listing.** Cards of apps that are not from the official Market show the source's name ("Added" for an app added
  by URL). When several sources have the same app id, the official one is listed first. A bundle id found in several
  sources is shown once, the official Market's first.

| Call | Does |
|---|---|
| `GET /api/market/source` | `{ sources }`: the official source and every custom one, in priority order, with `accepted_at` |
| `POST /api/market/source` | `{ repo_url, branch?, name?, id?, acceptRisk: true }` adds a custom source, accepted at once; without `acceptRisk: true` the answer is 400 `source-not-accepted` |
| `POST /api/market/source/accept` | `{ id }` accepts an existing custom source (404 when there is none) |
| `PATCH /api/market/source` | `{ active_sources: [...] }` turns sources on or off, renames, reorders and removes them. It cannot add a source or set `accepted_at`; a changed `repo_url` or `branch` clears it |

All four need an admin: a session (with the CSRF token for `POST` and `PATCH`) or the CLI token. On the box:
`youeye market source list` (id, name, address, branch, enabled, accepted) and `youeye market source accept <id>`.
Adding a source has no CLI command. `youeye market repo get|set` no longer exist.

- **Source ids.** `official` and `direct` (the prefix of apps added by URL) are reserved. Without an `id` the source
  gets the first `custom-N` (from 1) that no source has and no installed app records. A chosen id that an installed
  app records for another repository is refused (400).
- **Writes.** Every change to `market-sources.json` (owner edits and the refresh times the catalog fetch records)
  runs on one write chain per CP process, shared by the API routes and the background jobs, and reads the file
  inside it, so no write reverts another.

**Apps added by URL.** A single app can be added by its `youeye-app.yaml` URL; it is listed as "Added" with a
`direct:<hash>` source id and is its own source (see Installing). It needs `acceptUnverifiedPublisher: true`, and
`allowSetup: true` when it has setup files, on every install and switch; an update asks again when its setup files
changed.

**Refusals.** A refusal for lack of consent (`MarketSourceConsentError`) answers `{ error, code, setups? }`:

| `code` | When | HTTP |
|---|---|---|
| `source-unavailable` | the named source is turned off or not configured, or a `direct:` id where a Market source is needed | 400 (install, bundle, switch); 403 (update) |
| `source-not-accepted` | a custom source without `accepted_at` | 403 |
| `publisher-not-trusted` | an app added by URL without `acceptUnverifiedPublisher: true` | 403 (install, switch) |
| `setup-not-allowed` | an app added by URL with setup files, without `allowSetup: true`; `setups` lists them | 403 (install, switch); 400 (`install-url`) |
| `setup-changed` | an update of an app added by URL whose setup files changed, without `allowSetup: true` | 409 JSON with `setups`, or an SSE `failed` event with `code` and `setups` |
| `source-changed` | an update of an app whose source id now points at another repository than the app recorded (or, same repository, another branch when the app recorded one) | 403 JSON, or an SSE `failed` event with `code` |

On the SSE update routes a `source-not-accepted` or `source-unavailable` update ends with a `failed` event whose
message names the cause.

**The source changed.** An app records the repository of its source at install (and, for a git source, the
repository path and branch its manifest was read from). A source id can come to name another repository: a removed
source's id taken again, or a source's address or branch edited. The app follows the repository it recorded, never
just the id: its update is refused with `source-changed` (the message names both repositories), and the update check
offers nothing and stores `updateBlocked: { code: "source-changed", message }` on the installed-app record
(`/var/lib/youeye/state/installed-apps.json`). The official Market is never "changed". The remedy is an explicit
switch of the app to that source on its page (`PATCH /api/market/app/<id>/source`), which records the new repository.

**What can install, update or re-point an app, and how it is guarded**

| Path | Source it reads | Guard |
|---|---|---|
| Install: `POST /api/market/install`, `youeye app install <id> [--source <id>]` | the named `sourceId`, else the official Market | the rule above; source, catalog key and manifest fields are set by the CP, never taken from the client |
| Install by URL: `POST /api/market/install-url`, `youeye app install --url` | the URL | `acceptUnverifiedPublisher`, plus `allowSetup` when it has setup files |
| Add to the Market by URL: `POST /api/market/validate-url` `{ manifestUrl, addToMarket: true, allowSetup? }` | the URL | `allowSetup` when it has setup files; the install from the "Added" entry asks again |
| Bundle install: `POST /api/market/bundles/<id>/install[?source=<id>]` | the bundle's source, else the official Market | the rule above; every member installs from that source and is recorded with it |
| App update: `POST /api/apps/<id>/update`, `POST /api/market/update`, `POST /settings/api/apps/<id>/update` (all `updateMarketApp`) | the app's recorded source, else the official Market | the rule above; `source-changed` when the source id now names another repository; an app added by URL: `setup-changed` without `allowSetup` |
| Update check (every 6 hours, `youeye app check-updates`) | the app's recorded source, else the official Market | a refused source gives no offer; a changed repository gives no offer and `updateBlocked` (`source-changed`); it writes a source into an app only when it is the recorded one or the official one |
| Source switch: `PATCH /api/market/app/<id>/source` `{ sourceId, acceptUnverifiedPublisher?, allowSetup? }` | the named source | admin with CSRF token; the rule above. The source is resolved first; the record is then changed inside the app's lifecycle lock: 409 `operation_in_progress` when the app is busy (after a 30 s wait), 409 `recovery_required` when it has an unfinished update. Only the source identity changes (id, name, repository, and for a git source the manifest repository and branch): the installed copy and its digest stay until the next update |
| Restore, independent copy | none | a restore rebuilds the app from its backed-up frozen manifest; a copy reads no source |

## Core containers are not Market apps

Caddy, PostgreSQL and Pi-hole run images pinned by digest in the Control Panel
(`control-panel/src/lib/infrastructure/system-images.ts`). They change only with a System release and are never
read from any Market source, official or custom; first deployment does not need the Market for them. They are
updated from Settings → System (or Settings → Apps), with a maintenance acknowledgement, onto the pinned image
([control-panel.md](control-panel.md#updates)). The `system/*.yaml` files still in `YE-AppMarket` serve only boxes up
to 0.6.9, which read them from the released catalog; the next plan removes them.

## App icons (image proxy)

`GET /api/market/image` on the Control Panel (`control-panel/src/app/api/market/image/route.ts`) and its mirror on
the dashboard (`ui/src/app/api/market/image/route.ts`) serve app icons and screenshots. They are public (no
sign-in), so every answer is made inert in the box's origin:

- `?url=<https-url>` fetches from a fixed host list (`github.com`, `raw.githubusercontent.com`,
  `avatars.githubusercontent.com`, `immich.app`, `usememos.com`, `i.ibb.co`, `jellyfin.org`, and their
  subdomains; no `cdn.jsdelivr.net`), following at most five redirects within that list. The answer's type is one of
  PNG, JPEG, WebP, GIF or SVG, taken from the upstream type, or from the file extension when the upstream type is
  missing or generic (`text/plain`, `application/octet-stream`, `binary/octet-stream`). Anything else becomes a
  placeholder icon on the Control Panel and a 502 on the dashboard.
- The upstream body is capped at 5 MiB: an announced `Content-Length` above it is refused without reading, and a
  longer stream is cut at the cap. A larger image also becomes the placeholder on the Control Panel and a 502
  ("Upstream image is larger than 5 MiB") on the dashboard.
- `?catalog=<path>` (Control Panel only) serves an image file from the accepted official `catalog.tar`.
- Every answer carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `X-Content-Type-Options: nosniff`, so an SVG opened directly cannot run script. On the Control Panel the proxy
  (`control-panel/src/proxy.ts`) sets this policy for `/api/market/image`, because a policy set in the proxy
  replaces a route's own; the route sets the same headers itself.

## Installing an app

Every install is admin-only and CSRF-checked and streams progress as server-sent events:

- **`POST /api/market/install`** with `{ appId }`. Optional: `sourceId`, `subdomain`, `selectedIntegrations`
  (`["youeye-id"]` turns YouEye ID sign-in on for an app with `setup/sso.yaml`; on by default), `aiSettings`,
  `allowInternet`, `publicAccess`, `adoptRetainedData`, and for an "Added" (`direct:`) app
  `acceptUnverifiedPublisher` and `allowSetup`. Without `sourceId` the app comes from the official Market; a named
  custom source must be accepted (see [Other sources and consent](#other-sources-and-consent)). The CP sets the
  record's source, catalog key and manifest fields itself, and fills in the subdomain (the manifest's `subdomain:`,
  else the id). The domain is always the box's own; a client value is ignored. An install is refused (HTTP 423) while Health has a critical issue about that app (or about the box,
  such as the app-network or install-state issues); another app's critical issue doesn't block it. Each critical
  issue names its cause and the command or Fix for it (`youeye doctor` lists them).
- **A failed install** whose rollback couldn't finish is cleaned up by the reconciler (back-off between tries), or
  by `youeye app remove <id>`. `youeye app remove <id> --force` is for a broken or unfinished install only (still
  installing, cleanup pending, or a recorded container gone; an intact app is refused with 409): it skips the
  data-ownership check, removes what carries the app's id and installation id, and never deletes a shared folder. `youeye app recover <id>` finishes an interrupted app update.
- **`youeye app install <id> [--source <id>] [--public-access[=false]]`** sends `{ appId }` (plus `sourceId` with
  `--source`, and `publicAccess` when that flag is given) to the same endpoint. Without `--source` the app comes
  from the official Market; the ids are in `youeye market source list`. The CLI has no YouEye ID user, so AI
  Settings are off for CLI installs.
- **`youeye app install --url <https-url> --i-trust-this-publisher [--allow-setup]`** calls
  `POST /api/market/install-url`. The manifest and its setup files are fetched from a public HTTPS server only (rules
  in [app-manifest.md](app-manifest.md)). Without `--i-trust-this-publisher` the CLI refuses (the API answers 400); an
  app with setup files also needs `--allow-setup` (`allowSetup` in the API), otherwise the CP answers 400
  `setup-not-allowed` and lists them. `--source` cannot be combined with `--url`. A URL install that fails after the
  base install is uninstalled again with delete-data.
- **By URL in the Market page:** "Install from URL" calls `POST /api/market/validate-url` with `manifestUrl` and `addToMarket` (and
  `allowSetup` when the app has setup files), which adds the app as an "Added" entry; its install dialog then shows
  one confirmation listing the host, the images and the setup files. Its tick sends both
  `acceptUnverifiedPublisher` and `allowSetup` to `POST /api/market/install`.

`youeye app credentials <id>` reads `GET /api/market/credentials?app=<id>` (administrators only) and prints each
default account the manifest declares (`credentials:`).

**AI Settings.** For an app with `ai:` the install screen offers "Use AI Settings" (on by default when a YouEye ID
user installs). The installer picks one of their Pointer model groups; the CP creates a managed Pointer
installation and key for the app (`${ai.*}`). Stopping the app disables that key, starting it enables it again,
and uninstall archives the Pointer installation and revokes the key (`src/lib/apps/lifecycle.ts`,
`uninstaller.ts`). With AI Settings off, every `${ai.*}` is empty and the app is configured by hand.

The install then works in this order (step 1 in the route, the rest in `installApp` in `engine.ts`). From step 5
on, a failure rolls the install back (`rollbackInstall`).

1. **Parse and compile.** The manifest and setup files are parsed strictly and compiled to the internal model.
   Unknown fields or variables are errors. `requires.youeye` is checked first; an older platform is refused.
2. **Preflight.** Container names, routes, volumes and storage are checked. A same-name container of anything else
   is refused, never replaced. Retained data from an earlier keep-data uninstall blocks the install unless the
   app's owner adopts it (`adoptRetainedData: true`).
3. **Admission record.** The app's access policy is created (or the existing one reused). It holds the
   **installation id** (a UUID) and the owner: the admin who installs it, or the box owner for CLI installs.
4. **Native packages** (native apps only) are staged from the app's product release and checked against it.
5. **Network.** The app gets its own Incus bridge `yeapp<N>` with a /27 subnet, NAT on for the install, and an
   egress ACL. Custom volumes are created. `install.json` is written now as the recovery map.
6. **Secrets** are generated and stored in `/var/lib/youeye/app-<id>/secrets/<name>` (directory 0700, files 0600).
   Existing secrets are kept, so a reinstall reuses them.
7. **Pointer key** (apps with `ai:` and AI Settings on), then the **database**: with `database: postgres` the CP
   creates the database and role in the shared YouEye PostgreSQL.
8. **YouEye ID client** (apps with `sso:` and sign-in on): OAuth client `youeye-app-<id>`, redirect URIs from
   `sso.callback` and `sso.extra_callbacks`, scopes `openid profile email groups` (plus the `role_claim` name).
9. **Containers.** Sidecars first, `main` last, because main's health check usually needs its sidecars. Each
   instance is created with the tags `user.youeye.app_id` and `user.youeye.installation_id`, gets its env and
   `files:`, starts, and must pass its health check (an HTTP GET answering 2xx, 3xx, 401 or 403 within the
   manifest's timeout; `market/health.ts`). Container names are `app-<id>` or `app-<id>-<container>`.
10. **Network wiring.** Incus proxy devices let the app reach the system services it needs: the UI gateway, and
    PostgreSQL, YouEye ID or Pointer inference when it uses them. Caddy joins the app bridge.
11. **Setup files.** The OCI containers of an SSO app get the box's Caddy root CA. Then `setup/install.yaml` runs,
    then `setup/sso.yaml` when sign-in is on (see [app-manifest.md](app-manifest.md) for the step rules).
12. **Route.** Caddy routes `https://<subdomain>.<domain>` to the main container's IP on the app bridge, behind
    YouEye ID's forward-auth check.
13. **Records.** `install.json` (`youeye.install.v1`: installation id, manifest digest, approved shared folders),
    the installed-apps record, and the dashboard registration, which holds the frozen copy of the manifest and
    setup files. From then on the installed app is read from these, not from the live catalog.
14. **Suggestions** for new connections are made (see Connections).
15. NAT is turned off unless the app has `internet: true` (or the install set `allowInternet`), the network
    lease becomes active and the install is committed.
16. **Credential and access.** The app's gateway credential is activated (for a native app, after a probe from
    inside the container), and public access is turned on when the install asked for it (see below).
17. **Connections** approved earlier while this app was not installed are activated and wired. This needs the new
    app's network lease to be active; a failure is logged and does not fail or roll back the install.

Only one operation per app runs at a time. Progress is also kept on disk, so a browser can reconnect with
`GET /api/market/install-status?app=<id>`.

## Sign-in (YouEye ID) and admins

An app signs in with YouEye ID in one of three ways:

- **Env:** `sso.env` passes `${sso.client_id}`, `${sso.discovery_url}` and so on. Sign-in is always on.
- **Setup file:** `setup/sso.yaml` configures the app through its API, CLI or a config file. Sign-in is a choice
  at install (on by default) and can be changed later: Settings → Apps → the app, or
  `GET`/`PUT /api/market/app/<id>/sign-in`. Turning it on creates the client and runs `steps:`; off runs `remove:`
  and deletes the client.
- **None:** an app without `sso:` has its own accounts or none. Like every app, it is reached only through YouEye
  ID's forward-auth check.

Admins: YouEye ID admins are in group `admin`. The ID token and userinfo carry `groups` and `is_admin`, and
`${sso.admin_group}` (default `admin`) tells the app which group marks its admins. An app that needs its own claim
uses `sso.role_claim` instead: when the app requests the claim name as a scope, YouEye ID sends `admin_value` to its
admins and `default_value` to everyone else, in both the ID token and userinfo.

## Who may open an app

Every new app starts **owner-only**: only the admission owner is admitted, and being a YouEye admin alone does not
admit anyone. An admin can change the policy to all users, selected users or selected groups (in the app's Market
settings, or `GET`/`PUT /api/market/apps/<id>/access`). YouEye ID enforces it at sign-in, token use and Caddy
forward-auth; see [app-admission.md](app-admission.md).

**Public access.** An app whose manifest sets `public_access: true` protects itself (its own password, PINs or
accounts). Installed from the official catalog, it gets public access on by default (shown pre-selected; the
installer can turn it off; `--public-access=false` on the CLI). Then Caddy's forward-auth check lets every request
through to the app (`src/lib/identity/forward-auth.ts`). Added sources and URL installs never take this default
from the manifest. It is applied after the app is installed and healthy; if that fails, the app stays
household-only. An admin can change it later in the app's access settings.

The first time a user signs in to an app, YouEye ID shows a consent screen with the requested scopes and any
runtime permissions. Approval is stored per user and client and asked again only when the app requests new scopes or
permissions.

## Connections and bundles

`connects:` lists what an app can connect to, by app id or by `type` (matched against other apps' `provides:`).

- **Suggestions.** After an install, the CP suggests connections both ways: from the new app to installed apps it
  wants, and from installed apps that want the new one. A suggestion whose target is not installed waits.
  `GET /api/suggestions` lists them; `POST /api/suggestions` with `{ action: approve | dismiss | remove, id }` acts.
  From the box: `youeye app suggestions` lists them and `youeye app connect <from> <to>` approves one.
  Uninstalling an app drops its suggestions and marks suggestions pointing at it as waiting again.
- **Approval** creates a connection record and activates it: the consumer gets a second network interface on the
  peer's app bridge, or, for a `proxy:` connection, a scoped grant through the UI gateway. That interface's ACL
  allows traffic only to and from the peer's main container address (so the peer can call the consumer back on
  it); anything else on the peer's network, other connected apps included, is rejected both ways. Every app
  container address the platform sends to or opens an ACL for (setup steps, connection ACLs, events, back-channel
  logout, Caddy routes) comes from the host, never from the container: the NIC's DHCP lease on its bridge, matched
  by MAC (`security.ipv4_filtering` lets the NIC use only that address), and it must be a host address on that app's
  network, not its gateway. A connection to a stopped peer uses the peer's reserved address. Incus keeps that
  address while the peer's NIC exists; when the peer is recreated, its connections are pointed at the new address
  when it starts and on every reconcile pass (and when the connection is activated again).
- **Connect setup files.** Every time a connection is activated (suggestion, bundle, the target of a waiting bundle
  connection installed later, or `/api/bridges`), the consumer's `connects[].setup` file (`for: connect:<app>`) runs
  with `${peer.*}` and `${self.*}` values. Its `target: peer` steps call the peer's main container. A failure is
  logged and does not undo the approval. Deactivating or deleting a connection first runs the file's `remove:`
  steps; a failure there is logged as well. Uninstalling an app also deletes its connections (before its
  containers), but uninstall stops the app's containers first, so only `remove:` steps that run in the other app
  (not in the uninstalled one, and not calling it as the peer) can still succeed.
- **Bundles.** `POST /api/market/bundles/<id>/install[?source=<id>]` installs the missing members in the listed
  order, then approves and wires the bundle's `connections`. The bundle comes from the named source, else the
  official Market; a custom source must be accepted. Every member installs from the bundle's source and is recorded
  with it, household-only (no public access). It is safe to run again. A connection whose member is not
  installed (its install failed) is reported as pending and not recorded; running the bundle install again
  wires it.

`${peer.api_key}` and `${self.api_key}` are each app's secret named by its `api_key:`, read from its own secret
store. Both manifests come from the frozen installed copies.

## Updates

`GET /api/market/updates` lists apps with a newer version.
`youeye app update <id> [-y] [--allow-setup]` calls `POST /api/apps/<id>/update`; `--all` reads
`GET /api/market/updates` and calls the same route for each app with an update (without `--allow-setup`, which is
only for one named app). `youeye app check-updates` calls `POST /api/apps/check-updates`. `POST /api/market/update`
(SSE, used by Settings → Apps) and `POST /settings/api/apps/<id>/update` (JSON for a Market app, used by the
dashboard's Apps panel) end in the same `updateMarketApp`.

- The new manifest comes from the app's recorded source, else the official Market (never another source): the same
  Market source, which must still be on and accepted; the URL of an Added app; or the native app's product release
  on the box's channel. The update check asks the same source and never re-points an app (see
  [Other sources and consent](#other-sources-and-consent)). Apps added by URL get update offers too.
- **An app whose source id now names another repository** (or branch) than it recorded is not updated: the answer is
  403 `source-changed` (JSON) or an SSE `failed` event with `code: "source-changed"`, and the update check offers
  nothing and stores `updateBlocked { code, message }` on the installed-app record. Only an explicit switch on the
  app's page moves it to that source.
- **An app added by URL whose setup files changed** is not updated without `allowSetup: true` (`--allow-setup`; the
  update panel says "Setup steps changed" and asks). Nothing is changed before that: the answer is 409
  `setup-changed` (JSON) or an SSE `failed` event with `code: "setup-changed"`, both listing `setups`. The Added
  entry's stored manifest is replaced only after a successful update.
- Only a newer `version` is installed (`src/lib/version.ts`): a new image digest under the same version is never
  offered. An update that needs a newer YouEye is refused and waits. Checks run 45 s after the CP starts and then
  every 6 hours; nothing is applied automatically.
- Before the change the update takes a checkpoint: scoped metadata, a stopped runtime copy of each container,
  Incus volume snapshots and a logical dump of the app's PostgreSQL database. OCI images are pinned to the fetched
  digest, containers are stopped, rebuilt (env and `files:` written again) and health-checked. A failure restores
  the checkpoint. Database migrations are the app's own, on first start.
- Refused: a changed container set (sidecars added, removed or renamed), changed storage (a `data:` path added or
  removed) and a changed database mode or name (`update-inventory.ts`). An update also fails when a new env value
  needs something the install never created: a new `${secret.<name>}`, or a new `${database|sso|identity|youeye|ai}.*`
  mapping that resolves empty (`update-configuration.ts`).
- Setup files do not run. Secrets, volumes, the YouEye ID client and the Pointer key are kept. A database
  sidecar keeps its running PostgreSQL (it is not rebuilt). The new manifest becomes the frozen copy, so changed
  setup files run later, from that copy: when sign-in is turned on or off, after an address change, and when a
  connection is activated.
- A native app is updated by **build**: the channel's release must be a newer build (`X.Y.Z-dev.N`); the same
  build under a promoted name (`-alpha.N`, `-beta.N`, `X.Y.Z`) only updates the release record. Its new
  `standalone.tar` replaces `/opt/app` (see [native-apps.md](native-apps.md)).

## Start, stop and restart

`youeye app start|stop|restart <id>` and `POST /api/apps/<id>/control` with `{ action }` act on all of the app's own
containers and record the wanted state, so a stopped app stays stopped. Shared system services are not touched.

## Uninstall

`POST /api/market/uninstall` with `{ appId, keepData }`. **The API keeps data by default; the CLI
`youeye app remove <id>` deletes it unless `--keep-data` is given.**

The uninstaller decides only from `install.json`. It stops the app's containers, deletes its connections (attempting
connect files' `remove:` steps, see above), then deletes containers by their recorded names and only when they carry this installation's tag, routes
by exact host name, the OAuth client, DNS entries,
the CA directory, the dashboard registration and, last, the app network. Nothing is matched by name prefix.

- **Delete data:** also removes the volumes, the secrets and `/var/lib/youeye/app-<id>/`, and drops the shared
  database and role, but only if this installation created them.
- **Keep data:** volumes, database and secrets stay; the admission record becomes `retained`. A later install
  can adopt the data only through the app's active owner (`adoptRetainedData`).

Left behind on purpose: the app's revoked gateway credential in `/var/lib/youeye/state/app-service-credentials/<id>/`
(no secret; it keeps the revision the UI expects, so a reinstall continues from it) and the operation record in
`/var/lib/youeye/networks/operations/<id>.json` (pruned 24 hours after the operation ends).

If any step fails, `install.json` stays with `cleanupPending: true`, the network lease is kept, and the next uninstall
or cleanup retries.

## When something fails

- The full error chain is logged once to the CP journal
  (`incus exec youeye-control -- journalctl -u youeye-control`; `youeye logs control` shows the last 100 lines) as
  `[Market] Install of <id> failed: …`, with credentials, bearer tokens, app tokens and URL queries redacted.
- The user sees only a fixed message: the image download failed (network), the image is not available, another
  operation is running, cancelled, an app-network preflight message, or a generic "Installation failed" pointing to
  Health. Progress events are redacted the same way before they are streamed or stored.
- A failed install also sends a dashboard notification. The final error says whether the rollback was clean or left
  resources marked `cleanup_pending`.
- **Image fetch retries.** Creating or rebuilding an OCI container retries a failed image fetch up to five times
  (after 5, 15, 30, 60 and 60 s) when the error looks like a network or registry hiccup (DNS timeout, connection reset,
  429, 5xx). A permanent answer (unknown manifest, denied, not found, digest mismatch) fails at once.

## Tests

- **CP unit tests** in `control-panel/tests/`, run with `npm test` in `control-panel/`. Most relevant:
  `app-format.test.ts` (parser, validator, variables, digest, frozen copies), `setup-runner.test.ts` (step safety
  rules), `catalog-release.spec.ts` (channel catalog), `market-system-apps.spec.ts` (the pinned core images; a
  source that lists `system` changes nothing; validates the whole `YE-AppMarket` checkout with the CP parser, set
  `MARKET_ROOT` if it is not next to `YouEye`), `market-image-proxy.spec.ts` (the image proxy's headers and types),
  `market-source-consent.spec.ts` (source acceptance, the list edit, official by default, bundles, the source
  switch, the update check, URL apps' changed setup files),
  `identity-role-claim.test.ts`, `install-tracker-durable.spec.ts`, `image-fetch-retry.spec.ts` and the
  `market-*.spec.ts` files.
- **Sign-in suite** `tests/market-sso/` (Playwright): signs in to each installed app once as a YouEye admin and once
  as a standard user and checks the app's own view of who is an admin. See its `README.md` for setup and saved
  sessions.
