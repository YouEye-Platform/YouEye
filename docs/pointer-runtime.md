# Pointer (YouEye AI)

Pointer is YouEye's AI service: provider accounts, model groups, per-app keys and an OpenAI/Anthropic/Google
compatible inference API. Its code is the separate **Pointer** repository; on a box it runs as the `pointer`
product of the channel, managed by the Control Panel (CP). The CP side lives in `control-panel/src/lib/pointer/`.

## The container

| | |
|---|---|
| Container | Incus system container `youeye-pointer` from `images:debian/12` (`pointerContainerSpec` in `src/lib/infrastructure/manifests.ts`) |
| Program | `/opt/pointer/bun /opt/pointer/server.js` as `youeye-pointer.service`, env file `/etc/youeye-pointer.env` |
| Listeners | `4001` management (CP only), `4002` inference |
| Database | `pointer` in the shared YouEye PostgreSQL |
| State | host `/var/lib/youeye/pointer/runtime` (mode 0700) mounted at `/var/lib/pointer`; engine homes in `/var/lib/pointer/engine` |

**Install.** Pointer needs the box's domain, so the CP deploys it when the setup wizard runs
(`configurePointerForPlatform` in `src/lib/infrastructure/deployer.ts`, called from `/api/setup/run`). It resolves
product `pointer` from the box's channel index (`deployPointerContainerFromConfiguredSource`). The release has two assets:
`standalone.tar` and `pointer-build-contract.json`, whose SHA-256 must equal the build's `contract_sha256`. The
archive is checked like a native app's (`stageVerifiedProductArtifact` in `src/lib/market/native-artifact.ts`),
deployed, configured and started; only a healthy service gets an installed receipt. An older build than the
installed one is refused (no downgrade).

**Configure** (`configurePointerService` in `lifecycle.ts`), at install, after a Pointer update, after a full
restore and when the box's domain changes (`src/lib/reconfigure/`):
1. Install the box's Caddy root CA and point the public YouEye ID host name at Caddy with one managed line in
   `/etc/hosts` (marked `# youeye-managed-pointer-identity`). Unrelated lines are kept; an unmanaged line for the
   same name is refused. JWKS is still fetched over HTTPS with normal certificate and issuer checks.
2. When the issuer changed, run `transition-managed-identity.js` in the container (see Identity below).
3. Write `/etc/youeye-pointer.env` (database URL, secrets, ports, `PLATFORM_ISSUER`, `PLATFORM_JWKS_URL`,
   `PLATFORM_AUDIENCE`, build identity, `POINTER_ENGINE_STATE_DIR=/var/lib/pointer/engine`).
4. Run `/opt/pointer/migrate.js --expect-database pointer`, then enable and restart the service.

**Storage.** `ensurePointerStorage` (`storage.ts`) attaches the state directory as disk device `pointer-state`. It
refuses to mount over a non-empty `/var/lib/pointer/engine` that is not already that device, so engine files are
never hidden.

## Database schema

The Pointer repository has one migration, `apps/server/drizzle/0001_baseline.sql`; it is schema version **1**
(`LATEST_POINTER_SCHEMA_VERSION` in `apps/server/src/db/latest-schema.mjs`). Every applied version is recorded in
`pointer_schema_versions`.

The migration runner (`apps/server/scripts/migrate.ts`, `migration-state.ts`) accepts only an empty database or one
it created itself. It refuses:
- application tables without `pointer_schema_versions`, or with required tables missing;
- version records that are not the sequence `1..N`;
- a database newer than the release. A database from a Pointer before the baseline (versions up to 27) counts as
  newer, so it needs a fresh Pointer install.

Readiness (`apps/server/src/services/readiness.ts`) reports `schema_incompatible` unless the highest recorded
version is exactly 1.

## Settings → AI

The AI pages in Settings mount Pointer's own React UI; the CP does not copy its screens.

- `GET /api/pointer-ui/<file>` serves the UI files from Pointer's management listener (`/_pointer/ui/…`). Only
  `manifest.json` and hashed `entry-*.js`, `styles-*.css`, `fonts-*.css`, font and brand-icon files are allowed
  (`ui-assets.ts`); these files hold no account data.
