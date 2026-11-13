# YouEye ID

YouEye ID is the box's OpenID Connect provider. It signs people in to the dashboard, the Control Panel and every
Market app. There is no external identity product: the code is `control-panel/src/lib/identity/` and the routes
under `control-panel/src/app/{application,oauth,identity,forward-auth}/`.

## Where it runs

- The Control Panel bundle (`/opt/app` in the `youeye-control` container) runs twice:
  - `youeye-control.service` on port 3000 (the Control Panel);
  - `youeye-id.service` on port 3001 with `IDENTITY_SERVICE=true` (YouEye ID).
- In identity mode, `middleware.ts` allows only the identity routes (`/identity/*`, `/application/o/*`, `/oauth/*`,
  `/forward-auth/caddy`, the favicon). `instrumentation.ts` starts only the back-channel logout sender there; the
  platform jobs (health monitor, update queue, …) run in the Control Panel process only.
- The public host is `<subdomains.identity>.<domain>` from `youeye.yaml` (setup proposes `id`). It must differ from
  the dashboard host. The issuer base is `https://<identity host>` (`lib/identity/config.ts`).
- Data lives in the platform PostgreSQL (`youeye-postgres`, database `youeye`): tables `identity_*` (users,
  clients, sessions, codes, refresh tokens, consents, signing keys) and `admission_*` (who may open which app).
  Schema creation is in `lib/identity/store.ts` and `lib/admission/schema.ts`.

## Accounts

- Usernames: 3–32 characters of `[a-z0-9._-]`, starting with a letter (`username-policy.ts`). Passwords: 8–256
  characters (`password-policy.ts`), stored as scrypt hashes.
- A person is an admin when `is_admin` is set or they are in the group named exactly `admin`
  (`isIdentityAdmin` in `tokens.ts`). Making someone an admin adds `admin`; a user with no groups gets
  `youeye-users`. The People API (`/api/people`) changes the admin flag only; it has no free-form group editor.
- The first owner is recorded by the appliance claim (`identity_appliance_claim`). The owner and recovery access
  cannot be deleted or disabled.
- Deleting or disabling a user goes through one store transaction that also checks app data disposition and
  suspends the user in Pointer (`provider.ts` `updateUser`/`deleteUser`; details in
  [app-admission.md](app-admission.md)).
- The sign-in page is `/identity/login`. It allows 10 attempts per IP and username per 15 minutes.

## Clients

Every OAuth client is a row in `identity_clients` (`ensureClient`). Kinds:

| Client ID | Who | Notes |
|---|---|---|
| `youeye-control` | Control Panel | callbacks `/api/auth/callback` and `/settings/api/auth/callback`; Spine writes its SSO env |
| `youeye-ui` | dashboard | callback `/api/auth/callback` on the dashboard host |
| `youeye-app-<appId>` | a Market app with `sso:` | created at install or when sign-in is turned on (`lib/market/sign-in.ts`) |
| `youeye-public-<uuid>` | a native client added by an admin | public (no secret), PKCE required, HTTPS or loopback redirects only (`/api/identity/public-clients`) |

- The two core clients are first-party: no consent screen. They are (re)created by
  `POST /api/identity/core-clients` (`core-clients.ts`).
- App clients get the scopes `openid profile email groups`, plus the app's role claim name when the manifest has
  `sso.role_claim`.
- A client may register a back-channel logout URI. It must be HTTPS on a managed host whose origin is a registered
  redirect, or the app's private `http://app-<id>.youeye:3000` (`http://youeye-ui.youeye:3000` for `youeye-ui`)
  (`createOAuthClient` in `provider.ts`).

## Endpoints

All paths are on the identity host. The app-facing ones are per client, so each app has its own issuer.

| Path | Purpose |
|---|---|
| `/application/o/<clientId>/.well-known/openid-configuration` | discovery for one client |
| `/application/o/authorize/` (also `/oauth/authorize`) | authorization code flow |
| `/application/o/token` (also `/oauth/token`) | `authorization_code` and `refresh_token` grants |
| `/application/o/userinfo` (also `/oauth/userinfo`) | claims for a bearer access token |
| `/application/o/revoke` | revoke an access or refresh token |
| `/application/o/<clientId>/end-session/` | RP-initiated logout |
| `/oauth/jwks` | public signing keys (RS256) |
| `/identity/session/check` | session check for native apps (client ID and secret in headers) |
| `/forward-auth/caddy` | Caddy's admission check for app hosts |

Rules (`application/o/authorize/route.ts`, `token/route.ts`):

