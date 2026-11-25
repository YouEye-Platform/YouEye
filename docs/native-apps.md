# Native apps

Native apps are Next.js servers that run in an Incus system container and use the platform directly (dashboard
widgets, notifications, the UI gateway). Since 0.6.20 they are ordinary Market apps (YE-142): listed, versioned and
updated through a market like container apps, and anyone can make one from YouEye-Canvas and offer it in any market.
The six below are YouEye's reference apps. Container apps from the Market are described in
[market.md](market.md); the manifest format both use is in [app-manifest.md](app-manifest.md).

| App | Repository | What it does |
|---|---|---|
| Notes | `YE-App-Notes` | Markdown notes with folders, pinning, search and public sharing |
| Wiki | `YE-App-Wiki` | Wikipedia reader; pages are fetched through the UI gateway |
| Search | `YE-App-Search` | Web search through a connected search engine app (SearXNG or any `search-engine`) |
| Translate | `YE-App-Translate` | Translation (MyMemory) |
| Weather | `YE-App-Weather` | Forecasts for saved places (Open-Meteo) |
| Cinema | `YE-App-Cinema` | Movies and TV from TMDB, watchlists, reviews; can connect to Jellyfin |

The template for new ones is **YouEye-Canvas**. A market lists a native app as an app folder like any other
(`apps/<id>/youeye-app.yaml`, index entry `kind: native`); its manifest pins the app's package, the `standalone.tar`
of a release of the app's own repository, by URL, SHA-256 and size (`source.package`, see Releases below).

| | Container app | Native app |
|---|---|---|
| Source | `YE-AppMarket/apps/<id>/` | its own repository; its market folder pins a release |
| Runs as | upstream OCI images, pinned by digest | `standalone.tar` in a Debian 12 system container, Node 22 or 24 |
| Released as | published with its market (static files, [market-format.md](market-format.md)) | its own release (`standalone.tar` + `youeye-app.yaml`), pinned in a market by `source.package` |
| Platform access | doorways (YouEye ID, PostgreSQL, Pointer) | also the UI gateway with an app token |
| Dashboard | a tile | widgets, timeline and info cards, notifications, a settings panel |

## The manifest

`youeye-app.yaml` at the repository root, format `youeye.app.v1`, with `source:` instead of `image:` and no
sidecars. A trimmed version of Notes' manifest:

```yaml
schema: youeye.app.v1
id: notes
version: 0.0.0                  # the build writes the release version into the released copy
name: Notes
source: {node: '24'}            # 22 | 24
port: 3000
health: /api/health
database:
  postgres: {name: ye_notes, user: ye_notes}
env:
  DATABASE_URL: ${database.url}
  JWT_SECRET: ${secret.jwt_secret}
  IDENTITY_URL: ${identity.external_url}
  IDENTITY_INTERNAL_URL: ${identity.internal_url}
  YOUEYE_GATEWAY: ${youeye.gateway_url}     # these three names are required exactly
  YOUEYE_APP_TOKEN: ${youeye.app_token}
  YOUEYE_APP_ID: ${app.id}
secrets:
  jwt_secret: {kind: key, length: 64}
sso:
  callback: /api/auth/callback
  backchannel_logout: /api/auth/backchannel-logout
  env: {IDENTITY_CLIENT_ID: ${sso.client_id}, IDENTITY_CLIENT_SECRET: ${sso.client_secret}}
capabilities: {widgets: true, settings_panel: true}
surfaces:
  - {id: recent-notes, kind: widget, placement: dashboard, name: Recent Notes,
     embed: /embed/widget/recent-notes, size: {default: [25, 28], min: [18, 20], max: [45, 50]}}
```

Other native-app fields, all in [app-manifest.md](app-manifest.md):
- `surfaces:` kinds `widget`, `info-card`, `timeline-card`, `notification`, `settings-panel`, each an `embed` page
  on the app; placements `dashboard`, `timeline`, `notification-center`, `app-settings`, `app-detail`. The dashboard
  embeds a widget or notification surface at its `embed` path on the app's own address, which the dashboard's server
  builds (`app_url` in `GET /api/v1/apps/surfaces` and in each `surface` of `GET /api/v1/notifications`):
  `https://<the app's subdomain>.<the host the dashboard is on>` (`ui/src/lib/surfaces/app-url.ts`, YE-151). Without
  one (an app with no subdomain, the dashboard opened by IP address) a notification shows its standard row.
