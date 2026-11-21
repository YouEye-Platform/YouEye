# App manifest (`youeye.app.v1`)

Every app in the Market, every native app and Canvas is described by one `youeye-app.yaml`, optionally with
setup files next to it (`setup/*.yaml`). This is the only app format the Control Panel reads. The variables you can
use inside it are listed in [app-environment.md](app-environment.md).

- **One parser and validator:** `control-panel/src/lib/market/app-format/` (`parse.ts`, `schema.ts`; then
  `compile.ts` turns the manifest into the engine's internal model). Unknown fields and unknown `${…}` variables
  are errors before anything is created. Keys starting with `x-` are kept and never read. Every YAML file is at
  most 1 MiB; aliases, duplicate keys and the keys `__proto__`, `constructor` and `prototype` are refused.
- **Installed apps keep a frozen copy** of `youeye-app.yaml` and their setup files, plus `install.json`
  (`/var/lib/youeye/app-<id>/install.json`, `schema: youeye.install.v1`, written atomically: `installationId`,
  `manifestDigest`, `sharedFolders` (the approved `shared:` groups), `installedAt`/`updatedAt`, and
  `cleanupPending` after a failed cleanup). Updates, repairs and uninstall read the frozen copy, never the live
  catalog. The frozen copy is read leniently (structure only), so tightening
  the validator later never orphans an installed app. Today the frozen copy (`youeye.frozen-app.v1`: manifest text,
  setup file texts, digest) is stored with the app's dashboard registration (`frozen` key) and copied into backups.
- **Digest:** the manifest digest is SHA-256 over the canonical JSON of the manifest **without `listing:`** plus
  the setup files. Editing store text never looks like an app change.

## The manifest

```yaml
schema: youeye.app.v1
id: mealie                       # 1–32 chars, [a-z0-9-], starts with a letter; unique on the box
version: 3.22.0                  # the app's own version (required)
name: Mealie
requires: { youeye: ">=0.6.2" }  # an older platform says "needs a newer YouEye" (never offered as an update);
                                 # compares X.Y.Z only, so 0.6.2-dev.1 already satisfies >=0.6.2. Required when
                                 # the app uses a newer field (see "Fields newer than the format" below)
# subdomain: …                    # default and normal case: the id. Set it only when upstream itself names a
                                 # different hostname for the app

listing:                         # store text only; not part of the digest
  tagline: Recipes, meal plans, and shopping lists in one place
  description: Recipe manager and meal planner with automatic import
  long_description: |
    Mealie is a self-hosted recipe manager …
  release_notes: Mealie 3.22.0 improves recipe import …
  category: productivity
  tags: [recipes, cooking]
  icon: utensils                 # Lucide icon name (fallback)
  icon_file: icon.svg            # file next to the manifest (relative; never a URL)
  screenshots: [{ path: screenshots/recipes.png, caption: Recipe library }]   # relative files; official upstream images
  website: https://mealie.io
  developer: Mealie contributors
  license: AGPL-3.0
  source_code: https://github.com/mealie-recipes/mealie
  support: https://github.com/mealie-recipes/mealie/discussions
  docs: https://docs.mealie.io/

image: ghcr.io/mealie-recipes/mealie@sha256:36c2…   # OCI image, pinned by digest (required; sidecars too)
port: 9000
health: /api/app/about           # or { path: /api/app/about, timeout: 120 }  (seconds; default 120)
                                 # healthy = 2xx, 3xx, 401 or 403 (market/health.ts): pick a route that needs
                                 # the app and its database, not one that only redirects to a login page
command: [/bin/bash, /kavita/config/youeye-entrypoint.sh]   # optional argv override
internet: true                   # outbound internet for the app's containers (default false)

database: postgres               # none (default) | postgres | { postgres: { name, user } } | { sidecar: db, name, user }
                                 # `postgres`: the shared YouEye PostgreSQL, database and user named after the id
                                 # with "-" → "_" (paperless-ngx → paperless_ngx). Any database gets the generated
                                 # secret db_password (${database.password}; a sidecar database uses it as well).
                                 # `{ sidecar: db, … }`: the app's own PostgreSQL in that sidecar (see below)
data:                            # private volumes of the main container (named after the last path segment)
  - /app/data                    # short form: kind data
  - { path: /config, kind: config }       # kinds: data | config | media | cache (cache gets no Incus volume
                                          # and is not backed up)
shared:                          # shared folders, approved by the user at install (replaces storageGroup)
  media: /data                   # group name → mount path

env:                             # the main container's environment (sidecars have their own `env`);
                                 # sso.env, ai.env and smtp.env are merged into it
  BASE_URL: ${app.url}
  DEFAULT_PASSWORD: ${secret.admin_password}
secrets:                         # optional; any ${secret.<name>} used is generated (password, 32 chars)
  admin_password: { length: 24 }
  jwt_secret: { kind: key, length: 64 }   # kinds: password | key | hex; length 8–256 (default 32)
                                 # password: `length` URL-safe base64 characters; key: `length` random bytes
                                 # as standard base64 (about 4/3 × length characters, may hold + / =);
                                 # hex: `length` random bytes as hex (2 × length characters)
credentials:                     # default accounts shown to the admin
  - { label: Admin Account, username: changeme@example.com, password: admin_password }

files:                           # files written into a container before it starts; the path must lie inside one
                                 # of that container's `data:` paths (not a cache)
  - { path: /kavita/config/youeye-entrypoint.sh, mode: "0755", dir_mode: "0700", template: | … }
                                 # container: main (default); mode default "0644", dir_mode default "0700"
                                 # a template using ${youeye.app_token} must be under /etc, mode 0600 or 0400

sso:                             # omit = no YouEye ID sign-in
  callback: /login               # a path on the app; may contain ${sso.slug}
  entry: /sso/OID/start/${sso.slug}       # optional "Sign in with YouEye" start path
  extra_callbacks:               # paths on the app, or custom-scheme URIs of the app's own clients
    - /oauth2/callback           # (never http(s) URLs: those would name another host)
    - app.immich:///oauth-callback
  backchannel_logout: /api/auth/backchannel-logout
  admin_group: admin             # group claim that marks admins (default: admin)
  # role_claim: { claim: immich_role, admin_value: admin, default_value: user }
  #                              # instead of admin_group: a per-app claim. YouEye ID sends it (in the ID token and
  #                              # userinfo) when the app requests the claim name as a scope: admin_value to YouEye ID
  #                              # admins, default_value to everyone else. Values are both strings or both lists
  #                              # (a list is sent as a JSON array, e.g. { claim: abs_roles, admin_value: [admin],
  #                              # default_value: [user] }). admin_group and role_claim exclude each other. The claim
  #                              # name is app-specific: standard claims and scopes (sub, email, groups, is_admin,
  #                              # openid, …) are refused.
  env:                           # how the app takes OIDC by env
    OIDC_CONFIGURATION_URL: ${sso.discovery_url}
    OIDC_CLIENT_ID: ${sso.client_id}
    OIDC_CLIENT_SECRET: ${sso.client_secret}
ai:                              # the app can use Pointer (AI Settings at install)
  env:
    OPENAI_BASE_URL: ${ai.openai_base_url}
    OPENAI_API_KEY: ${ai.api_key}
smtp:                            # the app sends mail with the box's mail settings
  env:
    SMTP_HOST: ${smtp.host}
    SMTP_PORT: ${smtp.port}
forward_auth: false              # the account-login gate in front of the app: false = off and not offered at install
                                 # (default: on unless the app has `sso:`); YouEye ID's access check always applies
public_access: true              # the app protects itself (its own password, PINs, accounts): install with public
                                 # access on (shown pre-selected; the owner can decline). Read only from the official
                                 # Market catalog; added sources and URL apps install household-only

sidecars:                        # extra containers of the same app
  - name: redis                  # [a-z0-9-]; `main` is reserved for the app itself
    image: docker.io/valkey/valkey@sha256:…
    port: 6379
    data: [/data]
    env: {}
    command: [valkey-server, --save, "60", "1"]
    health: /health              # optional; or { postgres: <user> } (pg_isready as that user)
  - name: worker                 # a worker that reads and writes main's files (YouEye 0.6.9+)
    image: ghcr.io/…@sha256:…
    data:
      - { path: /app/media, from: main }                      # main's data volume mounted at /app/media
      - { path: /data/users, from: main, main_path: /app/users }   # main mounts it at /app/users
    env: { … }                   # sidecars never inherit main's env: repeat what the worker needs

provides:                        # what other apps can connect to
  - { type: indexer, description: Indexer manager, port: 9696, scope: service }
connects:                        # connections this app can make (approved by the user or a bundle)
  - app: prowlarr                # or `type: indexer`
    name: Prowlarr
    description: Manage indexers for Sonarr in Prowlarr
    scope: service               # user | service (default user)
    setup: setup/connect-prowlarr.yaml    # optional; only for `app:` connections
    port: 9696                   # optional: the peer's port (default 8080)
    proxy: { paths: [/api/*], methods: [GET] }   # optional: what a UI-gateway connection may call
api_key: { secret: api_key }     # the secret that holds this app's API key (${peer.api_key} for peers)

api:                             # groundwork for the YouEye API/MCP server; optional
  base: /api
  spec: /openapi.json            # path | none
  auth:
    - { id: admin, principal: admin, scheme: bearer, provision: setup }
  identity: email

x-notes: {}                      # reserved; kept, never read
```

**`from: main`** mounts the same Incus volume in the sidecar: one volume, attached to two of the app's containers,
backed up and checkpointed once. It must name one of main's `data:` paths (not `kind: cache`, which is not a volume,
and not a `shared:` folder). With sidecars every container's runtime name is `app-<id>-<name>` (main becomes
`app-<id>-main`), and an update refuses container or storage topology changes, so adding a worker to an installed app
means removing and reinstalling it.