- Only `response_type=code`. `openid` must be in the scope, and every scope must be one the client has.
- The redirect URI must match a registered one exactly.
- PKCE: `S256` only. Clients without a secret must use it.
- Client authentication: `client_secret_basic` or `client_secret_post`.
- Access and ID tokens live 1 hour. Refresh tokens rotate on every use and are issued only for a sign-in that has a
  YouEye ID session.
- Admission is checked at authorize, at code redemption, at refresh and on every userinfo call. A refused user gets
  `access_denied` back at the app's redirect URI.

### Issuer and the app network

- An app client's issuer is `http://id.youeye:3002/application/o/<clientId>/`. `id.youeye` resolves, on each app's
  own bridge, to that app's gateway, where an Incus proxy device forwards port 3002 to YouEye ID on 3001
  (`issuer.ts`; `lib/incus/app-network.ts`). The app never needs public DNS or the box's CA to talk to YouEye ID.
- Discovery splits the endpoints: `authorize` and `end_session` always use the public host (the browser goes
  there); `token`, `userinfo`, `jwks` and `revoke` use `id.youeye:3002`. An app that reads discovery through the
  public host gets public back-channel endpoints instead; the issuer stays the same.
- The core clients use the public issuer `https://<identity host>/application/o/<clientId>/`.

## Tokens and claims

- ID and access tokens are RS256 JWTs. The key is generated on first use and kept in `identity_secrets`.
  `POST /api/identity/signing-key/rotate` makes a new key; retired keys stay in JWKS for 48 hours.
- Access tokens: `typ: at+jwt`, audience `youeye-userinfo`, with `client_id`, `scope` and the session ID.
- ID token and userinfo claims (`oauthClaims` in `tokens.ts`, `userinfo` in `http.ts`):

| Claim | Value |
|---|---|
| `sub` | the user's UUID (stable; usernames can change) |
| `preferred_username`, `name`, `given_name`, `family_name`, `email` | from the account |
| `email_verified` | always `true` (YouEye sets the email) |
| `groups` | group names, e.g. `["admin"]` |
| `is_admin` | `true` for YouEye ID admins |
| role claim | only for apps with `sso.role_claim`, see below |

### Admins in apps

- Most apps map admins from the `groups` claim. The manifest's `sso.admin_group` (default `admin`) is passed to the
  app as `${sso.admin_group}`.
- An app that needs its own claim declares `sso.role_claim: { claim, admin_value, default_value }`. When the app
  requests the claim name as a scope, YouEye ID adds it to the ID token and userinfo: `admin_value` for YouEye ID
  admins, `default_value` for everyone else. A list value is sent as a JSON array.
- A role claim may not use a reserved name (`sub`, `groups`, `is_admin`, `email`, the other standard claims and
  scopes; `reserved-claims.ts`). The manifest validator refuses it, and `roleClaims()` never sends it.

## Sessions and sign-out

- Signing in sets the `ye-id-session` cookie on `.<domain>` (HttpOnly, SameSite=Lax). It carries a session ID in
  `identity_sessions`. A session ends after 7 days idle or 30 days in total (`store.ts`).
- The Control Panel and the dashboard have their own session cookies on top (`ye-session` in the Control Panel).
  Each sign-in attempt uses its own short-lived OAuth transaction cookie, so parallel sign-ins in several tabs or
  iframes do not collide.
- `end-session` revokes the YouEye ID session, clears the cookie and queues back-channel logout. A
  `post_logout_redirect_uri` must be registered for the client; an `id_token_hint` must match the current session.
- Back-channel logout (`backchannel-logout.ts`): every client the session signed in to that registered a logout URI
  gets a signed `logout_token` (with `sid` and the back-channel event) by POST. Deliveries sit in a database queue;
  `youeye-id.service` sends due ones every 30 seconds and retries with exponential backoff (up to 1 hour apart) until
  the app answers `204`, at most 10 attempts within 23 hours (`lib/identity/store.ts`). A delivery is
  dropped if the client or its URI changed meanwhile. For app clients, an HTTPS URI is delivered straight to the
  app's primary container on its own network, at an address the host checks.
- **Sign out everywhere** (Settings → Profile; `POST /api/identity/sign-out-everywhere`) needs the current
  password. It queues logout for all of the user's sessions and revokes them.
- Apps with their own session can stay signed in until their session ends. Back-channel logout and native session
  checks make this faster where the app supports them; nothing forces every app to sign out at once.

## Who may open an app (admission)

Each installed app has one admission policy (`shared/admission.ts`, `lib/admission/`):

- **Mode:** `owner` (default for every new install), `all_users`, `groups` or `users`. The installing admin is the
  owner and is always admitted. Being an admin does not admit anyone by itself.
