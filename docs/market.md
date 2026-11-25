# Market

How apps get from a market onto a box, and what the Control Panel (CP) does with them afterwards. The published
format of a market, how to build and host one and the "Add to YouEye" links are in
[market-format.md](market-format.md); the app format itself is in [app-manifest.md](app-manifest.md); the `${…}`
variables are in [app-environment.md](app-environment.md); who may open an app is in
[app-admission.md](app-admission.md).

| Piece | Where |
|---|---|
| Official catalog | repository `YE-AppMarket`: `store.yaml`, `catalog.yaml`, `apps/<id>/`, `bundles/<id>/`; published at `https://market.youeye.me` |
| Parser and validator | `control-panel/src/lib/market/app-format/` (`parseApp`, `parseSetup`, compile to the internal model) |
| Format, fetcher, store | `market-format.ts`, `market-fetch.ts`, `market-store.ts` |
| Market reader, sources and consent | `catalog.ts`, `source.ts`, `update-routing.ts`, `direct-apps.ts` (apps added by URL) |
| Install, update, uninstall | `engine.ts`, `updater.ts`, `uninstaller.ts`, `install-tracker.ts`, `instance-ownership.ts` |
| Setup files and connections | `setup-runner.ts`, `setup-context.ts`, `wire-runner.ts`, `bundle-installer.ts`, `src/lib/bridges/` |
| HTTP API | `control-panel/src/app/api/market/**`, `/api/apps/<id>/{update,control}`, `/api/suggestions` |
| CLI | `youeye app …` and `youeye market …` in `spine/internal/cmd/app.go`, `market.go` (they call the CP API) |

## Where the apps come from

Every market, the official one included, is a folder of static files at an HTTPS address
([market-format.md](market-format.md)). There are no Market releases, versions or promotions, and the Market is not
a product of the channel index.

- **The official Market** (source id `official`) reads its lane: `https://market.youeye.me/` (`main`, branch `main` of
  the catalog) on every box, or `https://market.youeye.me/dev/` (branch `dev`) when the owner chose it. The lane is the
  box's own setting since 0.6.20 (YE-142): `lane` on the official entry of `market-sources.json`, missing means `main`
  whatever the release channel. Set it with `youeye market official-lane main|dev`, `PATCH /api/market/source`
  `{official_lane}` or "Change…" on the sources page. Before 0.6.20 the lane followed the channel (dev and alpha read
  `/dev/`). Test boxes that test `/dev/` set the lane after updating to 0.6.20.