- `src/components/settings-shell/pointer-console.tsx` reads `manifest.json` (it must say `contract: 1` and
  `react: "19"`), imports the entry module and mounts it with the user, theme, locale, current path and
  `navigation: "host"`: Settings owns the navigation (Models, Providers, Instances, Groups, Routing, Dashboard,
  Test model; `ai-navigation.ts`), Pointer renders the page.
- Pointer's management calls go to the CP route `/api/ai/<path>` (served as `/settings/api/ai/…`). It needs a
  signed-in session, a CSRF token for anything but `GET`/`HEAD`, and a body of at most 8 MiB (enforced while
  reading). Only paths under `/api/providers`, `/provider-accounts`, `/catalog`, `/groups`, `/instances`, `/keys`,
  `/stats`, `/test-model`, `/connections`, `/sources`, `/codex-auth` and `/admin` pass (`management-path.ts`);
  encoded separators, dot segments, fragments and backslashes are refused. Query values may contain `/` (model
  ids).
- The CP calls `http://youeye-pointer.youeye:4001` with a management assertion signed with YouEye ID's key for the
  acting user (`client.ts`, `createPointerManagementAssertion`). Sessions from PAM or the CLI have no YouEye ID user and are refused.
- The "Test model" page calls `/api/ai-proxy-test` with a Pointer key (`ptr_…`) and an operation `models` or
  `chat`; nothing else is forwarded.

## Inference

| Caller | Address |
|---|---|
| Market apps with `ai:` and AI Settings on | `http://<app network gateway>:3003` (doorway to port 4002); `${ai.openai_base_url}` adds `/v1` |
| Outside clients | `https://<box domain>/v1/*` and `/v1beta/*` through Caddy (`ensurePointerInferenceRoutes`) |

Every inference call needs a Pointer key. App networks never reach the management listener.

**Apps.** When an app is installed with AI Settings on, the CP creates a managed Pointer installation for it,
owned by the installing YouEye ID user and bound to one of their model groups, and passes the key as
`${ai.api_key}` (`src/lib/market/managed-ai.ts`, `src/lib/pointer/managed-apps.ts`). The model names
`${ai.default_model}` and `${ai.utility_model}` are the aliases `default` and `utility`; Pointer maps them to the
first and third model of the group (`apps/server/src/services/model-aliases.ts`), so changing the group needs no
app change. Stopping the app disables the installation, starting enables it, and uninstall archives it and
revokes its key.

## Identity

Pointer trusts YouEye ID: issuer, JWKS (`<YouEye ID>/oauth/jwks`, RS256), audience and subject come from the env
file, with integration id `youeye-native`. Management calls name the acting user by their YouEye ID UUID (`sub`).

When the issuer changes (a new box domain), `transitionPointerIdentity` runs
`/opt/pointer/transition-managed-identity.js --expect-database pointer` (with `--check` first). It must return a
`pointer.identity-transition.v1` receipt with result `ready`, `changed` or `already-applied`; anything else stops
the change. The domain change (`src/lib/reconfigure/`, `changePointerIdentity` in `identity-rename.ts`) checks
first, applies the new site configuration, then runs the transition. If that fails, it restores the old domain
and routes and reverses a transition that was already applied; if even that fails, it stops with an error and
the change must be retried.

## Backups

A core backup holds Pointer's lifecycle lock (`withPairedPointerBackup` in `paired-backup.ts`): it stops the
container gracefully, dumps the `pointer` database and captures the engine files within the same core backup, then restores the
previous running state and waits for readiness. Pointer is skipped as "absent" only when its container does not
exist, there is no `pointer` database and the state directory is empty; any other unknown state fails the backup.

## Building Pointer

In the Pointer repository (Node 22.23.2, pnpm 10.6.2, Bun 1.4.2): the entrypoint `.youeye/build/pointer` with
`.youeye/build/manifests/pointer.json` (`youeye.build.v1`, build kit `youeye-pointer-build-kit`, kind
`bun-standalone`, network denied). The engine package pins OpenCodex 2.79.0 (`packages/engine/package.json`). The
output `standalone.tar` carries the Bun runtime, `server.js`, the migrations, provider manifests and the UI.
Builds and promotion follow [releases.md](releases.md): versions `X.Y.Z-dev.N`, promoted without a rebuild.