**An app's own database** (`database: { sidecar: db, name, user }`) is a PostgreSQL server in one of the app's
sidecars. An app update restores it from a snapshot of its volumes taken with the whole app cleanly stopped, never
from a dump ([app-update-transactions.md](app-update-transactions.md#databases)). So:

- its database files must be in that sidecar's own `data:` (at least one writable volume, mounted by no other
  container); an update refuses it otherwise;
- an update never changes its `image:` (`postgres-runtime-change-excluded`): the files open only with the same
  PostgreSQL version and extensions. A major-version change is not an app update;
- the compiled `backup.ownPostgres` (container, database, user) is for app backups only: they dump the database
  with the app's own login. Updates don't use it.

Another engine (MariaDB, MongoDB, Valkey) is a plain sidecar with `data:`; the app's env names its host and
credentials. Updates stop it cleanly, snapshot its volumes and restore them with the rest of the app, with no engine
code. Every container's PID 1 must end on the stop signal: an update stops each one cleanly and refuses to start
when one is still running after 60 s (120 s for a database; `writer-stop-timeout`).

### Native apps
A native app has `source:` instead of `image:` (exactly one of the two) and no sidecars. It can add dashboard
surfaces and reach the platform through the UI gateway:

```yaml
source: { node: "24" }           # node: 22 | 24; a Debian 12 system container, the app in /opt/app
data_ownership: { per_user: identity_uuid }
capabilities: { widgets: true, settings_panel: true, notifications: true }
surfaces:                        # kind: widget | info-card | timeline-card | notification | settings-panel
  - { id: recent-notes, kind: widget, placement: dashboard, name: Recent Notes, embed: /embed/widget/recent-notes,
      size: { default: [25, 28], min: [18, 20], max: [45, 50] }, refresh: 300 }
                                 # placement: dashboard | timeline | notification-center | app-settings | app-detail
proxy:                           # outside HTTPS hosts the app may reach through the UI gateway
  - { host: geocoding-api.open-meteo.com, paths: [/v1/search*], methods: [GET] }   # methods default [GET]
  - { host: "*.wikipedia.org", paths: [/w/api.php*] }   # one leading wildcard label is allowed
link_handlers: [{ type: note, description: Open a note, endpoint: /n, triggers: [note] }]   # endpoint default /
```

Surfaces also take `description`, `permissions`, `settings` (fields `{ key, type, label, … }`) and `triggers`;
`capabilities` takes `widgets`, `settings_panel`, `notifications` (`true` | `push`), `info_cards` and `events`
(platform event names delivered to the app). How native apps are built, released and talk to the platform is in
[native-apps.md](native-apps.md).

## Setup files (`setup/*.yaml`)

For what env vars can't do: SSO through an admin API or CLI, config files that must be edited after first start,
settings after a URL change, and connection wiring.

```yaml
schema: youeye.setup.v1
for: sso                         # sso | install | url-change | connect:<app>
steps:
  - wait: { http: /health, timeout: 120 }
  - http:
      method: POST
      path: /Users/AuthenticateByName    # always relative; the app's own containers only
      container: main                    # default main
      headers: { X-Emby-Authorization: 'MediaBrowser Client="YouEye"' }
      body: { Username: admin, Pw: "${secret.admin_password}" }   # an object/array body is sent as JSON
                                         # (Content-Type: application/json is set automatically)
      save: { token: AccessToken }       # response JSON path → ${vars.token}; "$" saves the whole body
      ok: [200, 204]                     # default: any 2xx
      allow_failure: false
  - http:                                # read-modify-write
      method: PUT
      path: /api/system-config
      headers: { Authorization: "Bearer ${vars.token}" }
      body_from: config                  # a value saved earlier
      set: { oauth.enabled: true, oauth.clientId: "${sso.client_id}" }
      if: { not_equals: ["${vars.config.oauth.clientId}", "${sso.client_id}"] }
                                         # also equals: [a, b], empty: "${vars.x}", not_empty: "${vars.x}"
  - http:                                # a form post (Content-Type: application/x-www-form-urlencoded)
      method: POST
      path: /api/system/settings/general
      form: { settings-sonarr-apikey: "${peer.api_key}", settings-general-use_sonarr: "true" }
                                         # values are substituted, then encoded; form excludes body/body_from/set
  - http:                                # once per matching item of a list
      method: DELETE
      path: /api/v3/downloadclient/${item.id}
      for_each: { path: /api/v3/downloadclient, where: { name: qBittorrent } }
                                         # items: identityProviders  (optional dotted path when the list is nested)
  - file: { container: main, path: /config/oidc.json, json: { issuer: "${sso.issuer}" } }  # json|yaml|ini|text
  - exec: { container: main, run: [php, occ, user_oidc:provider, youeye] }                  # argv only, never a shell
  - restart: main
  - sleep: 15
remove:                          # optional: undo steps, run when the feature is turned off (e.g. SSO)
  - exec: { run: [php, occ, user_oidc:provider:delete, youeye] }
```

**Rules (enforced by the runner):**
- Steps are idempotent: they run again when sign-in is turned on again and when the box's address changes
  (`url-change`). App updates do not run setup files.
- `http` paths are relative and go to the app's own containers (`method` defaults to `GET`); the runner builds the
  URL (`http://<container IP>:<port><path>`) and re-checks the path after `${…}` substitution. The container IP
  comes from the host side, never from the container: the NIC's DHCP lease matched by its MAC address
  (`appContainerAddress` in `control-panel/src/lib/incus/app-network.ts`). It must lie inside the app's own
  network (the peer's for `target: peer`) and must not be the network's gateway. Redirects are never followed: a
  3xx fails the step unless it is listed in `ok`. A response may be at most 4 MiB, a request takes at most 30 s.
- Limits (`SETUP_LIMITS` in `setup-runner.ts`): a whole file run (`steps:` or `remove:`) has 20 minutes, every
  step, wait and `for_each` item included; past it the run fails even where a step has `allow_failure`. A
  `for_each` acts on at most 500 items. `exec` defaults to 60 s and `wait` to 120 s (both take `timeout:` in
  seconds); `wait` probes every 2 s; `sleep` is 1–600 s.
  In a `connect:<app>` file a step may set `target: peer` to call the connected app's API (its `${peer.*}` values
  are available); `exec`, `file` and `restart` always act on the app's own containers. Running anything inside
  another app is not possible.
- Values saved with `save` and the `set` keys are merged into null-prototype objects; `__proto__`, `constructor` and
  `prototype` are refused anywhere in a key path, in saved responses, `for_each` items and `${vars.…}` lookups.
- In an `if:` condition a value that was never saved is empty (`''`); elsewhere it fails the step.
- A text `body:` (a YAML string) is sent as is and may not contain `${…}`: a substituted value holding `"` or `\`
  (a generated password can) would break it. Use `form:` for form posts and an object body for JSON. Needs YouEye
  0.6.9 (`requires: {youeye: ">=0.6.9"}` in `youeye-app.yaml`); installed copies are read leniently and keep working.
- A failure names the file, the step and the path as the file wrote it (never the substituted values or a
  command's output, which may hold secrets). The full error chain goes to the CP log, redacted; the sign-in API,
  install and bundle progress show only generic messages.
- `api_key.secret` names one of the app's secrets (declared under `secrets:`, a `credentials[].password`, or used as
  `${secret.<name>}` in the manifest). The app is configured with that secret (e.g. Sonarr's `<ApiKey>` in a
  `files:` template, qBittorrent's admin password), so YouEye knows the key without reading files in the container.
  In a `connect:<app>` file `${peer.api_key}` is that secret of the connected app and `${self.api_key}` the
  consumer's own, each read from the installed app's secret store as its frozen manifest names it. An app
  without `api_key:` has no `${…api_key}` value, and a step that uses it fails.
- Setup files are listed in the install dialog. An app added by URL has one confirmation that names its host, images
  and setup files; with setup files it must allow them (`--allow-setup` on the CLI; `allowSetup` in the install
  API). An update of such an app whose setup files changed is refused until they are allowed again
  (`youeye app update <id> --allow-setup`; see [market.md](market.md#markets-and-consent)). An update never
  runs setup files itself: the new files become the installed copy and run on the next sign-in change, address
  change or connection.
- An app added by URL is fetched over HTTPS from a public server only: the host is resolved first and every address
  must be public (no private, loopback, link-local, CGNAT, unique-local, multicast, reserved or cloud metadata
  address); the request connects to that checked address, redirects are refused and each file is at most 1 MiB.
  A file may take 20 s (5 s of silence end it earlier), and the manifest with all its setup files 60 s together
  (`url-app.ts`).
- **Names:** a file for `sso`, `install` or `url-change` is `setup/<for>.yaml`; a `connect:<app>` file is named
  by the `connects[].setup` of that app. Any other file under `setup/` is an error, so every source (catalog,
  repository, URL) finds the same files.
- `install` runs once after the containers are healthy; `sso` runs after it when YouEye ID sign-in is on (an app
  whose SSO needs a setup file shows a "YouEye ID sign-in" toggle at install); `url-change` and `sso` run again after
  the box's address changes (for an app that is stopped then, when it is next started). A failing step fails the install (which is rolled back) unless it has
  `allow_failure`; after an address change failures are logged.
- **`install` runs once in the life of the app's data**, so it is for first-run state inside the app's own data
  (its first account, default settings). An install whose data came back does not run it: a restore from a
  backup, and a reinstall over the data a keep-data uninstall left. What it would make exists, and apps refuse
  to make it twice (Memos answers 403 to a second first account). Anything a restored app still needs must be in
  `sso` or `url-change`, or in the manifest. `sso` does run then (every install makes a new YouEye ID client and
  secret), and there a failure does not undo the restore: it is logged and reported, the app keeps its data, and
  sign-in is applied again by turning it off and on (`installSetupPlan` in `setup-runner.ts`).
- The sign-in setting can change after install (Settings → Apps → the app → Overview, "YouEye ID sign-in"; or
  `GET`/`PUT /api/market/app/<id>/sign-in` with `{"enabled": …}`): on creates the OAuth client and runs `steps:`, off
  runs `remove:` and then deletes the client. It is offered for apps with `sso:` and a `setup/sso.yaml`.
- A `connect:<app>` file runs each time the connection is activated (approved from a suggestion, by a bundle,
  when the target of a waiting bundle connection is installed, or through `/api/bridges`), with both apps' frozen
  installed manifests. Its `remove:` steps run before the connection is deactivated or deleted. Uninstalling either
  app deletes its connections after stopping that app, so then only steps that neither run in nor call the
  uninstalled app can succeed. Failures are logged and never undo the connection change.
  It sees only `${app.*}`, `${secret.*}`, `${self.*}` and `${peer.*}`.

## Fields newer than the format

`youeye.app.v1` first shipped with YouEye 0.6.3. A field added later is unknown to older boxes, whose strict parser
refuses it. `control-panel/src/lib/market/app-format/since.ts` lists each such field with the first YouEye version
that reads it:

| Document | Field | Since |
|---|---|---|
| `youeye-app.yaml` | `public_access` | 0.6.4 |
| setup file | `steps[].http.form` | 0.6.9 |
| setup file | `remove[].http.form` | 0.6.9 |
| `youeye-app.yaml` | `sidecars[].data[].from` | 0.6.9 |

(`public_access` is 0.6.4: stable 0.6.3 is build 0.6.3-dev.20, made before the field.)

Variables work the same way (`VARIABLES_SINCE`): an older box refuses an unknown `${…}` name.

| Variable | Since |
|---|---|
| `${app.network_cidr}` | 0.6.15 |

- **Only fields newer than 0.6.11 need `requires`.** A market is read only by YouEye 0.6.11 or later
  (`OLDEST_MARKET_READER` in `since.ts`), and every such box knows the fields above, so these rows are kept as a
  record and the generator does not enforce them. For a row above 0.6.11, an app author who uses the field writes
  `requires: { youeye: ">=<since>" }` (or higher); the market generator refuses the app otherwise and says what to
  write (a missing `requires` counts as 0.6.3). A box below the version then lists the app as "Needs YouEye X.Y.Z or
  newer" from the market's index and never parses its manifest
  ([market-format.md](market-format.md#rules-that-keep-every-box-working)).
- **Whoever adds a field to `schema.ts`** adds its row in the same change, with the version of the release that
  first ships it (`tests/app-format-since.spec.ts` checks every row against the schema), and ships that YouEye
  release before any market uses the field.

## Other kinds
- **Bundle** (`bundles/<id>/bundle.yaml`, `youeye.bundle.v1`): `id`, `name`, `description`, `icon`, `category`,
  `summary`, `members` (install order), `connections` (`{from, to, scope}`), `shared` (groups).
- **Catalog** (`catalog.yaml`, `youeye.catalog.v1`): `categories`, `curation` (`spotlight`, `collections`) and
  `native: [ids]` (the native apps the Market shows, read from the official Market only; each comes from its own
  product release). Container apps and
  bundles are discovered from the folders `apps/<id>/youeye-app.yaml` and `bundles/<id>/bundle.yaml`; there is no
  hand-written app list. With `store.yaml` (the market's name and publisher) this is what the generator turns into
  a published market ([market-format.md](market-format.md)).
- **No system apps.** The images of Caddy, PostgreSQL and Pi-hole are pinned in the Control Panel
  (`control-panel/src/lib/infrastructure/system-images.ts`) and change only with a System release. No market
  carries them.

## Installed resources
- Every Incus instance, custom volume and network an install creates carries
  `user.youeye.installation_id=<installation id>` (instances and volumes also `user.youeye.app_id`).
  Uninstall and cleanup act only on the exact names in `install.json` and only on resources with that tag: a
  same-name container from something else is refused, never replaced or deleted, and cleaning up `foo` never
  touches `foo-bar` (no name-prefix matching anywhere, routes included).
- Container names are `app-<id>` (one container) or `app-<id>-<container>`. Because ids and container names both
  use `-`, app `foo` with sidecar `bar` and app `foo-bar` would share `app-foo-bar`: an install whose container
  names another installed or retained app already records (or that Incus already holds) is refused in preflight.
- Secrets live in `/var/lib/youeye/app-<id>/secrets/<name>` (directory 0700, files 0600); a secret name is
  `[a-z0-9_]{1,40}`, checked again where the file is opened.
- Uninstall with "delete data" removes the containers, volumes, network, the shared database and role (only if this
  installation created them), the OAuth client, the
  routes, the generated CA directory and the app's secrets. If a deletion fails the record keeps
  `cleanupPending: true` and the next uninstall or cleanup retries.