- `capabilities:` `widgets`, `settings_panel`, `notifications` (`true` | `push`), `info_cards`, `events`.
- `proxy:` outside HTTPS hosts the app may call through the UI gateway (Wiki: `*.wikipedia.org`; Weather:
  `geocoding-api.open-meteo.com`).
- `connects:` other apps, optionally through the gateway (`proxy: { paths, methods }`).
- `link_handlers:` link types the app opens (Notes: `note` at `/n`).
- `data_ownership: { per_user: identity_uuid }` marks that the app keeps data per YouEye ID user.

When a native app maps `${youeye.app_token}`, the CP requires `YOUEYE_APP_TOKEN`, `YOUEYE_APP_ID` and
`YOUEYE_GATEWAY` to map exactly as above (`src/lib/apps/service-credential-probe.ts`); otherwise the install
fails.

## On the box

- **Container.** One Incus system container `app-<id>` from `images:debian/12`, Node `<22|24>.x` from NodeSource,
  the app in `/opt/app` (`src/lib/infrastructure/lxd-deployer.ts`). A systemd unit named after the container runs
  `/usr/bin/node /opt/app/server.js` with `EnvironmentFile=-/etc/app-<id>.env`; the CP writes that file from the
  manifest's env and restarts the unit.
- **Network.** Like every app it has its own `yeapp<N>` network. At the network's gateway, Incus proxy devices
  ("doorways") lead to the UI (`:3001`, always), and to YouEye ID (`:3002`) and PostgreSQL (`:5432`) when the app
  uses them. The app has no host port: it is reached only through Caddy and the YouEye gate (`port:` is where Caddy
  and the health checks reach it on its network). Releases before 0.6.20 added a `port<N>` device listening on
  `tcp:0.0.0.0:<N>` of the box when the port was free; the CP removes that exact device from app instances at each
  start, under the app's lifecycle lock (an app busy with an operation keeps it until the next start;
  `removeAppHostPorts` in `lib/infrastructure/security-posture.ts`, YE-189).
- **Credential probe.** After install the CP runs a small Node script inside the container that calls
  `$YOUEYE_GATEWAY/credential-probe` with the app's token. If that fails, the app is left stopped with its
  credential pending until the credentials are reconciled in the Market.
- **Platform events.** An app that lists event names in `capabilities.events` gets each matching event as
  `POST http://<main container>:<port>/api/youeye/events` with `X-YouEye-Event: <name>` (best effort, 5 s timeout,
  no token; `src/lib/events/emitter.ts`). Names: `app.installed`, `app.uninstalled`, `app.updated`,
  `user.created`, `user.login`, `settings.changed`, `backup.completed`, `backup.failed`,
  `system.health.changed`.

## Talking to the platform

`YOUEYE_GATEWAY` is `http://<gateway>:3001/api/apps/v1`; the doorway at `:3001` leads to the UI container's port
3000. Calls are made **server-side only** and carry:

| Header | Value |
|---|---|
| `Authorization` | `Bearer $YOUEYE_APP_TOKEN` |
| `X-YouEye-App` | `$YOUEYE_APP_ID` (must match the token) |
| `X-YouEye-User` | the acting user's YouEye ID UUID, when the call acts for a user |

Canvas builds these in `src/lib/api/service-headers.ts` and refuses to run in the browser. The UI checks the
token by its SHA-256 against the app's registered credential (`ui/src/lib/auth/app-bearer.ts`), and for user
calls also checks that the user is admitted to the app (`ui/src/lib/auth/service-request.ts`).

Gateway routes (`ui/src/app/api/apps/v1/`):

