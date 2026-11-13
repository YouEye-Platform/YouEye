# App manifest (`youeye.app.v1`)

Every app in the Market, every native app and Canvas is described by one `youeye-app.yaml`, optionally with
setup files next to it (`setup/*.yaml`). This is the only app format the Control Panel reads. The variables you can
use inside it are listed in [app-environment.md](app-environment.md).

- **One parser and validator:** `control-panel/src/lib/market/app-format/` (`parseApp`, `parseSetup`).
  Unknown fields and unknown `${…}` variables are errors before anything is created. Keys starting with `x-` are
  kept and never read.
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
                                 # compares X.Y.Z only, so 0.6.2-dev.1 already satisfies >=0.6.2
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

image: ghcr.io/mealie-recipes/mealie@sha256:36c2…   # OCI image, digest-pinned (required for Market apps)
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
data:                            # private volumes of the main container (named after the last path segment)
  - /app/data                    # short form: kind data
  - { path: /config, kind: config }       # kinds: data | config | media | cache (cache is not backed up)
shared:                          # shared folders, approved by the user at install (replaces storageGroup)
  media: /data                   # group name → mount path

env:                             # the main container's environment (sidecars have their own `env`)
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
                                 # access on (shown pre-selected; the owner can decline). Official catalog only;
                                 # an older Control Panel refuses this field, so the app is missing from its catalog

sidecars:                        # extra containers of the same app
  - name: redis                  # [a-z0-9-]; `main` is reserved for the app itself
    image: docker.io/valkey/valkey@sha256:…
    port: 6379
    data: [/data]
    env: {}
    command: [valkey-server, --save, "60", "1"]
    health: /health              # optional; or { postgres: <user> } (pg_isready as that user)

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

### Native apps
A native app replaces `image` with `source` and adds the dashboard surfaces:

```yaml
source: { node: "24" }           # node: one of 22 | 24; app_dir is always /opt/app
data_ownership: { per_user: identity_uuid }
capabilities: { widgets: true, settings_panel: true, notifications: true }
surfaces:                        # widgets, timeline cards, notifications, settings panels
  - { id: recent-notes, kind: widget, placement: dashboard, name: Recent Notes, embed: /embed/widget/recent-notes,
      size: { default: [25, 28], min: [18, 20], max: [45, 50] }, refresh: 300 }
proxy:                           # hosts the app may reach through the YouEye UI proxy
  - { host: api.open-meteo.com, paths: [/v1/forecast], methods: [GET], scope: service }
  - { host: "*.wikipedia.org", paths: [/w/api.php*] }   # one leading wildcard label is allowed
link_handlers: [{ type: note, description: Open a note, endpoint: /n, triggers: [note] }]
```

Surfaces also take `description`, `permissions`, `settings` (fields `{ key, type, label, … }`) and `triggers`;
`capabilities` takes `widgets`, `settings_panel`, `notifications` (`true` | `push`), `info_cards` and `events`.
The release's version replaces the manifest's `version` (the build stamps it; `0.0.0` in the repository is fine).
A native release carries only `youeye-app.yaml`: no setup files and no listing images.

The archive itself is the app's product release on the box's channel (see [releases.md](releases.md)); the
manifest never names a repository or branch.

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
- `http` paths are relative and go to the app's own containers; the runner builds the URL
  (`http://<container IP>:<port><path>`) and re-checks the path after `${…}` substitution. The container IP is
  used only when it lies inside the app's own network (the peer's for `target: peer`), is not the network's
  gateway and is not held by any other container. Redirects are never
  followed: a 3xx fails the step unless it is listed in `ok`. A response may be at most 4 MiB, a request takes at
  most 30 s.
- A whole file run (`steps:` or `remove:`) has 20 minutes, every step, wait and `for_each` item included; past it the
  run fails even where a step has `allow_failure`. A `for_each` acts on at most 500 items.
  In a `connect:<app>` file a step may set `target: peer` to call the connected app's API (its `${peer.*}` values
  are available); `exec`, `file` and `restart` always act on the app's own containers. Running anything inside
  another app is not possible.
- Values saved with `save` and the `set` keys are merged into null-prototype objects; `__proto__`, `constructor` and
  `prototype` are refused anywhere in a key path, in saved responses, `for_each` items and `${vars.…}` lookups.
