# Native apps

Native apps are YouEye's own apps: Next.js servers that run in an Incus system container and use the platform
directly (dashboard widgets, notifications, the UI gateway). Container apps from the Market are described in
[market.md](market.md); the manifest format both use is in [app-manifest.md](app-manifest.md).

| App | Repository | What it does |
|---|---|---|
| Notes | `YE-App-Notes` | Markdown notes with folders, pinning, search and public sharing |
| Wiki | `YE-App-Wiki` | Wikipedia reader; pages are fetched through the UI gateway |
| Search | `YE-App-Search` | Web search through a connected search engine app (SearXNG or any `search-engine`) |
| Translate | `YE-App-Translate` | Translation (MyMemory, or a connected LibreTranslate) |
| Weather | `YE-App-Weather` | Forecasts for saved places (Open-Meteo) |
| Cinema | `YE-App-Cinema` | Movies and TV from TMDB, watchlists, reviews; can connect to Jellyfin |

The template for new ones is **YouEye-Canvas**. The Market shows a native app when its id is listed in the
catalog's `native:` list; the app itself comes from its own product release (see Releases below).

| | Container app | Native app |
|---|---|---|
| Source | `YE-AppMarket/apps/<id>/` | its own repository |
| Runs as | upstream OCI images, pinned by digest | `standalone.tar` in a Debian 12 system container, Node 22 or 24 |
| Released as | part of the Market catalog release | its own product release (`standalone.tar` + `youeye-app.yaml`) |
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
  on the app; placements `dashboard`, `timeline`, `notification-center`, `app-settings`, `app-detail`.
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
  uses them.
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
(`ui/src/app/api/v1/apps/[appId]/launch-requirements`). Only `proxy:` hosts with the default `scope: user` are
asked for, so a host declared with `scope: service` is refused today; no shipped app uses it.

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

- `VERSION` holds the release line `X.Y.Z`. Each build is `X.Y.Z-dev.N` and gets that version as
  `YOUEYE_VERSION`; `package.json` and the manifest keep `0.0.0`.
- The build entrypoint is `.youeye/build/app` (with `lib.sh` and `manifest.json`). It installs offline from a
  shared pnpm store, runs `pnpm run build`, finds the single `server.js` under `.next/standalone`, adds
  `LICENSE`, `TRADEMARK.md` and `THIRD_PARTY_NOTICES.txt`, and runs `scripts/write-release-manifest.mjs`. That
  script writes `release-manifest.json` into the tree and the release copy of `youeye-app.yaml` with
  `version: <build>`. The tree is packed as a reproducible `standalone.tar` (sorted, fixed owner and mtime).
- A build is published as release `v<X.Y.Z>-dev.N` of the app's repository, with `product-release.json`,
  `standalone.tar` and `youeye-app.yaml`, and the channel index's product key (the app id: `notes`, `wiki`, …)
  points at it. Promotion names the same build `-alpha.N`, `-beta.N`, then `X.Y.Z`. See [releases.md](releases.md)
  and [development.md](development.md).

What the CP checks when it installs or updates a native app (`src/lib/market/native-artifact.ts`):
1. It resolves product `<id>` from the box's channel index; the release must be a `native` build.
2. `youeye-app.yaml` must match the build's `contract_sha256`, pass the strict parser and name the same id. Its
   `version` becomes the release version; listing icon files and screenshots are dropped (a native release has
   no setup files and no images).
3. `standalone.tar` may be at most 1 GiB (`MAX_ARTIFACT_BYTES`) and 2 GiB unpacked, with at most 100,000
   entries, no hard links or special files, symbolic links only inside the package, and a `server.js`. It is
   hashed again right before it is deployed.

Updates compare **builds**: a newer `X.Y.Z-dev.N` is an update; the same build under a promoted name only updates
the release record. An update stops the app, replaces `/opt/app` with the new package, writes the env again,
starts it and waits for its health check; a failure restores the checkpoint (see [market.md](market.md)).

## A new app from Canvas

From `YouEye-Canvas/README.md`:
1. Fork or copy `YouEye-Canvas` into a new repository.
2. `pnpm install --frozen-lockfile`.
3. `node scripts/rename.mjs --dry-run --id <id> --name "<Name>" --repo <repo>`, then run it without `--dry-run`.
4. Edit `youeye-app.yaml` (`id`, `name`, `listing`, `surfaces`, `capabilities`, `proxy`) and the app code.
5. `pnpm test && pnpm validate:source && pnpm build`.

Canvas itself is released as source (`source.tar.gz` + `youeye-app.yaml`), not as an installable app. To make a
fork installable, copy from an existing native app what Canvas does not carry: `output: "standalone"` in
`next.config.ts`, the `.youeye/build/` directory, the `scripts/` used by its `build` script (including
`write-release-manifest.mjs`, with the new id) and `THIRD_PARTY_NOTICES.txt`. Then add the repository and product
key to the release tooling and the id to the catalog's `native:` list.