| Route | What it does |
|---|---|
| `GET platform` | `version`, `domain`, `locale`, `timezone`, `site_name`, `container_domain` |
| `GET credential-probe` | `{ ok, appId }` when the token is valid (used by the CP's probe) |
| `* internet?url=<https-url>` | calls an outside host declared in the app's `proxy:`. Needs `X-YouEye-User` and the user's grant for that host; the host must resolve to public addresses only; redirects must stay on the same declared host |
| `* proxy/<targetAppId>/<path>` | calls a connected app. Needs `X-YouEye-User`, an approved active connection, the user admitted to the target app and the user's `connection:<target>` grant; method and path must match the connection's `proxy:` rule |

The per-user grants (`internet:<host>`, `connection:<app>`) are asked for when the user first opens the app
(`ui/src/app/api/v1/apps/[appId]/launch-requirements`); every `proxy:` host is asked for. A `proxy:` entry has no
`scope` (the server-wide `scope: service` hosts were never asked for nor allowed, and were removed in 0.6.15).

The same token also works on these UI routes under `/api/v1/` (Canvas derives the base from `YOUEYE_GATEWAY`):
`header/config`, `notifications`, `apps/<id>/user-settings`, `themes/active`, `timeline`, `timeline/collection`,
`permissions/check`, `permissions/request`, `my-connections`, `apps/surfaces`, `apps/<id>/launch-requirements`.
Canvas wraps them in `src/lib/api/index.ts` and `src/lib/connections/`.

There is no AI route on the gateway; an app that wants Pointer declares `ai:` like a Market app.

## Sign-in

A native app is a YouEye ID OAuth client like any Market app (client `youeye-app-<id>`), so app admission applies
([app-admission.md](app-admission.md)). In Canvas (`src/lib/auth/`):

- The authorization code flow uses `IDENTITY_URL` in the browser and `IDENTITY_INTERNAL_URL` for the token and
  userinfo calls, with scope `openid profile email groups`; the callback is `/api/auth/callback`.
- The session is a JWT cookie `ye-<id>-session`, signed with `JWT_SECRET` (at least 32 characters), valid for
  up to 30 days.
- Every private request re-checks the session at `<identity>/identity/session/check` with the client credentials,
  the expected subject and session ids, and `X-YouEye-Session-Issued-At` (the JWT's `iat`). A session issued
  before a revocation is refused; the user signs in again.
- **Admins are members of the exact group `admin`** (`src/lib/auth/admin.ts`). Never match a substring
  (`includes("admin")` also matches `sysadmins-readonly`).

## Widgets and the dashboard

- **Registration.** At the end of an install the CP registers the app with the UI:
  `POST http://<youeye-ui>:3000/api/v1/apps/register` with the `X-UI-Bridge-Token` from
  `/etc/youeye/ui-bridge-token`. The body holds the id, name, subdomain, icon, sign-in entry URL, link handlers and
  the compiled manifest (with its frozen source). The dashboard reads surfaces from it through
  `GET /api/v1/apps/surfaces`.
- **Framing.** Every surface is an iframe of `https://<subdomain>.<domain><embed>`, rendered by
  `ui/src/components/embeds/unified-embed.tsx` (sandbox `allow-scripts allow-same-origin allow-forms`, 5 s load
  timeout).
- **Protocol.** The embed page posts to its parent: `{type: "youeye:ready"}` once it paints,
  `{type: "youeye:resize", height}` when its height changes, and `{type: "youeye:action", action, data?}`. The UI
  accepts messages only from that iframe and from the app's own origin. Canvas has the helpers in
  `src/lib/embed/` and working examples of all five kinds under `src/app/embed/`.
- Embed routes must stay public in the app's middleware (Canvas: `publicRoutes: ["/embed/"]`), because the
  dashboard frames them.

## Building and releasing

In an app repository (Node 24.22.0 from `.node-version`, pnpm 10.6.2):

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build        # next build with output: "standalone"
```

- `VERSION` holds the release line `X.Y.Z`. Each build is released as `X.Y.Z-dev.N`; the tools pass that name as
  `YOUEYE_VERSION`, and the build only checks it against `VERSION` and unsets it (Plan 12). What the app bakes
  and serves (`/api/manifest`, `/api/health`) is the line (`YOUEYE_LINE`) and the git tree (`YOUEYE_SOURCE_TREE`,
  from the environment or `git rev-parse HEAD^{tree}`); `/api/health` also returns `source_tree`.
  `package.json` and the source manifest keep `0.0.0`.
- The build entrypoint is `.youeye/build/app` (with `lib.sh` and `manifest.json`). It installs offline from a
  shared pnpm store, runs `pnpm run build`, finds the single `server.js` under `.next/standalone`, adds
  `LICENSE`, `TRADEMARK.md` and `THIRD_PARTY_NOTICES.txt`, and runs `scripts/write-release-manifest.mjs`. That
  script writes `release-manifest.json` (`version`: the line, `source_tree`) into the tree and the release copy of
  `youeye-app.yaml` with `version: <line>`. No released file names a build. The tree is packed as a reproducible `standalone.tar` (sorted, fixed owner and mtime).
- A build is published as release `v<X.Y.Z>-dev.N` of the app's repository, with `product-release.json`,
  `standalone.tar` and `youeye-app.yaml`; promotion names the same build `-alpha.N`, `-beta.N`, then `X.Y.Z` and copies
  it to GitHub `YouEye-Platform/<Name>` for stable. See [releases.md](releases.md) and [development.md](development.md).
- **A release reaches boxes through a market.** Its market folder (`YE-AppMarket` `apps/<id>/youeye-app.yaml`) is the
  released `youeye-app.yaml` with the release's version, `requires: {youeye: ">=0.6.20"}` and `source.package`:

  ```yaml
  version: 0.6.4
  requires: {youeye: '>=0.6.20'}
  source:
    node: '24'
    package:
      url: https://github.com/YouEye-Platform/Notes/releases/download/v0.6.4/standalone.tar
      sha256: a32e8740335410066a17564685996d68b2989c82544591af6ec73d1cc6e96cfd
      size: 199936000
  ```

  `Tools/market/native-pin <id> <tag> [--host github|forgejo] [--write <YE-AppMarket>]` writes these lines from the
  release's `product-release.json`. The `/` lane names stable releases (GitHub); the `/dev/` lane may name a dev build
  (Forgejo) being tried. Before 0.6.20 native apps came from the box's channel index instead; those index entries are
  frozen for older boxes and go once 0.6.20 is on stable.

What the CP checks when it installs or updates a native app (`src/lib/market/native-artifact.ts`):
1. The market's manifest passes the strict parser read as a market's (`source.package` is required) and its index
   entry says `kind: native`; `requires.youeye` is checked as for any app.
2. The package is downloaded from `source.package.url` by the release-download rules (HTTPS only, redirects checked,
   403/429 back-off), never more than `size` bytes, and must have exactly that size and SHA-256. Any market, official
   or custom, may name any HTTPS host: the pin is what is trusted.
3. `standalone.tar` may be at most 1 GiB (`MAX_ARTIFACT_BYTES`, also the manifest's limit) and 2 GiB unpacked, with at
   most 100,000 entries, no hard links or special files, symbolic links only inside the package, and a `server.js`.
   It is hashed again right before it is deployed. The install record keeps its SHA-256 and size
   (`nativeArtifacts`, `verification: manifest`).

The install screen of a native app from a market other than the official one lists what it gets beyond a container
app: a key to the app API (the UI gateway token), its dashboard surfaces, notifications and its `proxy:` hosts.

Updates work as for every Market app ([market.md](market.md)): the market's version is an update when it is newer
(`isNewer`); an older version is never offered. An update stops the app, replaces `/opt/app` with the new package,
writes the env again, starts it and waits for its health check; a failure restores the checkpoint.

**The same package is decided by its manifest, not its version name** (YE-139's rule, by package; YE-194). When
`source.package.sha256` equals the installed `standalone.tar`:
- the same manifest (the record's `manifestDigest` equals the market's; the digest leaves `listing:` out, so store text
  alone never counts) is no update: Settings, the Market, the dashboard and `youeye app check-updates`/`info` offer
  nothing and `youeye app update` answers "already up to date";
- another manifest that configures the app the same way (`runtimeContract`: the same containers, env, ports, surfaces,
  sign-in and the rest; a new version name or `requires` does not count) is taken by the update check itself, metadata
  only (`adoptNativeMarketManifest`, below): the record and the dashboard's frozen copy name the new manifest and
  version, nothing is downloaded or restarted. `youeye app update` does the same and says so;
- another manifest that configures the app differently is offered as an update, and `youeye app update` applies it as
  an ordinary update of the same package (the app restarts with the new configuration).

Two such manifests wait (YE-212), so the record never names what the box cannot honour; the app keeps running on its
record meanwhile:
- one whose `requires.youeye` this box does not meet is neither taken nor offered (the ordinary update refuses it the
  same way). Usually the market's index already says so and the app is held back like any app (`youeye app update`:
  it needs a newer YouEye); the adoption checks the manifest itself too, in case it asks more than the index, and
  while Spine does not say the box's version. It is taken by the first update check after the box's version meets
  it: the pass remembers each refusal with the version it saw;
- one whose version name is lower than a Market record's is never taken or offered, as for any app; `youeye app
  update` answers "already up to date". A channel record (below) names a channel release, another scheme, so its move
  to the market is not ordered by version names.

When the adoption itself refuses, the log says why: `[Market] <id> keeps its recorded manifest for now: …`.

The update check compares first and locks only on a change (YE-210, `native-adoption.ts`). It reads each native app's
record and its market's manifest and compares their digests without any lock. Only an app whose manifest changed (and
was not already tried for that record, manifest and YouEye version) takes the update exclusion and the app's
lifecycle and network locks; the comparison is made again inside them before anything is written. An app that is up
to date never waits behind a user's operation and never counts as an operation: the reconcile queue is not re-run,
and the default-route guard (YE-198) does not see it as busy.

**Apps installed before 0.6.20** have a channel record (`manifestPath: youeye-app.yaml`, the release repository and
tag, a product release receipt). The update check (also 45 s after every Control Panel start) and `youeye app update`
move such an app to its market when the market pins the very package it runs and configures the same runtime: one
metadata-only transaction (`adoptNativeMarketManifest`, `update-release-metadata.ts`, the same one as above) writes the market's manifest fields
and frozen copy, the market version, `verification: manifest`, and clears `installedTag`/`channelSource`. Nothing is
downloaded or restarted; secrets, the app token, the sign-in client, volumes and the database are keyed by the app id
and stay. With another package it is an ordinary update by version, with the same package and another runtime
configuration an ordinary update of that package; an app its market does not list keeps running and
says "No update source: <id> is not in the YouEye Market".

Pointer is part of the System, not a Market app: it stays on the box's release channel, ordered by line and
`sequence` (`compareToInstalledNative`, [releases.md](releases.md#ordering-line-then-sequence)).

## A new app from Canvas

From `YouEye-Canvas/README.md`:
1. Fork or copy `YouEye-Canvas` into a new repository.
2. `pnpm install --frozen-lockfile`.
3. `node scripts/rename.mjs --dry-run --id <id> --name "<Name>" --repo <repo>`, then run it without `--dry-run`.
4. Edit `youeye-app.yaml` (`id`, `name`, `listing`, `surfaces`, `capabilities`, `proxy`) and the app code.
5. `pnpm test && pnpm validate:source && pnpm build`.

Canvas itself is released as source (`source.tar.gz` + `youeye-app.yaml`), not as an installable app. It carries the
same release build as the reference apps (`output: "standalone"` in `next.config.ts`, `.youeye/build/`, the
`scripts/` of its `build` script including `write-release-manifest.mjs`, and `THIRD_PARTY_NOTICES.txt`), so a fork
builds an installable `standalone.tar` without copying anything from another app.

To ship a fork, publish it yourself; nothing in YouEye's release tooling is needed:
1. Build it (`pnpm build`, or `.youeye/build/app`) and publish `standalone.tar` at a stable HTTPS address, for example
   as an asset of a release of your repository.
2. Make a market ([market-format.md](market-format.md), "Make your own market" on market.youeye.me): an
   `apps/<id>/youeye-app.yaml` that is your manifest with `requires: {youeye: ">=0.6.20"}` and `source.package` (the
   URL, `sha256sum` and size in bytes of that `standalone.tar`), built with `control-panel/scripts/market-build.ts`.
3. Owners add your market (`youeye market add <address> --i-trust-this-market`) and install the app from it; the
   install screen shows what a native app gets. A new version is a new release plus a new market commit that pins it.