- **Custom markets** (`kind: url`) are addresses the owner added (see [Markets and consent](#markets-and-consent)).
- **Native apps** are Market apps (0.6.20, YE-142): index entries of kind `native` whose manifest pins the app's
  `standalone.tar` (`source.package`), in any market, official or custom ([native-apps.md](native-apps.md)). A
  `native` id list an older index still carries is ignored. Pointer is not a Market app: it stays on the box's release
  channel.
- **Apps added by URL** are their own source (`direct:<hash>`; see Installing).

**What is in the official catalog.** `store.yaml` (the market's name, publisher and homepage), `catalog.yaml`
(`youeye.catalog.v1`: categories and curation (`spotlight`, `collections`)), apps (container and native) in
`apps/<id>/youeye-app.yaml` (`youeye.app.v1`) with `setup/*.yaml`, icon and screenshots, and bundles in
`bundles/<id>/bundle.yaml` (`youeye.bundle.v1`). The generator finds apps and bundles from the folders and checks
every one with the CP's parser; how the official Market is published is in
[market-format.md](market-format.md#the-official-market).

### The store on the box

The box keeps an accepted copy of each market in `/var/lib/youeye/markets/<sourceId>/` (directories 0700, files
0600; `market-store.ts`):

| File | What |
|---|---|
| `state.json` | the accepted state: the market's address, its `sequence` (the floor for that address), the exact bytes of the accepted `market.json` and their SHA-256, its ETag, `accepted_at` |
| `refresh.json` | `checked_at` (last attempt), `refreshed_at` (last success), `error` (why the last attempt failed) |
| `h/index/<sha256>.json` | the accepted index |
| `h/apps/<id>/<sha256>.json` | **every** bundle the index names (the connections route reads every manifest; about 180 KB for the official Market) |
| `h/files/<sha256>.<ext>` | the pictures fetched so far (at most 512 MiB per market) |
| `attempt-<pid>-<random>/` | the bundles a running refresh has fetched; removed when the refresh ends |

- **Accepting** a new state: `market.json` (sent with `If-None-Match`; a `304` costs nothing) → refuse a `sequence`
  more than a day ahead of the box's clock or below the floor of the same address
  ([market-format.md](market-format.md#rules-that-keep-every-box-working)) → the index (size and SHA-256) → each
  bundle not already in the store (size and SHA-256, four at a time over one connection pool) into the attempt's
  own directory → the commit, under a lock per source: the fetched files move under `h/`, then `state.json` last,
  in one rename → remove hashed files the new state no longer names. Until that rename the store holds the old
  state, after it the new one. Nothing under `h/` changes before the commit, so after a failed attempt `h/` holds
  only what the accepted state names (nothing when there is none). An attempt directory older than 10 minutes that
  no running refresh owns (a process that ended under it) is removed by the next refresh.
- **One refresh at a time** per source id **and** address. One refresh ends within 3 minutes
  (`MARKET_REFRESH_DEADLINE_MS`), successful or not. A refresh whose source was removed, or whose source id now
  names another address, commits nothing. Removing a source stops its running refresh and waits for it (5 s at
  most) before its store is deleted.
- **Reading** checks every stored file against its hash once per accepted state. A damaged file is fetched again by
  the next refresh.
- **When a market is asked.** At most once per source every 5 minutes plus 0–10 % jitter, in the background, and
  whenever something asks for a fresh answer: "Check for updates" (`youeye app check-updates`, also the 6-hourly
  check), Refresh on the sources page (`youeye market refresh`), adding, accepting or editing a source, and an app
  update (which refreshes only that app's source first). A reader waits for the network only then, or when the
  store is still empty, and for 20 s at most (`MARKET_READER_WAIT_MS`; for an empty store counted from the start of
  the refresh). Then it gets the store, or the message "The market is still being read; this box keeps reading it
  in the background", and the refresh goes on to its deadline. A failing first read is retried 30 s after the end of
  the failed attempt at the earliest; after a failed attempt that took longer than 20 s, an empty store is read
  again in the background only, so a market that never answers costs readers one wait, not one per page. The 30 s
  rule holds across a Control Panel restart too (counted from `checked_at` in `refresh.json`). An attempt dated
  in the future (made while the box's clock was ahead, since corrected) counts as never made: the market is
  asked at the next read. Market
  pages, `/api/apps/unified` and `/api/ui-bridge/apps` read the store.
- **Offline or broken.** A market that cannot be reached, is not valid, is too slow, or offers a lower or
  future-dated `sequence` keeps its accepted state: the Market keeps listing it, and the failure is recorded in
  `refresh.json`, shown on the sources page ("Last refreshed …" and the error) and by `youeye market list`. A store
  that cannot be read at all never breaks the source list: that source is listed with `market: null` and the reason
  in `refresh_error`, so it can still be turned off or removed.
- **Address changes.** When a source's address changes (the official Market after a lane change, a custom
  market whose address was edited), the store's state no longer counts for it; the next successful accept starts a
  new `sequence` floor and replaces the store. A removed source's store is deleted.
- **Files of the old catalog.** Once the official store has an accepted index, the CP deletes
  `/var/lib/youeye/market-releases/` and `/var/lib/youeye/catalog-cache.json`, which boxes up to 0.6.10 used.

**What an install records** (install metadata and the installed-apps record): `catalogKey` `<sourceId>:app:<id>`;
`manifestPath` `apps/<id>/youeye-app.yaml`; `manifestRepo` the market's address; `manifestBranch` the market's
commit; `manifestDigest` the frozen digest; `sourceRepoUrl` the market address for a custom market (none for the
official Market).

### What the Market shows

- **A store.** The Market home is one grid of apps: search, category chips (and "Added by address" for apps added by
  URL, all of them), the catalog's own picks and collections, then one shelf per category. An app's page has its one
  action in the header (Install; Open and Manage in Settings once installed), its facts, screenshots, what installing
  it adds, and links. The install dialog asks where (address) and who (sign-in, access) first, folds the rest and
  keeps Install in view. Everything that changes an installed app (update source, manifest sync, default sign-in,
  uninstall) is on its page in Settings → Apps ([control-panel.md](control-panel.md#settings-pages)).
- **One card per app.** The Market home shows one entry per id, the official Market's first. An app's page lists the
  other enabled markets (and apps added by URL) that carry the same id ("Also available from …", with their
  version). For an installed app, Settings → Apps → the app → Updates says where it takes its updates from
  ("Updates from: …") with **Change**: the guarded source switch below. Nothing switches by itself. `GET /api/market/app/<id>[?source=<id>]` answers
  `{app, variants, installed}`: `app` is the app in the named market (else the first enabled market that has it),
  `variants` the other markets' entries, `installed` the source the install recorded (id, name, address, version,
  `updateBlocked`), or null.
- **Needs a newer YouEye.** An index entry whose `requires.youeye` is above the box, or whose `kind` this box does
  not know, is listed from the index alone with "Needs YouEye X.Y.Z or newer" (or "Needs a newer YouEye")
  instead of Install (`MarketApp.installBlocked`, `needsYouEye`); its bundle is never parsed. Install and switch
  answer 409 `{error, code: "requires-newer-youeye", needsYouEye}`. An entry this box should understand but whose
  manifest fails the strict parse is left out with the parser's own reason on the Market page and in the log; so is
  an entry whose bundle holds another app's manifest (the id is checked on every read, also of a cached manifest).
- **Listing.** Cards of apps that are not from the official Market show the source's name ("Added" for an app added
  by URL). A bundle id found in several markets is shown once, the official Market's first.
- **Who may read it.** Any signed-in user, standard users included, may read the Market APIs: `GET /api/market`,
  `/api/market/catalog`, `/api/market/app/<id>` (and its `connections`), `/api/market/status`,
  `/api/market/install-status`, `/api/market/providers`, `/api/market/updates` and `/api/market/validate-subdomain`.
  Everything that changes the box stays admin-only: install, update, uninstall, recovery, sources, sign-in and access
  settings, AI Settings, credentials, and starting a version check (`POST /api/market/updates`,
  `POST /api/apps/check-updates`, which read every market again). So does `POST /api/market/validate`: it changes
  nothing, but its image check makes the box reach any registry a manifest names. The Market
  pages (`/market`) are for admins: a standard user who opens them is sent to Settings, so no Install button is shown
  that would fail. `tests/route-auth.spec.ts` lists every handler that a standard user may call; every other one checks for an admin.

## Markets and consent

**The rule** (`source.ts`). Wherever no source is named, the official Market is used; a custom market is used only
after the owner accepted it, and an app added by URL only with its own confirmation. An installed app stays with
the source it was installed from: nothing moves it to another source by itself.

**Custom markets** are listed in `/var/lib/youeye/market-sources.json` and managed on Market → Sources
(`/market/sources`). Adding one previews it first: the market's own name and publisher (shown as its words), its
commit and date, its number of apps and how many run setup steps. Without a name from the owner a custom market is
named by its host. The sources page shows, per market, its address, commit and date, the last refresh and its
error, Refresh now, and Accept for a market that is not accepted.

- **Acceptance.** A custom market carries `accepted_at`, which only the CP sets: when it is added with the trust
  tick (`acceptRisk: true`), or by the accept call. Changing its address clears it.
- **Not accepted.** Its apps and bundles are still listed, marked `sourceNotAccepted` ("Not accepted"), but they are
  never installed, updated or switched to, and its pictures are not served.
- **Turned off or missing.** A source that is turned off or no longer configured is never used. With the official
  Market turned off, an install that names no source is refused.
- **Source ids.** `official` and `direct` (the prefix of apps added by URL) are reserved. Without an `id` a market
  gets the first `custom-N` (from 1) that no source has and no installed app records. A chosen id that an installed
  app records for another address is refused (400). Two sources with the same address are refused.
- **Official lanes.** `https://market.youeye.me/` and `https://market.youeye.me/dev/` are never a custom market:
  adding one or re-pointing a market at one is refused (400, "This is the official YouEye Market; your YouEye
  already follows it") before anything is fetched ([market-format.md](market-format.md#the-official-market)).
- **Writes.** Every change to `market-sources.json` runs on one write chain per CP process, shared by the API routes
  and the background jobs, and reads the file inside it, so no write reverts another.

**Git sources are gone.** Boxes up to 0.6.10 could add a Git repository read as raw files. Such an entry
(`repo_url`) is removed from the list the first time 0.6.11 reads it and remembered under `removed_sources` in the
same file; the sources page and `youeye market list` name them until the owner dismisses the note. Apps installed
from one keep running; their update check says "no update source" (`source-unavailable`) and offers nothing. To
take updates again, add the market's address (if its publisher has one), which gives it a new id, then choose
**Change** on each app's page in Settings → Apps (Updates), or run `youeye app source <app> <market id>`.

| Call | Does |
|---|---|
| `GET /api/market/source` | `{ sources, removed_sources }`. Each source: `id, name, kind, url, enabled, priority, accepted_at`, `lane` (the official Market only: `main` or `dev`; absent means `main`), `address` (where its copy was read from; the official Market's lane), `market` (`{address, name, publisher, homepage?, commit?, sequence, sequence_date, apps, apps_with_setup, native, bundles}`, null while the box has no copy or cannot read it), `accepted_market_at`, `refreshed_at`, `checked_at`, `refresh_error`. `apps` counts every app; `native` counts those of kind `native`, in any market; `sequence_date` is an empty string when `sequence` is no time |
| `POST /api/market/source` | `{ url, name?, id?, acceptRisk: true }` reads the market first (20 s at most; an address that is not a market adds nothing, 400), then adds it, accepted, and waits up to 20 s for its first copy; a larger or slower market is read on in the background, so the new source may answer with `market: null`. Without `acceptRisk: true` the answer is 400 `source-not-accepted` |
| `PATCH /api/market/source` | `{ active_sources: [{id, name?, url?, enabled?, priority?}] }` turns markets on or off, renames, reorders, re-points and removes them; it cannot add one or set `accepted_at`, and a changed `url` clears it. `{ dismiss_removed_sources: true }` clears the note about removed git sources; `{ official_lane: "main" | "dev" }` sets the official Market's lane (YE-142, `youeye market official-lane`) |
| `POST /api/market/source/accept` | `{ id }` accepts an existing custom market (404 when there is none) |
| `POST /api/market/source/refresh` | `{ id? }` asks that market (or every enabled one) now and waits up to 20 s: `{ results: [{id, ok, sequence?, commit?, error?}], sources, removed_sources }`. A market not done by then is `ok: false` with "The market is still being read; …", and the box reads on in the background |
| `POST /api/market/add/preview` | `?market=<address>` or `?app=<manifest URL>`, no body: what an "Add to YouEye" link would add; writes nothing; at most two at once (429 otherwise) ([market-format.md](market-format.md#add-to-youeye-links)) |

All of them need an admin: a session (with the CSRF token for `POST` and `PATCH`) or the CLI token.

**CLI** (`spine/internal/cmd/market.go`):

| Command | Does |
|---|---|
| `youeye market list` | every market: ID, NAME, ADDRESS, MARKET SAYS (its own name and publisher), COMMIT, DATE, APPS, ENABLED, ACCEPTED, LAST REFRESH; then each failed refresh with its reason, and removed git sources |
| `youeye market add <address> --i-trust-this-market [--name <name>]` | add and accept a market (refused without the flag) |
| `youeye market remove <id>` | remove a custom market (the official one cannot be removed); its apps keep running without updates |
| `youeye market accept <id>` | accept a market that lost its acceptance |
| `youeye market refresh [id]` | ask one or every market now; exits 1 when one failed |
| `youeye market search <text>` | apps of all markets, with their market and a note (needs a newer YouEye, market not accepted) |
| `youeye market info <app id> [--source <id>]` | one app: market, address, version, what blocks it; for an installed app "Installed" (version, the market it takes updates from, its address) and, when updates are blocked, "Updates" with the reason. An unknown `--source` says `there is no market "<id>" (see youeye market list)`, or that the market is turned off |

`youeye app install <id> --source <market id>` installs from a named market. `youeye app source <app> <market id>`
points an installed app at a market that has the same app (the page's **Change**; the market must be accepted;
nothing changes until the app's next update). `youeye app check-updates` lists the apps whose check is blocked,
with the reason, after the updates it found. `youeye market refresh` says for each market whether it was
updated or is up to date. `youeye market source …` and
`youeye market repo …` no longer exist. `youeye market …` and
`youeye app list|info|install|update|check-updates|source|remove|start|stop|restart` remove control characters and
terminal escape sequences from the text a market or the Control Panel sends before they print it.
`youeye app credentials` prints a user name or password exactly as it must be typed; one that holds such
characters is printed quoted, with them visible.

**Apps added by URL.** A single app can be added by its `youeye-app.yaml` URL; it is listed as "Added" with a
`direct:<hash>` source id and is its own source (see Installing). It needs `acceptUnverifiedPublisher: true`, and
`allowSetup: true` when it has setup files, on every install and switch; an update asks again when its setup files
changed. A repository address (`https://<host>/<owner>/<repo>`) is read as `youeye-app.yaml` on its `main` branch
(from `raw.githubusercontent.com` for GitHub); any other URL, including any address of a `.yaml`/`.yml` file, is
used as given.

**Refusals.** A refusal for lack of consent (`MarketSourceConsentError`) answers `{ error, code, setups? }`:

| `code` | When | HTTP |
|---|---|---|
| `source-unavailable` | the named source is turned off or not configured, or a `direct:` id where a Market source is needed | 400 (install, bundle, switch); 403 (update) |
| `source-not-accepted` | a custom market without `accepted_at` | 403 |
| `publisher-not-trusted` | an app added by URL without `acceptUnverifiedPublisher: true` | 403 (install, switch) |
| `setup-not-allowed` | an app added by URL with setup files, without `allowSetup: true`; `setups` lists them | 403 (install, switch); 400 (`install-url`) |
| `setup-changed` | an update of an app added by URL whose setup files changed, without `allowSetup: true` | 409 JSON with `setups`, or an SSE `failed` event with `code` and `setups` |
| `source-changed` | an update of an app whose source id now names another market address than the app recorded | 403 JSON, or an SSE `failed` event with `code` |

On the SSE update routes a `source-not-accepted` or `source-unavailable` update ends with a `failed` event whose
message names the cause. An update whose new version needs a newer YouEye fails with `requires-newer-youeye` and
"Update YouEye in Settings, then update the app."

**Why an installed app gets no updates.** The update check stores the reason on the installed-app record
(`/var/lib/youeye/state/installed-apps.json`) as `updateBlocked: { code, message }`, offers nothing, and clears any
stale offer. Settings → Apps (the list and the app's Updates section) and the dashboard's Apps panel show it:

| `updateBlocked.code` | Meaning | Remedy |
|---|---|---|
| `source-unavailable` | "No update source": its market is no longer on the box (removed, or a git source) or is turned off | turn it on, or add a market that has the app and choose Change |
| `source-not-accepted` | its custom market is not accepted | `youeye market accept <id>` or Accept on the sources page |
| `source-changed` | its source id now names another address than the app recorded | Change in Settings → Apps → the app → Updates, if you want its updates from there |
| `requires-newer-youeye` | the market's new version needs a newer YouEye | update YouEye; the offer then appears |

**The source changed.** An app records the market address of its source at install (custom markets only). A source
id can come to name another address: a removed market's id taken again, or a market's address edited. The app
follows the address it recorded, never just the id: its update is refused with `source-changed` (the message names
both addresses) and the update check stores `updateBlocked` as above. The official Market's address is its lane's,
is not recorded per app and is never "changed": after a lane change apps compare their versions with the new lane. The remedy is an explicit switch on the app's page in Settings → Apps
(`PATCH /api/market/app/<id>/source`), which records the new address.

**What can install, update or re-point an app, and how it is guarded**

| Path | Source it reads | Guard |
|---|---|---|
| Install: `POST /api/market/install`, `youeye app install <id> [--source <id>]` | the named `sourceId`, else the official Market | the rule above; source, catalog key and manifest fields are set by the CP, never taken from the client |
| Install by URL: `POST /api/market/install-url`, `youeye app install --url` | the URL | `acceptUnverifiedPublisher`, plus `allowSetup` when it has setup files |
| Add to the Market by URL: `POST /api/market/validate-url` `{ manifestUrl, addToMarket: true, allowSetup? }` (also from an "Add to YouEye" link) | the URL | `allowSetup` when it has setup files; the install from the "Added" entry asks again |
| Add a market: `POST /api/market/source` (sources page, `youeye market add`, an "Add to YouEye" link) | the address | admin with CSRF token; `acceptRisk: true`; the market is read first |
| Bundle install: `POST /api/market/bundles/<id>/install[?source=<id>]` | the bundle's market, else the official Market | the rule above; every member installs from that market and is recorded with it |
| App update: `POST /api/apps/<id>/update`, `POST /api/market/update`, `POST /settings/api/apps/<id>/update` (all `updateMarketApp`) | the app's recorded source, else the official Market | the rule above; `source-changed` when the source id now names another address; an app added by URL: `setup-changed` without `allowSetup` |
| Update check (every 6 hours plus jitter, `youeye app check-updates`) | the app's recorded source, else the official Market | a refused or missing source gives no offer and `updateBlocked`; a changed address gives no offer and `updateBlocked` (`source-changed`); it writes a source into an app only when it is the recorded one or the official one |
| Source switch ("Change"): `PATCH /api/market/app/<id>/source` `{ sourceId, acceptUnverifiedPublisher?, allowSetup? }` | the named source | admin with CSRF token; the rule above; 409 `requires-newer-youeye` when that market's version needs a newer YouEye. The whole switch holds the platform lifecycle (a Control Panel restart waits for it); the source is resolved first, and the record is then changed inside the app's lifecycle lock: 409 `operation_in_progress` when the app is busy (after a 30 s wait), 409 `recovery_required` when it has an unfinished update. Only the source identity changes (id, name, market address): the installed copy and its digest stay until the next update |
| Restore, independent copy | none | a restore rebuilds the app from its backed-up frozen manifest; a copy reads no source |

## Core containers are not Market apps

Caddy, PostgreSQL and Pi-hole run images pinned by digest in the Control Panel
(`control-panel/src/lib/infrastructure/system-images.ts`). They change only with a System release and are never
read from any market, official or custom; first deployment does not need the Market. They are updated from
Settings → System (or Settings → Apps), with a maintenance acknowledgement, onto the pinned image
([control-panel.md](control-panel.md#updates)). The catalog has no `system/` files.

## Pictures

`GET /api/market/image?source=<source id>&file=<h/files/<sha256>.<ext>>` on the Control Panel
(`control-panel/src/app/api/market/image/route.ts`) serves app icons and screenshots. It needs no sign-in, so it
serves only what the owner already chose to read:

- Only a picture path that the accepted index or a stored bundle of an **enabled** market names, and for a custom
  market only once it is accepted. Anything else (another path, an unknown, disabled or unaccepted source, a URL) is
  404 and causes no outbound request.
- A named picture is read from the store; the first time it is fetched from the market's own address (5 MiB limit,
  checked against the hash in its path, one fetch shared by simultaneous requests) and kept. A named picture that
  cannot be fetched is 502, and the failure is remembered for 60 s.
- The box fetches at most 4 pictures from markets at once, 3 of them from one market, so requests for many pictures
  it does not hold yet cannot fill its memory. A request beyond that waits for a place, 20 s at most and with at
  most 200 waiting; then it is answered 503 with `Retry-After: 5`. That is not a failure of the picture and is not
  remembered.
- The type comes from the file extension (PNG, JPEG, WebP, GIF or SVG). The path names the content, so the answer is
  `Cache-Control: public, max-age=31536000, immutable`.
- Every answer carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `X-Content-Type-Options: nosniff`, so an SVG opened directly cannot run script. The proxy
  (`control-panel/src/proxy.ts`) sets the same policy for this path, because a policy set in the proxy replaces a
  route's own.

The dashboard has no image route of its own. An installed app's dashboard icon is inlined as a data URI at install,
read from the store of the market it is installed from (`app-icon.ts`); anything else falls back to the listing's
Lucide icon name.

## Installing an app

Every install is admin-only and CSRF-checked and streams progress as server-sent events. From its start (before the
market, the manifest or the bundle is read) to the end of its stream it holds the platform lifecycle, so a Control
Panel restart waits for it; while a System update owns the platform it is refused with 409 and that reason, and a
gate held by a waiting System update is waited for up to 30 s (then 409 `operation_in_progress`):

- **`POST /api/market/install`** with `{ appId }`. Optional: `sourceId`, `subdomain`, `selectedIntegrations`
  (`["youeye-id"]` turns YouEye ID sign-in on for an app with `setup/sso.yaml`; on by default), `aiSettings`,
  `allowInternet`, `publicAccess`, `adoptRetainedData`, and for an "Added" (`direct:`) app
  `acceptUnverifiedPublisher` and `allowSetup`. Without `sourceId` the app comes from the official Market; a named
  custom market must be accepted (see [Markets and consent](#markets-and-consent)). The CP sets the
  record's source, catalog key and manifest fields itself, and fills in the subdomain (the manifest's `subdomain:`,
  else the id). The domain is always the box's own; a client value is ignored. An install is refused (HTTP 423) while Health has a critical issue about that app (or about the box,
  such as the app-network or install-state issues); another app's critical issue doesn't block it, and neither does
  "YouEye AI is down" (`service.pointer.down`, e.g. while Pointer is still starting after a fresh install): an app
  that uses AI asks Pointer before anything is created and is refused there (YE-219). Each critical
  issue names its cause and the command or Fix for it (`youeye doctor` lists them).
- **A failed install** whose rollback couldn't finish is cleaned up by the reconciler (back-off between tries), or
  by `youeye app remove <id>`. `youeye app remove <id> --force` is for a broken or unfinished install only (still
  installing, cleanup pending, or a recorded container gone; an intact app is refused with 409): it skips the
  data-ownership check, removes what carries the app's id and installation id, and never deletes a shared folder.
  Without an install record (a removal that half finished on 0.6.20-alpha.4 or earlier) it rebuilds the map from
  what Incus holds with the app's tags, its instances (never a `ye-retained-*` kept copy) and its own volumes, all of
  one installation, else it refuses (YE-222). It refuses an app still listed as installed.
- **Kept data is never deleted by a forced or delete-data removal** (YE-222), with or without an install record: when
  the app has `retained.json`, or its admission policy is `retained` or `quarantined` (or either cannot be read), every
  `--force`, every delete-data uninstall and every delete-data cleanup (also the reconcile pass) refuses before it
  changes anything: "its data is kept (a removal with keep-data started or finished) … Finish that removal with
  youeye app remove <id> --keep-data, or install <id> again to take the data back". Before 0.6.20 a keep-data removal
  that stopped partway, followed by `--force`, deleted the kept data. An `adopted` `retained.json` (left when the
  cleanup after an adoption failed) is not kept data: its data lives in the installed app.
- **A keep-data removal deletes a container only with its verified kept copy** (YE-222): when the scan cleanup (the
  reconcile pass, `--force --keep-data`) finishes a keep-data removal, each container goes only after its
  `ye-retained-*` copy is verified at that moment (`retained.json` ready, the copy present, tagged, stopped and
  isolated); otherwise the container is kept and the cleanup reports it. Since 0.6.18 a keep-data finish could delete
  a root whose copy was never made.
- **`--force` records its mode first and is checked under the lock**: whether `--force` applies (unfinished install,
  removal pending, a container gone, no record) is decided inside the app's lifecycle lock, after its mode is written
  on a pending lease.
- **A URL install that adopted kept data rolls back keeping it** (before 0.6.20 the rollback deleted it). `youeye app recover <id>` finishes an interrupted app update.
- **`youeye app install <id> [--source <id>] [--public-access[=false]]`** sends `{ appId }` (plus `sourceId` with
  `--source`, and `publicAccess` when that flag is given) to the same endpoint. Without `--source` the app comes
  from the official Market; the ids are in `youeye market list`. The CLI has no YouEye ID user, so AI
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
4. **Native packages** (native apps only) are downloaded from the manifest's `source.package` and checked against
   its size and SHA-256 (and that the archive is a safe app tree with a `server.js`).
5. **Network.** The app gets its own Incus bridge `yeapp<N>` with a /27 subnet, NAT on for the install, and an
   egress ACL. Custom volumes are created. `install.json` is written now as the recovery map.
6. **Secrets** are generated and stored in `/var/lib/youeye/app-<id>/secrets/<name>` (directory 0700, files 0600).
   Existing secrets are kept, so a reinstall reuses them.
7. **Pointer key** (apps with `ai:` and AI Settings on), then the **database**: with `database: postgres` the CP
   creates the database and role in the shared YouEye PostgreSQL.
8. **YouEye ID client** (apps with `sso:` and sign-in on): OAuth client `youeye-app-<id>`, redirect URIs from
   `sso.callback` and `sso.extra_callbacks`, scopes `openid profile email groups` (plus the `role_claim` name).
9. **Containers.** Sidecars first, `main` last, because main's health check usually needs its sidecars. The
   sidecars go in the start order updates use: databases, caches, plain sidecars, workers (the manifest's order
   within each; [app-update-transactions.md](app-update-transactions.md#stops-and-starts)). Each
   instance is created with the tags `user.youeye.app_id` and `user.youeye.installation_id`, gets its env and
   `files:`, starts, and must pass its health check (an HTTP GET answering 2xx, 3xx, 401 or 403 within the
   manifest's timeout; `market/health.ts`). Container names are `app-<id>` or `app-<id>-<container>`.
10. **Network wiring.** Incus proxy devices let the app reach the system services it needs: the UI gateway, and
    PostgreSQL, YouEye ID or Pointer inference when it uses them. Caddy joins the app bridge.
11. **Setup files.** The OCI containers of an SSO app get the box's Caddy root CA. Then `setup/install.yaml` runs,
    then `setup/sso.yaml` when sign-in is on (see [app-manifest.md](app-manifest.md) for the step rules). When the
    app's data came back (a restore, or kept data taken over) `install.yaml` is not run.
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

Every new app is for **all active household users** (since 0.6.20, YE-232); the installing admin can choose
"Only me" under the install dialog's "Name, address and more" (`accessMode: "owner"`), and then only the admission
owner is admitted. Being a YouEye admin alone does not admit anyone. A reinstall keeps the policy it had; apps
installed before 0.6.20 stay owner-only until an admin changes them. An admin can change the policy to owner only,
all users, selected users or selected groups (in the app's Market settings, or `GET`/`PUT
/api/market/apps/<id>/access`); "Who may enter" also decides the dashboard and YouEye ID sign-in of a public app. YouEye ID enforces it at sign-in, token use and Caddy
forward-auth; see [app-admission.md](app-admission.md).

**Public access.** The "Only <site> users" switch (install dialog and Access settings) is the one control: off is
public access (YE-154, [app-admission.md](app-admission.md)). An app whose manifest sets `public_access: true`
protects itself (its own password, PINs or accounts). Installed from the official catalog, it starts with the switch
off (the installer can turn it on; `--public-access=false` on the CLI). Apps without a sign-in of their own, or that
trust the YouEye sign-in header, stay locked on. Then Caddy's forward-auth check lets every request
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
  An admin approves or dismisses them in Settings → Apps → either app → Connections (the app's row in the list
  says how many wait); from the box, `youeye app suggestions` lists them and `youeye app connect <from> <to>`
  approves one.
  Uninstalling an app drops its suggestions and marks suggestions pointing at it as waiting again.
  An update drops the suggestions its new release no longer asks for and adds the new ones, and each start of
  the CP drops what installed apps no longer ask for (`dropSuggestionsOfDroppedWants`; an update before 0.6.15
  kept them). What an app wants and what a target provides are both read from the installed copy (the frozen
  manifest), never from the install metadata, which can still name the release the app was installed from; a
  target whose installed copy cannot be read keeps the suggestions made for a capability. Every change of the
  store (`/var/lib/youeye/bridges/suggestions.json`) is a read, an edit and a write, and they run one at a time
  (a queue in the CP process, `lib/bridges/suggestions.ts`), so the cleanup at start and an install or a
  dismissal at the same moment do not undo each other.
- **Disconnecting** (Disconnect in the Connections section, `DELETE /api/bridges/<id>`) unwires the connection and
  removes its record; while the consumer still asks for the target and both are installed, its suggestion comes back
  (`suggestAgainAfterDisconnect`, also when it had been dismissed earlier), so it can be approved again. Otherwise
  a dismissed suggestion stays dismissed.
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
- **The default route stays on the app's own network** (`lib/incus/default-route-guard.ts`, YE-198). A connection
  interface sits on the peer's bridge, and Caddy has one interface on each app's bridge. Each of those bridges' DHCP
  leases carries its own gateway.
  - When an OCI container starts, Incus runs its DHCP client on every interface at once. Each client lists the
    default routes and then replaces the default with its own gateway, unless an interface with a smaller name holds
    it (`installDefaultRouteV4` in Incus's `forknet`). Side interfaces are named `eth-…`, which sorts before `eth0`,
    so a side lease that lands after eth0's takes the default. When two leases land together, both see no default
    and the last one wins. Until 0.6.20 a connected app's default route went through the peer's bridge after many
    restarts and reboots (3 of 7 on a test box), and so did Caddy's.
  - Renaming the interfaces is no fix because of that race: with names that sort after `eth0`, 5 of 8 restarts
    still went wrong.
  - The Control Panel watches Incus's lifecycle events (`lib/incus/incus-events.ts`, `default-route-watch.ts`).
    After each `instance-started` or `instance-restarted` of a container with side interfaces, it waits until
    `eth0` and each side interface hold an address, at most 40 s, and a side interface at most 10 s after `eth0`
    (one that gets no lease carries no default route; the later repair covers a late lease, YE-223). Then it repairs
    the routes, and once more 15 s later; when a side interface still had no lease, once more 30 s after that,
    past the 30 s Incus's DHCP clients try (YE-224). Two repairs of one start racing to add the `eth0` default are
    not a failure (only a default through `eth0` counts as added). Side interfaces are connection NICs with their grant's ACL, and Caddy's app NICs (`CADDY_APP_ACL`).
  - The repair removes any default route through a side interface. When none is left, it adds one through `eth0`, via
    the gateway of the container's own bridge. It never touches a route through `eth0`, and on a container whose routes
    are right it changes nothing. It acts only while `eth0` holds an address and the gateway is reached through `eth0`
    (`ip route get`: not so when the app's bridge was recreated on another subnet while the container keeps an old
    lease; then it changes nothing, says so once and tries again at the next start, YE-211), so it never leaves a
    container without the default route it had; a repair that fails is tried again three times, 30 s apart, and at the
    next sweep. A container without `ip` (or a shell) is skipped with one log line. While an operation of the Control
    Panel holds the container's app (an install, a restart, an update finished or rolled back at start), the guard
    waits, polling every 2 s, and repairs once the operation ends. It never acts on a container being replaced.
  - Incus's DHCP renewals never touch routes again, so one repair holds until the next start.
  - Each time the event stream opens (at every Control Panel start, and after a reboot, where Incus starts the apps
    first), a sweep repairs every running container that started since its last repair, and so do sweeps 5, 15 and 30 s
    later and then one every minute while the stream is up (YE-214). Since YE-207 the stream opens while Incus is still
    starting the apps: one that is not running yet at the first sweep, and whose start event came before the
    subscription was live, is caught by a later sweep, within a minute at most. A sweep acts only on a container whose
    start it has not repaired yet, so the later sweeps cost a list and a state read. The watch is the first thing the
    Control Panel starts. While the stream is down, the sweep runs every 30 s. A stream quiet for 5 minutes is pinged,
    and one that doesn't answer is reopened. A newly connected interface is checked right after it comes up.
  - An app operation's own starts are repaired by the operation itself (YE-220): an update's first start, a rollback's
    and a recovery's restart (`update-provider.ts` `startRuntime`, `verifyRestored`) call `repairAfterOperationStart`
    right after the container starts and before any readiness or health wait. The operation holds the app, and the
    event-driven repair waits for that hold to end, so before 0.6.20 a connected app whose start needs the internet
    (Bazarr, with Sonarr and Radarr) failed its health on the connection NIC's default route and rolled back. The repair
    is the same as every other start (leases waited for, eth0 never touched); its late check runs only while the
    container still runs that start, and a failure is logged without failing the operation. Starts and restarts outside
    an update (`youeye app start|restart`) return right after the start, and the event-driven repair follows when the
    lock is released.
  - Installed boxes heal with the update alone: at the first start of the new Control Panel. No device changes.
- **What each side's dashboard row lists** (`pushConnectionsToUI`, `lib/bridges/manager.ts`; the UI keeps it in
  `apps.connections`, read by the gateway's proxy route and `my-connections`). A connection appears on its consumer's
  row (the `from` app), with the managed-proxy transport for a `proxy:` connection. It appears on the provider's row
  (the `to` app) only for a both-ways network connection, as the consumer's host and port (no `url`, no
  `transport`). A one-way connection and any `proxy:` connection give the provider nothing to call, so its row
  lists nothing for them. Activation, deactivation, deletion and the 30-second reconcile all use this rule (since
  0.6.16; before, the reconcile also projected every connection onto its provider: for a `proxy:` connection that
  failed every 30 s, for a one-way network connection it wrote a reverse entry, which the next pass removes).
  Changing a connection's direction (`PATCH /api/bridges/<id>` with `direction`) adds or revokes the provider's
  grant to call the consumer back on an active network connection and pushes both rows (before 0.6.16 it changed
  only the record).
- **Connect setup files.** Every time a connection is activated (suggestion, bundle, the target of a waiting bundle
  connection installed later, or `/api/bridges`), the consumer's `connects[].setup` file (`for: connect:<app>`) runs
  with `${peer.*}` and `${self.*}` values. Its `target: peer` steps call the peer's main container. A failure is
  logged and does not undo the approval. Deactivating or deleting a connection first runs the file's `remove:`
  steps; a failure there is logged as well. Uninstalling an app runs the `remove:` steps of all its connections
  (the app as the consumer, and as the app another one connects to) before it stops the app, so they can reach
  both apps and read both apps' secrets; it then deletes the connections before the containers. Before 0.6.20
  the app was stopped first, so the steps failed (SABnzbd stayed in Sonarr's download clients, YE-199).
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

The CLI's progress stream is only a view: a dropped stream of a Market app's update (`unexpected EOF`, a reset, or
a stream that ends without `completed`, `failed` or `pending`) does not fail the command. It prints "Lost the live
progress; following the update…", then reads `GET /api/market/update/status?appId=<id>` every 3 s until the
update's returned `result` is there (the Control Panel records it as the update returns, in the stream's words;
see [app-update-transactions.md](app-update-transactions.md#entry-points)), and prints it: exit 0 only on success.
A commit is not the end: cleanup and access reconciliation follow it and can still fail, so a committed operation
is not reported before the result. The update is this one when its operation's id differs from the operation
before the request (or it was seen pending); an update that ended without an operation (already up to date,
refused) is this one when its result is newer than the one before. An update that returned with its operation
still pending (reopening or cleanup unfinished) ends the follow at once with exit 1 and its message, which names
`youeye app recover <id>`. If the Control Panel restarted (no result, and no update running), the follow reports
the operation record ("Update complete", rolled back or recovery required) and says the final result was not
recorded; with no new operation either, it names `youeye app info <id>`. It gives up after 30 minutes and names
`youeye app info <id>` and `youeye app recover <id>`. Built-in apps (Pointer, Caddy, Pi-hole, Postgres and
the core components; the status says `market: false`) have their own updaters and are not
followed: a lost stream is reported at once. A stream that ends in `pending` exits 1 too, and `--all` exits 1 when
any app's update did not succeed. `youeye app install <id>` follows a dropped stream the same way through
`GET /api/market/install-status?app=<id>` (the install is recorded before the stream opens) and ends with the
stream's "<name> installed successfully!"; `--url` installs are not followed (the app's id is in the manifest the
Control Panel reads).

- The new manifest comes from the app's recorded source, else the official Market (never another source): the same
  market, which must still be on and accepted and is refreshed first; or the URL of an Added app. Native apps are no
  exception (0.6.20). The update check asks the same source and never re-points an app (see
  [Markets and consent](#markets-and-consent)). Apps added by URL get update offers too.
- **An app whose source id now names another market address** than it recorded is not updated: the answer is 403
  `source-changed` (JSON) or an SSE `failed` event with `code: "source-changed"`, and the update check offers
  nothing and stores `updateBlocked { code, message }` on the installed-app record. Only an explicit switch in
  Settings → Apps → the app moves it to that source. An app whose market is gone gets `updateBlocked` `source-unavailable` ("no
  update source") the same way, and a native app installed from the channel whose market does not list it gets
  `not-in-market` ("No update source: <id> is not in the YouEye Market"; an update answers 409); it keeps running.
- **An app added by URL whose setup files changed** is not updated without `allowSetup: true` (`--allow-setup`; the
  update panel says "Setup steps changed" and asks). Nothing is changed before that: the answer is 409
  `setup-changed` (JSON) or an SSE `failed` event with `code: "setup-changed"`, both listing `setups`. The Added
  entry's stored manifest is replaced only after a successful update.
- Only a newer `version` is installed (`src/lib/version.ts`): a new image digest under the same version is never
  offered. An update that needs a newer YouEye is refused (`requires-newer-youeye`) and waits. Checks run 45 s after
  the CP starts and then every 6 hours (plus up to 10 % jitter), and ask the markets first; nothing is applied
  automatically.
- Before the change the update takes a checkpoint: scoped metadata, a stopped runtime copy of each container,
  Incus volume snapshots and a logical dump of the app's PostgreSQL database. OCI images are pinned to the fetched
  digest, containers are stopped, rebuilt (env and `files:` written again) and health-checked. A failure restores
  the checkpoint. Database migrations are the app's own, on first start.
- Refused: a changed container set (sidecars added, removed or renamed), changed storage (a `data:` path added or
  removed) and a changed database mode or name (`update-inventory.ts`). An update also fails when a new env value
  needs something the install never created: a new `${database|sso|identity|youeye|ai}.*` mapping that resolves
  empty (`update-configuration.ts`).
- **A secret new in the release** (in its `secrets:`, never declared by the installed version) is generated during
  the update (since 0.6.20, YE-208), per its spec, just before the configuration is written, so a new
  `${secret.<name>}` (say the admin password of an app moving to its own login) resolves. Each is one journal step
  (`generate-secret-<name>`); a rollback, also one resumed after a restart, deletes exactly those, never a secret the
  app had.
- **A secret the installed version already declared is never made again** (YE-217), also when it reads as missing,
  empty, whitespace only or unreadable: the app's data (an encryption key, a session secret) was made with the old
  value. An app installed before 0.6.3 kept its secrets at `app-<id>/<file>`, which the store
  (`app-<id>/secrets/<name>`) does not read. The update stops before changing anything:
  `installed-secret-missing`, naming the secret, never its value ("Restore the secret file, then update again").
- **The shown credentials are the new release's:** the install record's `credentials` is written from the new
  manifest's `credentials:` (Settings → Apps → Credentials, `GET /api/market/credentials`), and cleared when it has
  none; a rollback puts the previous ones back.
- Setup files do not run. Existing secrets, volumes, the YouEye ID client and the Pointer key are kept. A database
  sidecar keeps its running PostgreSQL (it is not rebuilt). The new manifest becomes the frozen copy, so changed
  setup files run later, from that copy: when sign-in is turned on or off, after an address change, and when a
  connection is activated.
- A native app is updated by version like any app, and by package: with the same `source.package.sha256` as the
  installed `standalone.tar` its manifest decides, not the version name. The same manifest is no update ("already up
  to date"); a new one that configures the app the same way (a new version name or `requires`) is taken record only,
  no download or restart (YE-194), once this box meets its `requires.youeye` and unless its version name is lower
  than the installed one (YE-212); one that configures it differently is an ordinary update of the same package. A
  new `standalone.tar` replaces `/opt/app` (see [native-apps.md](native-apps.md)). A native app installed from the
  channel before 0.6.20 first moves to its market the same way, record only, when the market pins the package it runs
  (the update check, 45 s after every start, and `youeye app update` do both).

## Start, stop and restart

`youeye app start|stop|restart <id>` and `POST /api/apps/<id>/control` with `{ action }` act on all of the app's own
containers and record the wanted state, so a stopped app stays stopped. Shared system services are not touched.

## Uninstall

`POST /api/market/uninstall` with `{ appId, keepData }` (in the UI: Settings → Apps → the app → Uninstall, also for an
app its market no longer lists). **The API keeps data by default; the CLI
`youeye app remove <id>` deletes it unless `--keep-data` is given.**

The uninstaller decides only from `install.json`. It first runs its connections' `remove:` steps while the app
still runs (see above; a failure never blocks the uninstall, also one of a step with `allow_failure` against the
other app, e.g. Sonarr stopped: it is returned in `warnings`, and `connectionsLeft`
`[{appId, name}]` names the apps that may still list it; Settings → Apps shows them after the uninstall, e.g.
"Sonarr may still list SABnzbd: remove it in Sonarr's settings.", and `youeye app remove` prints the same lines
after its success line, with the app's id for the removed app; YE-200), then stops the app's
containers, deletes its connections, then deletes containers by their recorded names and only when they carry this
installation's tag, routes
by exact host name, the OAuth client, DNS entries,
the CA directory, the dashboard registration and, last, the app network. Nothing is matched by name prefix.
An uninstall that does not complete after the `remove:` steps ran (for example the credential revocation fails, and
the app stays installed and stopped) marks its remaining active network connections `rewirePending` in the
connection record: they are still recorded active, but their wiring was undone. The periodic reconcile pass
(every 30 s, started and not awaited, one at a time) runs their connect files again and clears the mark once both
apps of a connection run, which also covers an app that came up by Incus autostart or kept running (YE-218). Each
re-wiring holds both apps' lifecycle locks and the bridge lock, like activation, so it never runs beside the peer's
uninstall or update; inside them it checks again that both apps run, reads the mark again and clears it only while
it is still set. The connect file gets at most 20 s there (its `wait:` steps included), so an app that runs but
doesn't answer holds the two apps for 20 s at most (YE-223). A busy app keeps the mark for the next pass; a wiring
that fails keeps it and is tried again after 30 s, then 1, 2, 4, 8, 16 min, then every 30 min. An app's start or
restart doesn't wire inline: it clears its connections' back-off and asks the re-wire watch (every 5 s, started at
Control Panel start apart from the reconcile round, which can return early) to start a pass, so they are wired within
seconds. The back-off and the requests are one state per process (`Symbol.for('youeye.bridge-rewire')` on
`globalThis`: Next bundles the module more than once), and a start during a failing try wins over that try's back-off
(YE-224). Retrying the uninstall deletes them as usual.

- **Delete data:** also removes the volumes, the secrets and `/var/lib/youeye/app-<id>/`, and drops the shared
  database and role, but only if this installation created them.
- **Keep data:** volumes, database and secrets stay; the admission record becomes `retained`. A later install
  can adopt the data only through the app's active owner (`adoptRetainedData`).

Left behind on purpose: the app's revoked gateway credential in `/var/lib/youeye/state/app-service-credentials/<id>/`
(no secret; it keeps the revision the UI expects, so a reinstall continues from it) and the operation record in
`/var/lib/youeye/networks/operations/<id>.json` (pruned 24 hours after the operation ends).

If any step fails, `install.json` stays with `cleanupPending: true`, the network lease is kept, and the next uninstall
or cleanup retries. Since 0.6.20 (YE-222):
- each container delete waits for the delete operation's own result (`metadata.status`, not just the reply), tries a
  failed attempt again (3 attempts in all) and gives a finished delete a few seconds to read back absent;
- the data (volumes), and with them the secrets, and the app's own shared database go only after every container is
  confirmed gone, and never while an instance uses a volume;
- the requested mode (keep-data or delete-data) is recorded on the network lease (its failure stage,
  `uninstall-keep-data` / `uninstall-delete-data`), at the start of every attempt on a lease an earlier attempt left
  pending and again when an attempt fails; the background network cleanup and Health's Fix finish the removal in
  that mode (a delete-data finish still refuses kept data). A `--keep-data` request records keep before it waits for
  the app's locks, and every mode write reads the lease inside the network write lock, so a keep asked last is never
  turned back into delete. The background cleanup reads the mode only once it holds the locks, and leaves the app
  alone while a removal request for it is running or waiting. A delete-data finish also removes the leftover
  `ye-retained-*` copies of an adopted keep-data reinstall. A container delete still running after its bounded waits
  is not sent again: the attempt ends unconfirmed and the next attempt retries. A `--keep-data` retry after a
  delete-data attempt that already deleted the containers has no copy of them to keep: it keeps the volumes and
  answers "The containers of <id> are already gone …; finish the removal with: youeye app remove <id> --force
  --keep-data" (the background cleanup leaves it the same way). One without a recorded mode (failed before this) is never finished on its own: it is left
  for `youeye app remove <id>` (with `--keep-data` to keep its data). Until it finishes, an install of that app is
  refused ("The removal of <id> did not finish; finish it first: …", the command following the mode);
- a fresh install refuses when this app's own volumes of an earlier installation are still there (and it is not a
  retained, keep-data app): "Data of an earlier <id> installation is still on this box (…); finish its removal
  first: youeye app remove <id> --force (deletes it)". It never takes such data over.

**A removal that stops after the revocation** (YE-225): the uninstall marks the record's service credential pending,
stops the app and revokes its credential before it deletes anything, so a failure from there on (the dashboard down, so
the revocation can't be published; a connection or container that won't go) leaves the app installed, stopped, with a
revoked credential. Revocation is final: a credential reconcile can't bring it back, and a new generation would need the
very dashboard publication that failed. Running the removal again finishes it, so that is what the app says: a start
answers "The removal of <id> did not finish and its service access is already revoked: remove it again to finish: youeye
app remove <id> --keep-data if you chose to keep its data, youeye app remove <id> to delete it (or Remove in Settings,
which asks)"; both forms, because the CLI deletes the data unless `--keep-data` is given and the stopped removal may
have kept it, the credential reconcile (`POST /api/market/credentials/<id>` with `reconcile` or `provision`) answers 409
`removal-unfinished` with the same text, and Settings shows that state instead of the Reconcile button (the Remove
section stays). It is recognised as the record pending while the store's credential was revoked by a revocation
(`operationKind` `revoke`, `lib/apps/unfinished-removal.ts`, read without the store's lock): only the uninstall and an
install's rollback leave that pair. A failed server restore also leaves a pending record with a revoked credential, but
its fence is `operationKind` `restore` and Reconcile recovers it, so it gets the ordinary Reconcile; a deliberate revoke
records `revoked`.

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

## Backups

The core backup carries the Market's own choices (`lib/backup/market-state.ts`): `market-sources.json` (the
markets, with their acceptance and the note about removed sources) and `state/direct-market-apps.json` (the apps
added by URL, with the manifest the owner agreed to), under `market/` in the core archive and listed in
`backup-meta.json` as `marketFiles`. A platform restore puts them back in its step `restore-market-sources` (an
empty list removes the target's files) and drops the copies of markets the restored list no longer names. Before
the restore changes anything it checks the files: each must be a JSON object, and `direct-market-apps.json` must
be `schemaVersion: 1` with an `entries` object of objects; otherwise the restore is refused. On the box, an empty
`direct-market-apps.json`, or one without an `entries` object (`{}`), reads as holding no apps. The backup
applies the same check when it takes the files, so it never holds one a restore would refuse: a store the box
reads as holding no apps is backed up as the empty store, and any other file that fails the check fails the
backup ("Refusing to back up <file>: …"). A backup
made before 0.6.11 has no `marketFiles` and leaves the box's files as they are. The market copies themselves
(`/var/lib/youeye/markets/`) are not backed up: a box reads them again. An installed app's frozen manifest is in its
app archive, as before.

## Tests

- **CP unit tests** in `control-panel/tests/`, run with `npm test` in `control-panel/`. Most relevant:
  `app-format.test.ts` (parser, validator, variables, digest, frozen copies), `setup-runner.test.ts` (step safety
  rules), `market-system-apps.spec.ts` (the pinned core images; a market that lists system items changes nothing;
  validates the whole `YE-AppMarket` checkout with the CP parser, set `MARKET_ROOT` if it is not next to `YouEye`),
  `identity-role-claim.test.ts`, `install-tracker-durable.spec.ts`, `image-fetch-retry.spec.ts` and the
  `market-*.spec.ts` files. For markets by address:
  - `market-store.spec.ts` (accepting: hash mismatch refused at each level, a lower `sequence` refused for the same
    address and accepted after an address change, an unreachable market keeps its state, a changed app fetches one
    bundle, refresh timing), `pinned-https.spec.ts` (public addresses, pinned DNS, no redirects, size limits);
  - `market-catalog.spec.ts` (the reader: too-new and unknown-kind entries listed, strict parse errors),
    `market-native-package.spec.ts` (a native app's package: size, SHA-256, archive), `update-native-move.spec.ts`
    (the move of 0.6.15/0.6.17 records), `channel-index.spec.ts`, `product-release.spec.ts`;
  - `market-image-proxy.spec.ts` (only named pictures, no fetch for anything else, headers and types);
  - `market-source-consent.spec.ts` (acceptance, the list edit, official by default, bundles, the source switch, the
    update check, removed sources and "no update source", URL apps' changed setup files),
    `market-update-routing.spec.ts`, `market-detail-sources.spec.ts` (the app page's variants and installed source);
  - `market-store-hardening.spec.ts` (the refresh deadline and the reader's wait, refreshes by source and address,
    nothing left behind by a failed attempt, `sequence` bounds and a wrong clock, picture fetch limits),
    `market-reader-hardening.spec.ts` (manifest id per entry, native apps from any market, the official lane setting, official
    lanes refused as custom markets, a store that cannot be shown, deadlines of apps added by URL);
  - `market-add-link.spec.ts` (the preview is a POST with the CSRF token, writes nothing and refuses non-admins;
    adding needs an admin session and the origin check; bad and over-long links; the sign-in redirect and its
    loop guard), `market-backup.spec.ts` (backups carry the sources and Added apps; a malformed Added-app store is
    refused, by the backup as by the restore);
  - `market-build.spec.ts`, `app-format-since.spec.ts`, `market-site.spec.ts`, `my-site.spec.ts` (the generator,
    the field-since table, the website and `sites/my`).
- **CLI:** `spine/internal/cmd/market_test.go` (request bodies and output of `youeye market …`).
- **Sign-in suite** `tests/market-sso/` (Playwright): signs in to each installed app once as a YouEye admin and once
  as a standard user and checks the app's own view of who is an admin. See its `README.md` for setup and saved
  sessions.