- **Public access:** when on, Caddy lets anyone reach the app's URLs without a YouEye ID session. It is for apps
  that protect themselves. A manifest from the official catalog can set `public_access: true`; the install then
  shows it pre-selected and applies it once the app is healthy (audited as `public_access_at_install`). Apps from
  added sources or URLs, and bundle members, install without it.
- Inactive or deleted users are always refused. Pending, quarantined, malformed or missing policies refuse.
- Change it in the app's Market settings or with `GET`/`PUT /api/market/apps/<id>/access` (admin, CSRF, current
  revision). The old forward-auth toggle `POST /api/market/forward-auth` is refused (`409`).
- The core clients only need an active user. A client with no admission mapping is refused.

The full contract (revisions, UI projection, retained data, backup) is in [app-admission.md](app-admission.md).

### The forward-auth check

Every app route in Caddy first calls `/forward-auth/caddy` on YouEye ID (`lib/identity/forward-auth.ts`):

1. Caddy strips any incoming `X-YouEye-*` headers.
2. The host and path select the app's admission route. No match → `403`.
3. An exact registered machine callback (a native app's back-channel logout POST) passes.
4. If public access is on and applied, the request passes.
5. Otherwise the request needs a live `ye-id-session`. No session → redirect to `/identity/login`. Not admitted →
   `403` (`503` while the policy is pending).
6. Admitted requests get `X-YouEye-Username`, `-Groups`, `-Email`, `-Name` and `-Uid` from YouEye ID.

Decisions are cached briefly in the process; the cache key includes the policy revision, so a policy change takes
effect at once. WebSocket upgrades get the same check.

## How apps are wired

The Market does the wiring from the manifest; see [market.md](market.md) (Sign-in section),
[app-manifest.md](app-manifest.md) (`sso:`, `forward_auth`, `public_access`) and
[app-environment.md](app-environment.md) (`${sso.*}`). In short:

- **Env:** the app takes OIDC from environment variables (`sso.env` with `${sso.client_id}`,
  `${sso.client_secret}`, `${sso.discovery_url}` …). Sign-in is always on.
- **Setup file:** `setup/sso.yaml` configures OIDC through the app's API, CLI or a config file. Sign-in can be
  turned on and off (`GET`/`PUT /api/market/app/<id>/sign-in`); off runs `remove:` and deletes the client.
- **No `sso:`:** the app keeps its own accounts. It is still behind the forward-auth check.

An app with `sso:` gets an Incus proxy device to YouEye ID (gateway port 3002), egress to it, and the Caddy root CA
in its OCI containers. The first time a user opens an app client, YouEye ID shows a consent page with the scopes
and any runtime permissions. Consent is stored per user and client and asked again only for new scopes.
A signed-in user reads or withdraws their own consent with `GET`/`DELETE /api/identity/consents/app/<appId>`.

## Changing the domain or identity host

`POST /api/identity/route` or the domain change in Settings runs the server rename (`lib/reconfigure`). App
clients and URLs are updated by the normal reconfigure steps. Pointer keeps a trust record of the issuer, so the
rename first checks that the installed Pointer has its identity-transition command
(`lib/pointer/identity-transition.ts`). If not, or if Pointer's stored identity is unexpected, the rename stops
before any change. During the identity stage the CP changes settings and routes, runs Pointer's transition, writes
its env and checks readiness. If that stage fails, the CP restores the old settings and routes and reverses the
transition. Later DNS, certificate and app steps are not part of that rollback. Never repair a failed rename by
deleting Pointer's database.

## Sign-in return addresses

After sign-in, `/identity/login` returns to the form's `return_to`, else the query's `return_to`, else the
dashboard (`lib/identity/login-return.ts`). A return URL must be HTTPS on the identity host, the dashboard host or
the bare domain, with no credentials or fragment. Anything else falls back to the dashboard; it never becomes an
open redirect. The identity host's `/` also goes to the dashboard. Sign-in pages are sent with
`Cache-Control: no-store`. When debugging a failed return, record paths and whether the return field was present;
never record passwords, cookies, OAuth state or codes.

## Admin and test endpoints

- `POST /api/identity/pilot` (admin, CSRF): creates a user and a client in one call, for tests.
- `POST /api/identity/core-clients`: re-creates the Control Panel and dashboard clients and their SSO env.
- `POST /api/settings/identity-provider` (admin) with `{ "identity_name": "…" }`: the display name shown on sign-in
  pages (`identity.name` in `youeye.yaml`; default `<site name> ID`). `identity.provider` must be `youeye-id`; it
  is the only provider.
