# App environment: `${…}` variables

These are the only variables an app manifest or setup file may use (see [app-manifest.md](app-manifest.md)). They
come from one registry in code (`control-panel/src/lib/market/app-format/variables.ts`); this page is generated
from the same list. An unknown variable is a validation error, and a known variable without a value at install
time stops the install before anything is created.

| Variable | Value | Available |
|---|---|---|
| `${platform.domain}` | the box's domain (e.g. `sandy-spring.ui.bingo`) | always |
| `${platform.version}` | the installed YouEye release name | always |
| `${platform.locale}` | `en` | always |
| `${platform.timezone}` | `Europe/Prague` | always |
| `${platform.site_name}` | the box's display name | always |
| `${app.id}` | the app id | always |
| `${app.name}` | the app name | always |
| `${app.subdomain}` | the chosen subdomain | always |
| `${app.fqdn}` | `<subdomain>.<domain>` | always |
| `${app.url}` | `https://<subdomain>.<domain>` | always |
| `${app.internal_url}` | the main container's URL on the app network | always |
| `${sidecar.<name>.host}` | a sidecar's host name on the app network | sidecars |
| `${sidecar.<name>.url}` | `http://<host>:<port>` of a sidecar | sidecars with a port |
| `${secret.<name>}` | a generated secret (see `secrets:`) | always |
| `${database.url}` | `postgresql://user:password@host:port/name` | `database:` set |
| `${database.host}` / `.port` / `.name` / `.user` / `.password` | the parts | `database:` set |
| `${sso.slug}` | the app's OAuth client slug | `sso:` set |
| `${sso.issuer}` | the YouEye ID issuer | `sso:` set |
| `${sso.discovery_url}` | discovery document, reachable from the app network | `sso:` set |
| `${sso.authorize_url}` | browser authorize endpoint | `sso:` set |
| `${sso.client_id}` / `${sso.client_secret}` | the app's OAuth client | `sso:` set |
| `${sso.callback_url}` | `${app.url}` + `sso.callback` | `sso:` set |
| `${sso.logout_url}` | YouEye ID end-session endpoint | `sso:` set |
| `${sso.admin_group}` | the group that marks admins (default `admin`) | `sso:` set |
| `${identity.name}` | the identity provider's display name (`YouEye ID`) | always |
| `${identity.external_url}` / `${identity.internal_url}` | YouEye ID for the browser / for the app network | always |
| `${smtp.host}` / `.port` / `.user` / `.password` / `.from` / `.security` | the box's mail settings | `smtp:` set |
| `${ai.openai_base_url}` / `${ai.anthropic_base_url}` / `${ai.google_base_url}` | Pointer's gateway endpoints | `ai:` set; manifest only |
| `${ai.api_key}` | the app's Pointer key | `ai:` set; manifest only |
| `${ai.default_model}` / `${ai.utility_model}` | models chosen by the owner | `ai:` set; manifest only |
| `${youeye.gateway_url}` | the YouEye app gateway (native apps) | always |
| `${youeye.app_token}` | the app's gateway token | manifest only |

**Setup files only:**

| Variable | Value |
|---|---|
| `${vars.<name>…}` | a value saved by an earlier step (`save:`); dotted paths go into it |
| `${item.<field>}` | the current item of a `for_each` step |
| `${peer.id}` / `${peer.host}` / `${peer.url}` / `${peer.api_key}` | the connected app, in a `connect:<app>` file |
| `${self.host}` / `${self.url}` / `${self.api_key}` | this app as seen by a peer, in a `connect:<app>` file |

A `connect:<app>` file sees only `${app.id}`, `${app.name}`, `${app.subdomain}`, `${app.fqdn}`, `${app.url}`,
`${secret.*}`, `${self.*}` and `${peer.*}` (plus `vars`/`item`); the consumer's address as the peer reaches it is
`${self.url}`. "always" above means every manifest and install, sso or url-change setup file. "Manifest only"
names are refused in setup files: those also run again later (after an address change, when sign-in is turned on),
where there is no gateway token or Pointer key to give them. The validator refuses a name a file cannot get.

Where a value comes from:
- `${database.*}`: `database: postgres` is the shared YouEye PostgreSQL (name and user default to the app id with
  `-` → `_`); `{ sidecar: db, … }` is the app's own sidecar (its host, port 5432). The password is the app's
  generated `db_password` secret in both cases.
- `${sso.*}` values are empty while YouEye ID sign-in is off for the app; `${ai.*}` likewise while AI Settings are off.
- `${secret.<name>}`: every name used anywhere in the manifest or its setup files is generated (a 32-character
  password unless `secrets:` says otherwise; for `key` and `hex` secrets `length` counts random bytes, not
  characters, see [app-manifest.md](app-manifest.md)) and kept across updates.
- In a manifest, `${…}` inside `listing:` and `x-` keys is not checked (it is never substituted).

Removed names (no longer accepted): `${secrets.*}`, `${containers.*}`, `${integration.*}`, `${install.*}`,
`${container.ip}`, `${container.port}`, `${wire.*}`, `${installParams.*}`, `${database.dsn}` (use `${database.url}`),
`${platform.locale_full}`, `${platform.proxy_ip}`, `${ai.enabled}`, `${ai.group_id}`, camelCase `identity.*`/`ai.*`
names.
