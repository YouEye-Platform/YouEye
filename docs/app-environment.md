# App environment: `${…}` variables

These are the only variables an app manifest or setup file may use (see [app-manifest.md](app-manifest.md)). They
come from one registry in code (`control-panel/src/lib/market/app-format/variables.ts`); the test
`control-panel/tests/app-format.test.ts` checks that the tables below list exactly the registry's names. Values are
built in `control-panel/src/lib/market/platform-env.ts` (`buildCanonicalContext`).

The validator refuses an unknown name, and a name the file cannot get (for example `${database.url}` without
`database:`, or `${sidecar.redis.url}` for a sidecar without a port), before anything is created.

| Variable | Value | Available |
|---|---|---|
| `${platform.domain}` | the box's domain (e.g. `sandy-spring.ui.bingo`) | always |
| `${platform.version}` | the YouEye version Spine reports | always |
| `${platform.locale}` | the box language setting (default `en`) | always |
| `${platform.timezone}` | the time zone in the CP's `/etc/timezone` (default `UTC`) | always |
| `${platform.site_name}` | the box's display name (default `YouEye`) | always |
| `${app.id}` | the app id | always |
| `${app.name}` | the app name | always |
| `${app.subdomain}` | the chosen subdomain (default: the manifest's `subdomain:`, else the id) | always |
| `${app.fqdn}` | `<subdomain>.<domain>` | always |
| `${app.url}` | `https://<subdomain>.<domain>` | always |
| `${app.internal_url}` | `http://<main container>.youeye:<port>` | always |
| `${sidecar.<name>.host}` | a sidecar's host name, `app-<id>-<name>.youeye` | sidecars |
| `${sidecar.<name>.url}` | `http://<host>:<port>` of a sidecar | sidecars with a port |
| `${secret.<name>}` | a generated secret (see `secrets:`) | always |
| `${database.url}` | `postgresql://user:password@host:5432/name` | `database:` set |
| `${database.host}` / `.port` / `.name` / `.user` / `.password` | the parts | `database:` set |
| `${sso.slug}` | the app's OAuth client id, `youeye-app-<id>` | `sso:` set |
| `${sso.issuer}` | the client's issuer on the app network, `http://id.youeye:3002/application/o/<slug>/` | `sso:` set |
| `${sso.discovery_url}` | `<issuer>.well-known/openid-configuration` (app network) | `sso:` set |
| `${sso.authorize_url}` | browser authorize endpoint (YouEye ID's external URL) | `sso:` set |
| `${sso.client_id}` / `${sso.client_secret}` | the app's OAuth client | `sso:` set |
| `${sso.callback_url}` | `${app.url}` + `sso.callback` | `sso:` set |
| `${sso.logout_url}` | YouEye ID end-session endpoint for this client (external URL) | `sso:` set |
| `${sso.admin_group}` | the group that marks admins (`sso.admin_group`, default `admin`) | `sso:` set |
| `${identity.name}` | the identity provider's display name (default `<site name> ID`) | always |
| `${identity.external_url}` / `${identity.internal_url}` | YouEye ID for the browser / for the app network | always |
| `${smtp.host}` / `.port` / `.user` / `.password` / `.from` / `.security` | the box's mail settings (`security`: `starttls` or `none`) | `smtp:` set |
| `${ai.openai_base_url}` / `${ai.anthropic_base_url}` / `${ai.google_base_url}` | Pointer's inference doorway, `http://<gateway>:3003` (`/v1` for OpenAI) | `ai:` set; manifest only |
| `${ai.api_key}` | the app's Pointer key | `ai:` set; manifest only |
| `${ai.default_model}` / `${ai.utility_model}` | the aliases `default` / `utility` (first / third model of the chosen group) | `ai:` set; manifest only |
| `${youeye.gateway_url}` | the UI gateway, `http://<gateway>:3001/api/apps/v1` (native apps) | always |
| `${youeye.app_token}` | the app's gateway token | manifest only |

`<gateway>` is the app network's gateway address, where the Control Panel opens Incus proxy devices ("doorways")
to the system services: `:3001` the UI, `:3002` YouEye ID, `:3003` Pointer inference, `:5432` PostgreSQL
(`getSystemServices` in `control-panel/src/lib/incus/app-network.ts`).

**Setup files only:**

| Variable | Value |
|---|---|
| `${vars.<name>…}` | a value saved by an earlier step (`save:`); dotted paths go into it |
| `${item.<field>}` | the current item of a `for_each` step |
| `${peer.id}` / `${peer.host}` / `${peer.url}` / `${peer.api_key}` | the connected app, in a `connect:<app>` file |
| `${self.host}` / `${self.url}` / `${self.api_key}` | this app as seen by a peer, in a `connect:<app>` file |

## Where each name may be used

- "always" means every manifest and every `install`, `sso` or `url-change` setup file.
- "Manifest only" names are refused in setup files. Setup files also run later (after an address change, or when
  sign-in is turned on), when there is no gateway token or Pointer key to give them.
- A `connect:<app>` file sees only `${app.id}`, `${app.name}`, `${app.subdomain}`, `${app.fqdn}`, `${app.url}`,
  `${secret.*}`, `${self.*}` and `${peer.*}` (plus `vars` and `item`). The consumer's address as the peer reaches
  it is `${self.url}`.
- `${…}` inside `listing:` and `x-` keys is not checked and never substituted.

## Where the values come from

- `${database.*}`: with `database: postgres` (or `{ postgres: { name, user } }`) it is the shared YouEye PostgreSQL,
  reached at the app network's gateway; name and user default to the app id with `-` → `_`. With
  `{ sidecar: db, … }` it is the app's own sidecar (its host, port 5432). The password is the app's generated
  `db_password` secret in both cases.
- `${sso.*}`: while YouEye ID sign-in is off for the app, the client values (`client_id`, `client_secret`,
  `issuer`, `discovery_url`, `authorize_url`, `logout_url`) are empty strings.
- `${ai.*}`: every value is empty while AI Settings are off for the app.
- `${secret.<name>}`: every name used anywhere in the manifest or its setup files is generated once and kept
  across updates and reinstalls (a 32-character password unless `secrets:` says otherwise; for `key` and `hex`
  secrets `length` counts random bytes, see [app-manifest.md](app-manifest.md)).
- `${identity.internal_url}`: `http://id.youeye:3002` for an app with a YouEye ID client, otherwise
  `http://<gateway>:3002`.

Old names such as `${secrets.*}`, `${container.ip}`, `${database.dsn}` or camelCase `identity.*`/`ai.*` are not in
the registry, so the validator refuses them like any unknown name.