- In an `if:` condition a value that was never saved is empty (`''`); elsewhere it fails the step.
- A failure names the file, the step and the path as the file wrote it (never the substituted values or a
  command's output, which may hold secrets). The full error chain goes to the CP log, redacted; the sign-in API,
  install and bundle progress show only generic messages.
- `api_key.secret` names one of the app's secrets (declared under `secrets:`, a `credentials[].password`, or used as
  `${secret.<name>}` in the manifest). The app is configured with that secret (e.g. Sonarr's `<ApiKey>` in a
  `files:` template, qBittorrent's admin password), so YouEye knows the key without reading files in the container.
  In a `connect:<app>` file `${peer.api_key}` is that secret of the connected app and `${self.api_key}` the
  consumer's own, each read from the installed app's secret store as its frozen manifest names it. An app
  without `api_key:` has no `${…api_key}` value, and a step that uses it fails.
- Setup files are listed in the install dialog. An app installed from a URL with setup files needs a second, explicit
  acknowledgement (`--allow-setup` on the CLI; `allowSetup` in the install API).
- An app added by URL is fetched over HTTPS from a public server only: the host is resolved first and every address
  must be public (no private, loopback, link-local, CGNAT, unique-local, multicast, reserved or cloud metadata
  address); the request connects to that checked address, redirects are refused and each file is at most 1 MiB.
- **Names:** a file for `sso`, `install` or `url-change` is `setup/<for>.yaml`; a `connect:<app>` file is named
  by the `connects[].setup` of that app. Any other file under `setup/` is an error, so every source (catalog,
  repository, URL) finds the same files.
- `install` runs once after the containers are healthy; `sso` runs after it when YouEye ID sign-in is on (an app
  whose SSO needs a setup file shows a "YouEye ID sign-in" toggle at install); `url-change` and `sso` run again after
  the box's address changes (for an app that is stopped then, when it is next started). A failing step fails the install (which is rolled back) unless it has
  `allow_failure`; after an address change failures are logged.
- The sign-in setting can change after install (Settings → Apps → the app → Overview, "YouEye ID sign-in"; or
  `GET`/`PUT /api/market/app/<id>/sign-in` with `{"enabled": …}`): on creates the OAuth client and runs `steps:`, off
  runs `remove:` and then deletes the client. It is offered for apps with `sso:` and a `setup/sso.yaml`.
- A `connect:<app>` file runs each time the connection is activated (approved from a suggestion, by a bundle,
  when the target of a waiting bundle connection is installed, or through `/api/bridges`), with both apps' frozen
  installed manifests. Its `remove:` steps run before the connection is deactivated or deleted. Uninstalling either
  app deletes its connections after stopping that app, so then only steps that neither run in nor call the
  uninstalled app can succeed. Failures are logged and never undo the connection change.
  It sees only `${app.*}`, `${secret.*}`, `${self.*}` and `${peer.*}`.

## Other kinds
- **Bundle** (`bundles/<id>/bundle.yaml`, `youeye.bundle.v1`): `id`, `name`, `description`, `icon`, `category`,
  `summary`, `members` (install order), `connections` (`{from, to, scope}`), `shared` (groups).
- **System app** (`system/<id>.yaml`, `youeye.system-app.v1`): `id`, `version`, `name`, `image` (digest-pinned),
  `health`.
- **Catalog** (`catalog.yaml`, `youeye.catalog.v1`): `categories`, `curation` (`spotlight`, `collections`) and
  `native: [ids]` (the native apps the Market shows; each comes from its own product release). Container apps,
  bundles and system apps are discovered from the folders `apps/<id>/youeye-app.yaml`, `bundles/<id>/bundle.yaml`
  and `system/<id>.yaml`; there is no hand-written app list.
- **Catalog index** (`catalog.json`, `youeye.catalog-index.v1`: `apps`, `bundles`, `system` id lists): only custom
  Market sources read it, because a repository read as raw files cannot list folders. Such a source writes it
  itself; the Market's own release does not need it.

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

## Translations (planned)
Store text may later be translated with `locales/<lang>.yaml` next to the manifest, overriding `listing:` keys only.
The folder name is reserved; nothing reads it yet.
