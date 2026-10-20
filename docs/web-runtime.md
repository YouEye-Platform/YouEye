# Web runtime and dependency policy

Canonical standalone builds use an exact source commit, a private stable build
path, deterministic unused Next framework values, sorted JSON object keys and
sorted file-trace sets. Client-reference JavaScript manifests contain a fixed
assignment around JSON data; the producer parses that exact form without executing
it and sorts its object keys too. Unknown assignment formats fail the build.
Ordered application arrays retain their order. Public
canonical packages do not enable Server Actions or draft/preview mode: source
and generated-action guards reject those features until a separate runtime key
contract is reviewed. Ordinary local UI/native builds keep Next's normal keys.
Independent comparison still checks paths, modes and bytes with only the
declared Next build-ID exception; no new comparison exemptions are introduced.

The Control Panel and dashboard use Next.js 16.4.2, React/React DOM 19.3.1,
Serwist 9.5.13, next-intl 4.14.9, TypeScript 5.9.3 and pnpm 10.6.2. Node is
pinned to the public Linux x64 24.22.0 LTS distribution. The six native Web apps
and Canvas share this framework baseline. Canvas is a source template, so its
generated host must provide the declared Node version.

Install CP/UI from the repository root using the root lockfile. Native apps
and Canvas retain their own repository lockfiles. Production builds explicitly
select webpack for the Serwist integration. Run direct lint and type checks;
a successful framework compilation does not substitute for either check.

## Installed application runtime

The source-owned Web build kit and independent Node24 validation profile must
be selected together. CP, UI and native standalone packages include the exact
Node executable and complete upstream licence in `.youeye-runtime`, with a
manifest of the reviewed hashes. `server.js` remains the service entrypoint;
it starts the bundled runtime before application code and forwards termination
signals. Updating or recovering an application switches its runtime with its
signed payload. No guest-wide Node replacement is required. Docker builds use
the same pinned upstream runtime and frozen pnpm lockfile.

## Private data and offline behavior

Service workers cache only same-origin, query-free static assets under
`/_next/static/`, `/fonts/` and `/icons/`, plus the build-hashed, static `public/offline.html` document.
API responses, application HTML, RSC responses and all other requests use the
network with `no-store`. Activation removes the previous worker's private-data
cache names. Offline navigation displays that identity-free document without the application layout, scripts or API calls. It must not
recover a previous account's content after logout, account switch or revocation.
Real browser cache and account-transition checks are required for acceptance.

The embedded Pointer interface uses the host's React runtime and the explicit
`/settings/api/ai` management namespace (including the corresponding System
and inference-test aliases). Those aliases reuse the authenticated handlers and
CSRF checks. Root service-worker fetches must not depend on a page `Referer`
selecting the Control Panel API. Verify mounting, assets, data requests, theme
changes and unmount/remount with the service worker actively controlling the
page; an uncontrolled first navigation alone is insufficient.

Forward authorization strips connection-upgrade and Next routing/action headers
from its own HTTP subrequest. The application request retains those headers.
RSC metadata belongs to the app URL; forwarding it to the rewritten authorization
URL can trigger framework cache-key redirects instead of an admission decision.
Keep Next's RSC cache validation enabled and test actual app client navigation.

## Concurrent sign-in transactions

CP and dashboard use separate, short-lived OAuth transaction cookies, one per
login attempt. Parallel embedded views retain their own state and local return
path; a callback consumes only its matching transaction. The return destination
must remain on the current origin, including when path bytes are encoded.
Test fresh concurrent CP/dashboard/iframe sign-ins as well as rejected state and
encoded redirects. Never log authorization codes, transaction state or cookies.

## Managed connection proxy transport

Scoped application connections retain their HTTPS hostname and method/path
restrictions. Control Panel projects the managed gateway's private address and
public local CA through the authenticated UI bridge. The dashboard dials that
address with the original Host header and TLS server name, validating both the
certificate chain and hostname. It does not depend on public DNS resolving a
private appliance domain. Public CA trust remains available for externally
issued certificates. No TLS-verification bypass or host-file override is used.

Installed-app reconciliation refreshes this transport projection after updates
and recovery. Failed required projection remains unresolved. Existing user and
application admission, service consent and scoped route checks still run before
network access. Test real connections, wrong CA/hostname rejection, compressed
responses, redirects and cancellation when changing this transport.

## Reviewed dependency holds (2026-10-19)

Alex owns review of these holds on the next Web patch, or by 2026-11-19:

- TypeScript remains on 5.9.3 and Lucide on 0.563.0. Their new major versions
  need separate API/tooling migration evidence; this patch updates compatible
  packages without silently adopting those major changes.
- ESLint 9.39.5 is the compatible baseline for Next's current React plugin peer
  range. ESLint 9 is now deprecated; move to ESLint 10 when the upstream plugin
  declares compatibility and the same lint suite passes. Compiler-only
  diagnostics remain warnings in apps where React Compiler is not enabled;
  normal correctness rules remain errors. Warnings are retained debt, not a
  claim that every diagnostic was repaired.
- `braces` 3.0.3 has no upstream fix for
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
  The resolved use is build-time ESLint/fast-glob matching of repository-owned
  patterns, not user-supplied runtime patterns. Do not add untrusted glob input.
- `node-forge` 1.4.0 has no upstream fix for
  [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
  It remains a transitive ACME dependency. Product calls use `acme.crypto`,
  backed by Node WebCrypto/@peculiar/x509; they do not call the legacy
  `acme.forge` RSA verifier. Do not introduce that verifier into trust decisions.
- Drizzle's development loader retains esbuild 0.18.20, affected by
  [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
  Its vulnerable development-server API is not used by migration/config loading
  or shipped production services. Do not expose an esbuild development server.

These are conditional applicability findings, not a zero-advisory claim.
Recheck resolved graphs and production tracing after dependency changes. The
remaining reported counts must accompany release evidence, including the
separate browser, authentication, signed update and recovery results.

Private network requests set `cache: no-store` on a cloned Request while explicitly
preserving its referrer and referrer policy. Do not put this option in Serwist's
static `fetchOptions`: Fetch resets the referrer to `about:client` when applying
a new init, which resolves to the worker context and breaks path-aware gateway
routing. The request plugin preserves method, body, headers and credentials;
private responses remain outside both persistent caches and the HTTP cache.

## Native app locale propagation

The existing authenticated `/api/v1/header/config` response includes `locale`,
resolved from the acting user's valid preference, the instance language, then
English. The same `profile:read` and active admission checks apply; callers cannot
select another user through a query parameter. It is personal data and remains
network-only. The dashboard uses the same validated precedence.

Native apps and generated Canvas apps use this value from their existing header
fetch for the document language. Apps using next-intl pass the validated locale
explicitly to server messages and the client provider. Missing or denied header
responses fall back to English without sharing a cached user preference. This
propagates locale for formatting and existing messages; it does not add translated
content where an app has none. Verify preference changes, instance fallback and
separate users on the actual installed apps.
