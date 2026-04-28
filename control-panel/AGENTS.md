## v0.3.6.2 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix YOUEYE_GATEWAY dynamic resolution + send manifest during app registration (Session 37)

### Changes
- `src/lib/market/platform-env.ts` — `gateway_url` now resolves UI container IP dynamically via `getContainerIP('youeye-ui')` instead of unreliable `localhost:3001` proxy device. Falls back to DNS name if IP unavailable.
- `src/lib/market/engine.ts` — `registerAppWithUI()` now accepts and sends the full manifest to UI during registration, ensuring `apps.manifest` column is populated even if UI can't fetch it from the app container (timing race).
- `package.json` — Version bump to 0.3.6.2

### Test Results
- CP deployed via `spine update control` → v0.3.6.2 confirmed
- All 14 containers running

### Notes for Iris
- The `localhost:3001` proxy device approach was breaking YOUEYE_GATEWAY for all native apps. Dynamic IP resolution matches the pattern already used for Authentik and Caddy IPs.
- Sending the manifest during registration is a belt-and-suspenders fix. The UI register endpoint still tries to fetch live from the app first; CP's manifest is the fallback.

## v0.3.5.2 — andrew — 2026-04-23
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Session 13 — Smoother External App Integration (F5 + F2 + F1)

### Changes
- `src/lib/market/types.ts` — Extended InstallEvent with 'warning' status, phase, duration, errorContext fields
- `src/lib/market/sso-engine.ts` — Added StepError class with errorContext, getSuggestion/getNetworkSuggestion helpers, redactVars; HTTP step failures now throw StepError with captured URL, method, statusCode, responseBody, suggestion
- `src/lib/market/engine.ts` — Error context passthrough in SSO/container/health catch blocks; runtime roleClaim scope warning after SSO configure
- `src/lib/market/schema.ts` — Added superRefine to AppManifestSchema checking roleClaim claimName presence in SSO scope fields
- `src/lib/market/validator.ts` — NEW: 8-check validation pipeline (schema, template vars, Docker image, icon/screenshot URLs, SSO scope, SSO structure, subdomain collision)
- `src/app/api/market/validate/route.ts` — NEW: POST endpoint accepting appId or raw manifest, returns ValidationReport
- `src/app/api/ui-bridge/market/route.ts` — Added action=validate handler; error SSE events now include errorContext from StepError
- `src/app/embed/market/client.tsx` — Pre-install validation badge (green/amber/red), expandable error context cards with status badges, method+URL, response body, suggestions

### Test Results
- Playwright: 10 tests (6 API + 4 UI), all passing
- Screenshots: Tests/Andrew/playwright/screenshots/

### Notes for Iris
- Three new exports from validator.ts used by engine.ts (checkRoleClaimScope, findFieldsContaining)
- New /api/market/validate route has JWT middleware auth (same as all non-public API routes)
- StepError class exported from sso-engine.ts, imported by engine.ts and route.ts for instanceof checks

---

## v0.2.19.19 — vanya — 2026-04-10
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Remove broken server-side DNS check, simplify setup-complete UX

### Changes
- `src/app/api/setup/dns-check/route.ts` — **Deleted.** Server-side DNS check used `dns.lookup()` which tested the server's DNS, not the user's. Only worked when the CP container's DNS was manually pointed at Pi-Hole (a live patch). Fundamentally wrong approach.
- `src/components/setup/SetupDnsExplainer.tsx` — Removed server-side fallback, removed misleading spinner, removed `checkCount`/`Loader2`. Client-side HTTPS `no-cors` fetch remains as a silent background check (tests both DNS + cert trust). "Go to" link is now always visible. Added `readyWhenDone` message explaining what the user needs to do.
- `src/middleware.ts` — Removed `/api/setup/dns-check` from public routes.
- `messages/{en,de,es,fr,ru}.json` — Replaced `checkingDns`/`checkingDnsDesc`/`attempt` keys with `readyWhenDone`. Changed `dnsConfigured` to "Connected!" in all languages.

### Why
The server-side DNS check was a red herring — it checked whether the CP container could resolve the domain, not whether the user's device could. The client-side HTTPS fetch is the correct check: it verifies both DNS resolution AND certificate trust from the user's browser. The spinner was misleading because it would spin forever in the common case where DNS is configured but the CA cert isn't yet installed. The "Go to" link IS the real check — if it works, DNS + cert are both configured.

### Test Results
- Setup-complete page renders correctly with instructions + always-visible Go To link
- No spinner, no server-side fallback calls
- Background check still fires and shows green "Connected!" when both DNS + cert work
- `spine status` → 7 running, 0 stopped

### Notes for Iris
- Removes the `/api/setup/dns-check` API endpoint entirely. No other component depends on it.
- Prior versions (vanya-v0.2.19.15 through v0.2.19.17) included the setup wizard redesign, WordArt preset sync, dynamic Authentik logo sizing, and DB auto-migration. All of those remain unchanged.

---

---

## v0.2.19.10 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Dynamic app list, marketplace update display in UI

### Changes
- `src/app/api/ui-bridge/apps/route.ts` — Filter out not-installed native apps; use `installed_apps` DB for marketplace update status/version

### Test Results
- Playwright: uninstalled wiki/search no longer appear, marketplace apps show real versions

### Notes for Iris
- Pairs with UI andrew-v0.2.19.10

---

## v0.2.19.9 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App customization — install-time naming, subdomain rename flow

### Changes
- `src/components/market/install-dialog.tsx` — Added display name field with auto-slugify subdomain
- `src/lib/market/types.ts` — Added customName/customIcon to InstallConfig
- `src/lib/market/engine.ts` — registerAppWithUI uses config.customName/customIcon
- `src/lib/native-apps/installer.ts` — All 6 native installers pass customName/customIcon through
- `src/app/api/market/install/route.ts` — Passes customName/customIcon to native installer
- `src/app/api/ui-bridge/apps/subdomain/route.ts` — New bridge endpoint for subdomain rename (Caddy + Authentik + metadata)
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSubdomain function

### Test Results
- Playwright: Verified via YE-UI tests (shared deployment)
- Screenshots: Tests/Andrew/20260410_3/

### Notes for Iris
- Pairs with UI andrew-v0.2.19.9
- Subdomain rename endpoint well-documented with inline comments for future agents

## v0.2.19.7 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Register marketplace apps with YE-UI dashboard on install/uninstall

### Changes
- `src/lib/market/engine.ts` — Added `readBridgeToken()` and `registerAppWithUI()` functions; marketplace installs now POST to YE-UI `/api/v1/apps/register` with app id, name, subdomain, container URL, and iconUrl from manifest
- `src/lib/market/uninstaller.ts` — Added `deregisterAppFromUI()` function; marketplace uninstalls now DELETE from YE-UI `/api/v1/apps/{appId}/unregister`

### Test Results
- Verified Whoogle and SearXNG appear in app drawer with real logo icons after manual registration
- Verified engine.ts `registerAppWithUI` uses `iconUrl` from manifest (prefers over emoji icon)

### Notes for Iris
- The uninstaller deregistration uses dynamic import for `getContainerIP` to avoid circular deps
- Bridge token is read from `/etc/youeye/ui-bridge-token` (same as native installer)

## v0.2.19.2 — andrew — 2026-04-09
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App Market overhaul — detail pages, categories, background install, native repo manifests

### Changes
- `src/lib/market/schema.ts` — New catalog format (native/external/system), app-ref kind, detail section, utilities/infrastructure categories, install params, relaxed iconUrl validation
- `src/lib/market/types.ts` — MarketApp detail fields, removed enableSSO from InstallConfig, removed ntfy from VariableContext
- `src/lib/market/catalog.ts` — Fetch native manifests from their own repos, resolve relative paths, new catalog structure
- `src/lib/market/parser.ts` — Added parseAppRef for native app pointers
- `src/lib/market/installed-apps.ts` — Updated for new catalog format, native app version checking from repos
- `src/lib/market/version-checker.ts` — Native apps check versions from their own repos
- `src/lib/market/engine.ts` — SSO always auto-enabled, removed ntfy context
- `src/lib/market/variables.ts` — Removed ntfy variable resolution
- `src/lib/market/install-tracker.ts` — New: in-memory install tracker for background installs
- `src/app/(dashboard)/market/page.tsx` — Category grouping, click-to-detail navigation, install progress polling on cards
- `src/app/(dashboard)/market/[appId]/page.tsx` — New: app detail page with screenshots, long description, install/uninstall
- `src/app/api/market/app/[appId]/route.ts` — New: API for full app details
- `src/app/api/market/install-status/route.ts` — New: background install status polling
- `src/app/api/market/validate-subdomain/route.ts` — New: subdomain conflict detection
- `src/app/api/market/install/route.ts` — Background install tracking, completion notifications
- `src/app/api/market/install-url/route.ts` — Background tracking, notifications, removed enableSSO
- `src/app/api/market/validate-url/route.ts` — Gitea repo URL auto-detection
- `src/app/api/ui-bridge/market/route.ts` — Added install-progress action
- `src/components/market/app-card.tsx` — Click-to-detail, progress bar on card, removed action buttons
- `src/components/market/install-dialog.tsx` — Removed SSO toggle, generic install params
- `src/components/market/install-from-url-dialog.tsx` — Full detail preview, repo URL support
- `src/components/market/install-progress.tsx` — (still used on detail page)

### Test Results
- Playwright: VNC session, verified marketplace loads with categories, detail page renders, icons work

### Notes for Iris
- Catalog format changed — merging to main requires the YE-AppMarket restructure too
- Native app repos need their youeye-app.yaml files (committed on andrew branches)
- ntfy removed from platform — manifests and engine cleaned up

---

## v0.2.18.5 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (now on 10.10.10.26)
**Agent:** Sebastian
**Task:** `boot.autostart=false` for Pi-Hole — companion to YE-Spine 0.2.18.7. See `YE-Wiki/spine/host-ip-migration.md` for the full architecture.

### Changes
- `src/lib/infrastructure/types.ts` — Added optional `autostart?: boolean` field to `OCIManifest`. Defaults to true (preserves existing behavior for all other containers).
- `src/lib/infrastructure/manifests.ts` — `piholeManifest()` now sets `autostart: false`. Inline comment explains why (the Incus hot-reconcile hang on stale proxy device listen address) and points at `YE-Wiki/spine/host-ip-migration.md`.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer` now honors the manifest's `autostart` field when building the Incus instance config: `'boot.autostart': manifest.autostart === false ? 'false' : 'true'`. All other manifests (caddy, postgres, authentik, etc.) remain `'true'` — only pihole opts out.

---

## v0.2.18.5 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (now on 10.10.10.26)
**Agent:** Sebastian
**Task:** `boot.autostart=false` for Pi-Hole — companion to YE-Spine 0.2.18.7. See `YE-Wiki/spine/host-ip-migration.md` for the full architecture.

### Changes
- `src/lib/infrastructure/types.ts` — Added optional `autostart?: boolean` field to `OCIManifest`. Defaults to true (preserves existing behavior for all other containers).
- `src/lib/infrastructure/manifests.ts` — `piholeManifest()` now sets `autostart: false`. Inline comment explains why (the Incus hot-reconcile hang on stale proxy device listen address) and points at `YE-Wiki/spine/host-ip-migration.md`.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer` now honors the manifest's `autostart` field when building the Incus instance config: `'boot.autostart': manifest.autostart === false ? 'false' : 'true'`. All other manifests (caddy, postgres, authentik, etc.) remain `'true'` — only pihole opts out.

### Why
Pi-Hole's port-53 proxy device is bound to the host's primary LAN IP (`oci-deployer.ts:125-127`). If Incus tries to autostart the container with a stale listen address (i.e. after a host IP change), the proxy device fails to bind and the container ends up in a wedged state where every Incus operation against it hangs forever — only a host reboot recovers it. Verified live on `ye-sebastian` during the physical IP-change test that exposed the hang. See `YE-Wiki/spine/host-ip-migration.md` for the full investigation.

### Test Results
- Verified live on ye-sebastian:
  - `incus config get youeye-pihole boot.autostart` → `false` (after Spine's idempotent migration set it)
  - Test A: stop spine + stop pihole + pollute pins to fake old IP + restart spine → Spine's goroutine fires, refreshes proxy device, starts pihole, migrates everything else, all 4 pins on new IP, 7/7 healthy ✓
- New installs: `pnpm build` clean, `oci-deployer.ts` correctly emits `boot.autostart=false` for the pihole manifest only.

### Notes for Iris
- **Promote together with YE-Spine 0.2.18.7.** They are tightly coupled by the autostart=false contract. Promoting one without the other leaves the platform broken.
- This change does NOT affect any other container — the `autostart` field is opt-in via the manifest.

---

## v0.2.18.4 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.20)
**Agent:** Sebastian
**Task:** CP-side support for Spine 0.2.18.3's host-IP-change migration (POST /api/host-ip/migrate) + fix middleware allowlist that broke it on first ship.

### Changes (0.2.18.3, then 0.2.18.4 fix-up)
- `src/lib/infrastructure/deployer.ts` — Removed the `${hostIP}:443 { tls internal ... }` block from BOTH the deploy path (deployer.ts:135-160) and the reconcile path (deployer.ts:354-378). The `:443 { on_demand issuer internal }` catch-all immediately below already serves CP from any host IP (verified live: `curl -sk https://10.10.10.20/api/ping` works). This eliminates one of the four host-IP pins forever — fresh installs no longer have it, and the migration deletes the legacy route from running Caddy.
- `src/lib/caddy/client.ts` — New `removeIPLiteralRoute(ip)` helper. Idempotent. Mirrors the existing `removeRoute(id)` pattern (getConfig → filter → setConfig) but matches by `route.match[0].host[0] === ip` instead of by `@id`, because the legacy IP-literal route created by deployer.ts <= 0.2.18.2 has no `@id`.
- `src/app/api/host-ip/migrate/route.ts` (new) — POST endpoint, X-Deploy-Secret auth (mirrors `/api/deploy/infrastructure`). Body `{old, new}`. Reads domain from `settingsService.getRaw()`, calls `setDomainDNS(domain, new)` (existing function — already strips prior `address=/${domain}/*` lines, no signature change needed) and `removeIPLiteralRoute(old)`. Both steps best-effort with structured JSON response `{ok, dns, caddy, domain}`. **No-op fast path** when `old === new`.
- `src/middleware.ts` — **Fix shipped in 0.2.18.4 after test 3 caught the bug.** Added `/api/host-ip/migrate` to PUBLIC_ROUTES allowlist. Without it, middleware was returning 401 BEFORE my route handler ran, even though my handler's auth check would have succeeded. The existing `/api/deploy/infrastructure[...]` entries already use this pattern.
- `package.json` — Bumped 0.2.18.2 → 0.2.18.3 → 0.2.18.4.

### Test Results (against ye-sebastian, all 4 host-IP-check scenarios)
1. **First-run**: file missing, restart spine → seeded, no migration, healthy ✓
2. **No-op**: file matches, restart spine → no migration runs, healthy ✓
3. **Full migration**: pollute all 4 pins (`.host_ip=10.10.10.99`, CP env to 10.10.10.99, dnsmasq line to 10.10.10.99, Caddy fake legacy-ip-literal route on 10.10.10.99, pihole proxy device to 127.0.0.1:1153), restart spine → all 4 pins migrate to 10.10.10.20, `.host_ip` updated, dig + IP HTTPS + FQDN HTTPS all work, 7/7 healthy ✓
4. **Pi-Hole down at boot**: `incus stop youeye-pihole`, fake old IP, restart spine → migration starts pihole, full migration completes, 7/7 healthy ✓

### Notes for Iris
- **0.2.18.3 was a half-failing release** because of the middleware bug. **Promote 0.2.18.4 only**, or skip 0.2.18.3 entirely.
- The endpoint is currently called via `incus exec youeye-control -- curl ...` from Spine because CP's port 3000 is bound to 127.0.0.1 inside the container (not exposed to the host). Considered using the spine-socket bridge in reverse but `incus exec` is simpler and consistent with how Spine talks to other containers in `update.go` / `deploy.go`.

---

## v0.2.18.2 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.20)
**Agent:** Sebastian
**Task:** Close BUG-002 — make Pi-Hole password recovery actually work on the first setup retry click

### Changes
- `src/lib/apps/pihole-api.ts` — `resyncPiholePassword()` now sleeps **1000 ms** after `pihole setpassword` returns, before letting callers retry auth. Reason: FTL v6 has a measured ~400-500 ms reload window between invalidating the old password hash and loading the new one. During that window the auth endpoint returns HTTP 401 even though the new password is the right one. Without the sleep, the recursive `authenticate(true)` retry inside `pihole-api.ts` (and any external `withRetry` wrapper that does its first retry without delay) lands inside the window and gets a spurious 401, throwing despite the resync having actually worked. The sleep is comfortably above the observed window with margin.
- `src/app/api/setup/run/route.ts` — `withRetry()` no longer treats a `0`-millisecond delay as "stop retrying". Previous code: `if (attempt < maxAttempts - 1 && delays[attempt])` — `0` is falsy in JS, so any delay-array starting with `0` (which the dns step uses: `[0, 2000, 5000]`) caused `withRetry` to throw after a single attempt and silently never retry. The "3-retry parity with Caddy" promised in the file header was never actually happening for the dns step. Replaced with `if (attempt >= maxAttempts - 1) throw err` for the terminal-attempt check, and `delays[attempt] ?? 0` for the actual sleep, so an explicit `0` runs the next attempt immediately and the retry loop runs for the full `maxAttempts`.

### Test Results
- Empirical reproduction of the FTL reload window on the live VM:
  ```
  --- Resync via setpassword ---
    [✓] New password set
  --- IMMEDIATE retry ---
  t=100ms code=401
  t=200ms code=401
  t=300ms code=401
  t=400ms code=401
  t=500ms code=200
  t=600ms code=200
  ```
- (Post-build) Re-ran the same broken-password → setup-retry test from the prior session. With both fixes, the dns step is expected to succeed on a single retry click without spurious "attempt 1/3 failed" log noise.

### Notes for Iris
- Both fixes are pure CP changes; Spine is untouched.
- The `withRetry` zero-delay bug also affects any other setup step whose delay array starts with `0`. Currently only the dns step uses such an array, but the fix is general and protects future callers.
- Pi-Hole's auth endpoint is not actually rate-limited at the FTL level (only DNS queries are). The original "rate limit" framing in the BUG-002 ticket was wrong — root cause is the config-reload window, not a rate limiter. Fix is the same shape (sleep) but the diagnosis is more boring.

---

## v0.2.18.1 — sebastian — 2026-04-07
**Branch:** sebastian
**VM:** ye-sebastian (10.10.10.20)
**Agent:** Sebastian
**Task:** Fix Pi-Hole authentication failure during setup — DNS rewrites silently dropped on every fresh install

### Changes
- `src/lib/infrastructure/manifests.ts` — Pi-Hole `piholeManifest()` now passes the FTL v6+ env vars (`FTLCONF_webserver_api_password`, `FTLCONF_dns_listeningMode=all`) instead of the legacy v5 vars (`WEBPASSWORD`, `FTLCONF_LOCAL_IPV4`). The legacy vars are silently ignored by the FTL v6 entrypoint, so on every fresh deploy the password CP stored in Spine never matched what Pi-Hole actually accepted, causing the setup wizard's "Pi-Hole DNS" step to fail with `Authentication failed: 401` and never write the `address=/<domain>/<host-ip>` dnsmasq line. Local resolution of `*.<domain>` only worked because LAN-side DNS (e.g. AdGuard rewrite) was masking the bug.
- `src/lib/apps/pihole-api.ts` — `authenticate()` now treats both `HTTP 401` and the legacy `200 + session.valid:false` as "password rejected" and triggers the existing `resyncPiholePassword()` self-healing path. Previously the 401 was thrown before the recovery branch could run, leaving the resync helper as dead code under FTL v6.

### Test Results
- Verified directly against the running youeye-pihole instance on `ye-sebastian`:
  - `POST /api/auth` with the Spine-stored password → HTTP 401 (reproduced the bug)
  - `pihole setpassword <SpinePW>` via `incus exec` (recovery action) → `[✓] New password set`
  - `POST /api/auth` again → HTTP 200, `password correct`
  - `PATCH /api/config/misc` writing `dnsmasq_lines=["address=/sebastianvm.test/10.10.10.20"]` → applied
  - `dig @<pihole-ip> sebastianvm.test` (and `auth.`, `dns.`) → `10.10.10.20`
- Verified the env-var fix on a fresh container: `incus launch docker:pihole/pihole:latest` with `FTLCONF_webserver_api_password=TestPwHashCheck123` → first-boot auth with that password returns HTTP 200, `password correct`. Same launch with the old `WEBPASSWORD` env reproduces the original bug.
- Test container deleted, dnsmasq_lines reverted to empty, all 7 youeye containers still running.
- No Playwright run yet — will add after build/release/redeploy.

### Notes for Iris
- This is a no-op for any deploy that already worked around the issue with an external DNS rewrite, so behavior on existing dev/main VMs is unchanged unless the Pi-Hole container is recreated or the auth recovery path runs.
- Pi-Hole FTL has an auth rate limit (~30s lockout after a few failures). The patched `authenticate()` will recover on the *next* call after a resync, but during the first failed setup the immediate retry inside the recovery may also 401 due to the lockout. If we want truly seamless one-shot recovery during setup, add a small delay between resync and retry — flagged as BUG-002 below.
- Bug discovered while investigating "use the built-in Pi-Hole as the VM resolver instead of relying on a LAN-side rewrite" — that broader work is paused until the auth fix lands.

---

## v0.2.16 — iris — 2026-04-01
**Branch:** main
**VM:** irisvm.test (192.168.31.204)
**Agent:** Iris
**Task:** Hotfix — native app install failures, SSO cleanup, Authentik login theming

### Changes
- `src/lib/market/authentik.ts` — getAuthentikExternalUrl() now falls back to platform config when Caddy routes lack host matchers
- `src/lib/native-apps/installer.ts` — All 6 native app installers now rollback Authentik OAuth2 app on install failure
- `src/lib/authentik/setup-css.ts` — New file: generates minimal Authentik login CSS for setup wizard
- `src/app/api/setup/run/route.ts` — Setup wizard now pushes branding CSS to Authentik (theming + WordArt on first login)

### Test Results
- **IrisVM (204):** Search native app installed successfully (10/10 steps). getAuthentikExternalUrl fix validated.
- **IrisClean (205):** Fresh setup with WordArt (Playfair Display gradient). Branding CSS pushed: 4067 chars with gradient, font, animation. Wiki installed successfully (9/9 steps).
- **IrisUpdate (206):** Upgrade from v0.2.14.1 to v0.2.16. Cinema installed successfully (10/10 steps) on existing deployment.

### Notes
- Only YE-ControlPanel changed — no version bump needed on other repos

## v0.2.14.1 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** UI Polish — Fix 5 (setup name mapping) + Fix 7 (WordArt presets expansion)

### Changes
- `src/app/api/setup/run/route.ts` — Fix 5: Added `first_name` and `last_name` fields when creating Authentik users during setup. Also PATCHes name fields for existing users on re-setup.
- `src/lib/wordart-presets.ts` — Fix 7: Added 7 new site-name presets (Glassmorphism, Cyberpunk, Handwritten, Vaporwave, Terminal, Luxury, Playful). Added Caveat to FONT_OPTIONS. Total: 17 presets.
- `package.json` — Bumped to 0.2.14.1

### Test Results
- pnpm build: success
- spine update control: v0.2.14.1 deployed to johnvm
- API health: /api/ping returns ok
- Source verification: first_name in route.ts (5 occurrences), 17 presets + default in wordart-presets.ts

### Notes for Iris
- Fix 5 requires re-running setup wizard to apply name fields to existing Authentik users
- Fix 7 adds Caveat font (Google Fonts) — loaded dynamically when preset is selected

---
=======
## v0.2.14.1 — mike — 2026-04-01
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Authentik login page theming — update bridge endpoint and client types for Shadow DOM CSS

### Changes
- `src/lib/authentik/client.ts` — Added branding_default_flow_background to AuthentikBrand interface, updateFlow() function for flow layout changes, updated updateBrand() type signature
- `src/app/api/ui-bridge/authentik/branding/route.ts` — Removed logoUrl from accepted body (now only css + siteName). Added branding_logo override to suppress default Authentik SVG logo
- `src/app/api/setup/run/route.ts` — Added branding_title sync after finalize step: sets Authentik brand title to "{site_name} ID" and logo to favicon path

### Test Results
- Tested via YE-UI Playwright tests on mikevm.test (branding push confirmed working through bridge)

### Notes for Iris
- Paired with YE-UI changes — both repos needed for full Authentik theming feature
- No DB migrations required
=======
## v0.2.14.1 — lisa — 2026-04-01
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Native app hardening — registration pipeline, global sign-out, unified user menu

### Changes
- `src/lib/native-apps/installer.ts` — Added registerAppWithUI/deregisterAppFromUI calls in all 6 installers, added ensurePingRoute helper, fixed search engine detection (app-whoogle-main → app-whoogle), added YOUEYE_UI_URL env var injection
- `src/app/api/setup/run/route.ts` — Prefer implicit-consent authorization flow; add policy_engine_mode: any to all Authentik application creates
- `package.json` — Version bump to 0.2.14.1

### Test Results
- Deployed to lisavm: CP 0.2.14.1, YE-UI 0.2.14.1, Weather 0.2.14.1
- Other native apps: code changes ready, will be installed fresh during Iris validation

### Notes for Iris
- 8 repos modified, all need merging to dev
- Native apps must be reinstalled to trigger registration pipeline
- Setup wizard consent flow changed — new installs will use implicit consent
- YE-UI has new unregister endpoint at /api/v1/apps/[appId]/unregister

---

## v0.2.13.1 — sam — 2026-04-01
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** FIX-3 Caddy health false positive + FIX-4 orphaned snapshot cleanup + TASK-3 LXD path verify

### Changes
- `src/lib/health/service.ts` — FIX-3: Switched Caddy health check from IP-based `fetch()` to exec-based `execShell(curl localhost:2019/config/)` inside the Caddy container. Eliminates false-positive Degraded status caused by unreliable cross-container IP fetch from youeye-control.
- `src/lib/apps/lxd-updater.ts` — FIX-4: Added `deleteSnapshot()` after successful `restoreSnapshot()` in error handler. Prevents orphaned pre-update snapshots from accumulating on failed update attempts.
- `tests/health-dashboard.spec.ts` — New smoke test: verifies Caddy shows Running in health dashboard, CP api/ping responds ok.
- `package.json` — version bump to 0.2.13.1

### Test Results
- Playwright: 2 tests, 2 passed
- Health dashboard: all 5 services show Running (Authentik, Pi-Hole, Caddy, PostgreSQL, Spine)
- Caddy confirmed green (not Degraded) — FIX-3 verified
- CP api/ping responds `{"status":"ok"}` — confirmed
- Screenshots: Tests/Sam/20260401_1/

### Notes for Iris
- No migrations, no schema changes, no API changes
- FIX-3 changes only health/service.ts — safe to merge
- FIX-4 changes only error handler in lxd-updater.ts — adds one more cleanup step, safe
- TASK-3 (LXD WorkingDirectory) was already implemented by john-v0.2.7.1 — no changes needed
- SamVM had no orphaned snapshots to clean up manually

## v0.2.9.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 5 QA bugs from v0.2.9 (BUG-021 through BUG-025)

### Changes
- `src/app/setup/page.tsx` — BUG-021: Detect ye-setup-language cookie on page load to skip past language selection after reload; avoids infinite language step loop
- `src/app/api/setup/language/route.ts` — BUG-021: Set cookie httpOnly=false so client JS can detect it
- `src/lib/caddy/client.ts` — BUG-022: New ensurePingRoute() adds /api/ping at route position 0 (before host-matched routes) so Spine health checks work on any domain
- `src/app/api/setup/run/route.ts` — BUG-022: Call ensurePingRoute during setup wizard Caddy step
- `src/lib/infrastructure/deployer.ts` — BUG-022: Call ensurePingRoute in both deploy and reconcile paths (including when Caddy is already running)
- `src/lib/native-apps/installer.ts` — BUG-023: Add trailing newline to all env file writes (wiki, search, notes) to prevent line concatenation
- `src/lib/health/service.ts` — BUG-024: Add 1-retry with 1s delay to Authentik, Caddy, and Spine health checks to reduce transient false positives
- `src/lib/market/installed-apps.ts` — BUG-025: Replace 'su - postgres -c "psql..."' with 'psql -U youeye' directly (BusyBox su incompatibility)
- `package.json` — version bump to 0.2.9.1

### Test Results
- Build: successful standalone tarball (242MB)
- BUG-022: curl -sk https://johnvm.test/api/ping returns {"status":"ok"}
- BUG-025: installed_apps table exists (verified via psql -U youeye)
- All 7 containers RUNNING

### Notes for Iris
- BUG-022 fix adds a Caddy route at position 0 without host matcher; this is intentional to override host-matched routes for /api/ping
- BUG-025 fix uses psql -U youeye instead of su postgres; all future psql calls should use this pattern for BusyBox compatibility
- BUG-023 fix adds trailing newline to ALL native app env writes; existing malformed env files will be fixed on next app reinstall

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Search engine detection in installer + catalog cache resilience + dynamic native app discovery

### Changes
- `src/lib/native-apps/installer.ts` — detectSearchEngine() checks installed_apps DB + install.json metadata; installSearch() writes SEARCH_ENGINE_TYPE + SEARCH_ENGINE_URL env vars; step count increased from 7 to 8
- `src/lib/market/catalog.ts` — catalog cache persistence at /var/lib/youeye/catalog-cache.json; fetchCatalog() saves to disk on success, loads from cache on failure; getNativeApps() filters catalog by type: native; getCatalogCacheAge() for UI display; refreshCatalog() for manual refresh
- `src/lib/market/schema.ts` — CatalogEntrySchema extended with optional type field (native | marketplace)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- catalog.yaml now has type: native entries for wiki and search — CatalogEntrySchema accepts optional type with default 'marketplace'
- /var/lib/youeye/catalog-cache.json is created at runtime — no migration needed

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Improved setup wizard + language propagation + install from URL

### Changes
- `src/app/setup/page.tsx` — Complete rewrite: language selection as Step 0 (5 languages with flags), step progress indicator ("Step N of M" with stepper), smooth fade/slide transitions (200ms), contextual help expandable per step, mobile-friendly layout
- `src/app/setup-complete/page.tsx` — Confetti animation on completion, personalized welcome message, quick start links (dashboard, marketplace, docs)
- `src/app/api/setup/language/route.ts` — New endpoint: stores setup language in cookie for pre-setup i18n resolution
- `src/i18n/request.ts` — Added ye-setup-language cookie resolution before system/user language
- `src/lib/language/service.ts` — New LanguageService: propagateLanguageToAll() cascades to Authentik locale, app container env vars via Incus API
- `src/app/api/ui-bridge/user/language/route.ts` — New bridge endpoint: PATCH triggers full language propagation pipeline
- `src/app/api/market/validate-url/route.ts` — New endpoint: SSRF-safe manifest URL validation (HTTPS only, blocks RFC1918 IPs)
- `src/app/api/market/install-url/route.ts` — New endpoint: SSE install from URL with audit logging
- `src/components/market/install-from-url-dialog.tsx` — New dialog: URL input, manifest preview with capabilities, subdomain config, SSE install progress
- `src/app/(dashboard)/market/page.tsx` — Added "Install from URL" button in marketplace header
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSource() for URL source tracking (source + source_url columns)
- `messages/*.json` — New i18n keys for setup wizard (stepOf, help texts) and setup-complete (welcomeUser, quickStart) in all 5 locales

### Test Results
- Build: Both YE-ControlPanel and YE-UI build successfully
- Deploy: lisavm running v0.2.8.1, 7 containers running, 0 stopped

### Notes for Iris
- New DB columns: installed_apps.source (TEXT) and installed_apps.source_url (TEXT) — added via ALTER TABLE IF NOT EXISTS, safe for existing data
- New i18n keys in all 5 locale files — merge carefully if other agents added keys in the same section
- YE-UI has a new PATCH handler in admin proxy catch-all — needed for language propagation bridge calls
## v0.2.7.1 — john — 2026-03-30 (bugfix update)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 4 bugs from Cycle 2 testing (BUG-016, BUG-017, BUG-018, BUG-019)

### Changes
- `src/middleware.ts` — BUG-016: When setup is complete and accessed via IP+Caddy, let request through instead of redirecting to /setup-complete interstitial. BUG-017: Added /api/ping to PUBLIC_ROUTES.
- `src/app/api/ping/route.ts` — BUG-017: New unauthenticated health-check endpoint for Spine post-update verification. Returns `{"status":"ok"}`.
- `messages/en.json`, `ru.json`, `de.json`, `es.json`, `fr.json` — BUG-018: Added missing i18n keys `market.builtForYouEye` and `market.orphanScanPrompt` to all 5 locale files.
- `src/lib/health/service.ts` — BUG-019: Pi-Hole health check switched from HTTP API (returns 401 in v6) to exec-based `pihole status`. PostgreSQL check switched from `su - postgres` (fails with BusyBox) to `pg_isready`. Restructured health dispatch for clarity.

### Test Results
- /api/ping returns 200 without auth (verified via curl through Caddy)
- pihole status and pg_isready both work inside containers
- CP starts and runs correctly after deploy

### Notes for Iris
- /api/ping is a new public route — no auth required, by design
- Health check for Pi-Hole now uses exec-based approach (container name, not IP)
- Health check for PostgreSQL uses pg_isready instead of psql via su
- Caddy health check unchanged (was already working correctly)

## v0.2.7.1 — john — 2026-03-30
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cycle 2 polish fixes + LXD update path mismatch (BUG-012)

### Changes
- `src/lib/health/service.ts` — CPU delta-sampling: in-memory map tracks cumulative nanoseconds, computes real CPU % between polls. Spine returns cpuPercent: -2 (N/A). First poll returns -1 (no baseline).
- `src/app/(dashboard)/health/page.tsx` — Added CPU % display with Cpu icon alongside memory bar. Shows N/A for Spine, dash for first poll.
- `src/app/api/market/route.ts` — New: GET /api/market convenience route (re-exports catalog handler)
- `src/lib/native-apps/installer.ts` — installSearch() now calls saveInstallMetadata() (was missing). Uninstaller now removes Authentik OAuth2 for search. Both installers detect previous keepData installs.
- `src/lib/apps/lxd-updater.ts` — Added getServiceWorkingDir() helper using systemctl show. updateLXDApp() resolves real WorkingDirectory from systemd before file operations. Emits SSE note when paths differ (BUG-012 fix).
- `src/lib/apps/lxd-updates.ts` — getLxdAppVersion() fallback now uses systemctl show instead of grep for consistency with lxd-updater.
- `package.json` — Version bump to 0.2.7.1

### Test Results
- Playwright: 4 screenshots, 2 tests passed
- Screenshots: Tests/John/20260330_1/

### Notes for Iris
- Health dashboard cpuPercent field added to ServiceHealth interface — frontend and API both updated
- LXD updater path resolution is backward-compatible: if systemctl show fails, falls back to configured appDir
- installSearch() metadata fix ensures uninstall works correctly for search app

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — CP orchestrator, SSE progress, backup page, manifest backup schema

### Changes
- `src/lib/backup/types.ts` — backup types: config, events, manifest backup section, app backup plan
- `src/lib/backup/service.ts` — backup orchestrator: enumerate targets, dump PostgreSQL, call Spine, poll status
- `src/app/api/backup/run/route.ts` — SSE endpoint for triggering and streaming backup progress
- `src/app/api/backup/status/route.ts` — polls Spine for current backup status
- `src/app/(dashboard)/backup/page.tsx` — backup configuration and progress UI page
- `src/lib/spine/client.ts` — startBackup() and getBackupStatus() methods
- `src/lib/market/schema.ts` — BackupSchema: stopOrder, startOrder, ownPostgres, volumes, exclude
- `src/lib/market/types.ts` — BackupSpec type export
- `src/components/layout/sidebar.tsx` — added Backup navigation item
- `messages/{en,ru,fr,es,de}.json` — i18n for Backup sidebar label
- `package.json` — version bump to 0.2.7.1

### Test Results
- CP backup status endpoint responds correctly (requires auth)
- Full backup pipeline tested via Spine API: archive created, encrypted, decryptable
- Platform healthy after deploy: 7 running, 0 stopped

### Notes for Iris
- New lib/backup/ directory with service and types
- New API routes: /api/backup/run (SSE), /api/backup/status
- New page: /backup in dashboard sidebar
- Manifest schema extended with optional backup: section
- No database migrations needed

## v0.2.7.1 — ben — 2026-03-30
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** App version pinning + system health notifications

### Changes
- `src/lib/market/installed-apps.ts` — New installed_apps PostgreSQL table: CRUD, migration from install.json, update detection via version comparison
- `src/lib/market/version-checker.ts` — Background job (6h cycle): compare installed vs catalog versions, track update availability
- `src/lib/market/schema.ts` — Added `version` field to AppManifestSchema, `latestVersion` to CatalogEntrySchema
- `src/lib/market/types.ts` — Added `version` to MarketApp, `installedVersion` to InstallMetadata
- `src/lib/market/catalog.ts` — Include `version` in manifestToMarketApp conversion
- `src/lib/market/engine.ts` — Save installedVersion to both install.json and installed_apps DB on install
- `src/lib/market/uninstaller.ts` — Remove from installed_apps DB on uninstall
- `src/lib/health/monitor.ts` — Background health monitor (60s cycle): service state transitions, disk/memory/cert/update alerts
- `src/lib/health/notification-bridge.ts` — CP-to-UI notification delivery via bridge token auth
- `src/lib/health/index.ts` — Exported monitor and bridge modules
- `src/app/api/ui-bridge/notifications/route.ts` — New POST endpoint for creating notifications in YE-UI
- `src/app/api/ui-bridge/market/route.ts` — Added updates, installed-versions, refresh-catalog actions with version data
- `src/app/api/health/services/route.ts` — Side-effect imports to start monitor and version checker
- `package.json` — Bumped to 0.2.7.1

### Test Results
- Build: TypeScript compilation passes
- Screenshots: Tests/Ben/20260330_1/

### Notes for Iris
- New `installed_apps` PostgreSQL table is auto-created on first use (no manual migration needed)
- install.json files are migrated to DB on first boot — keep both during transition
- Health monitor sends notifications to all admin users via bridge token
- YE-UI notification POST route now accepts bridge token auth (not just session cookies)
- Version checker runs 45s after startup (after update-cache at 30s)

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** SMTP email configuration + user avatar bridge endpoint

### Changes
- `src/app/(dashboard)/settings/page.tsx` — SMTP settings card: host, port, username, password, from, TLS toggle, test button, status display
- `src/app/api/settings/smtp/route.ts` — GET/POST SMTP config (non-sensitive fields via SettingsService, password to secrets file)
- `src/app/api/settings/smtp/test/route.ts` — POST send test email via configured SMTP to admin address
- `src/app/api/ui-bridge/user/avatar/route.ts` — Bridge endpoint: receive multipart avatar from YE-UI, sync to Authentik via set_avatar API
- `src/lib/settings/service.ts` — Extended PlatformSettings with smtpHost, smtpPort, smtpFrom, smtpUsername, smtpRequireTls; KEY_MAP/REVERSE_KEY_MAP updated
- `src/lib/smtp/authentik-sync.ts` — Patch Authentik email stage and brand with SMTP credentials after save
- `src/lib/smtp/mailer.ts` — nodemailer wrapper for test email sending
- `src/lib/smtp/secrets.ts` — Read/write SMTP password to /var/lib/youeye/control/.secret_smtp_password (0600)
- `src/lib/market/variables.ts` — Added smtp.* namespace: host, port, username, password, from, tls, configured
- `src/lib/market/engine.ts` — Inject smtp.* vars for apps with capabilities.smtp: true
- `src/lib/market/types.ts` — Added smtp capability to CapabilitiesSchema
- `messages/{en,ru,de,es,fr}.json` — SMTP i18n keys
- `package.json` — bumped to 0.2.6.1

### Test Results
- Playwright: 5 tests, 5 passed — CP landing loads, CP settings has SMTP section, UI SSO login, UI profile avatar section, Avatar API endpoint
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- SMTP password stored at /var/lib/youeye/control/.secret_smtp_password — ensure volume persists across CP updates
- Avatar bridge uses multipart/form-data — Authentik set_avatar API receives the file directly
- smtp.* namespace resolves empty strings when SMTP not configured — apps install fine without it

---

---

 HEAD

## v0.2.6.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Unified app market + app lifecycle management

### Changes
- `src/lib/market/schema.ts` — Add `type` field (native/marketplace), `NativeConfigSchema`, make `containers` optional for native apps, add `native` category to metadata
- `src/lib/market/types.ts` — Add `type` to `MarketApp`, add `UninstallOptions`, `UninstallVerification`, `OrphanResource` types, add `NativeConfig` type
- `src/lib/market/catalog.ts` — Include `type` in `manifestToMarketApp()` conversion
- `src/lib/market/authentik.ts` — Export `getAuthentikConfig()` and `authentikAPI()` for orphan detector
- `src/lib/market/uninstaller.ts` — Complete rewrite: unified for marketplace + native, Pi-Hole DNS cleanup, keepData option, post-uninstall verification
- `src/lib/market/orphan-detector.ts` — New: detect orphaned Caddy routes, Authentik apps, PostgreSQL DBs, containers, volume dirs
- `src/lib/native-apps/catalog.ts` — Remove hardcoded `NATIVE_APP_CATALOG`, keep only utility functions (`nativeContainerName`, `nativeGiteaRepo`)
- `src/lib/native-apps/installer.ts` — Save `InstallMetadata` after wiki install for unified tracking
- `src/app/api/market/install/route.ts` — Unified: routes to native installer for `type: native`
- `src/app/api/market/uninstall/route.ts` — Accept `keepData` param, use options object
- `src/app/api/market/status/route.ts` — Include native app containers in status (pre-migration support)
- `src/app/api/market/catalog/route.ts` — Comment update (unified)
- `src/app/api/admin/orphans/route.ts` — New: GET detects orphans, POST cleans up
- `src/app/api/ui-bridge/market/route.ts` — Fix uninstaller call signature
- `src/app/(dashboard)/market/page.tsx` — Unified: single app grid, "Built for YouEye" section, orphan section, uninstall dialog
- `src/components/market/app-card.tsx` — Add "YouEye" badge for native apps, add BellRing/Shield icons
- `src/components/market/uninstall-dialog.tsx` — New: keep-data/delete-all confirmation dialog
- `src/components/market/orphan-section.tsx` — New: orphan scan + cleanup UI
- `src/app/api/market/native/` — **Deleted** (3 route files): functionality moved to unified routes
- `package.json` — Bump to 0.2.6.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/Ben/20260329_3/
- /api/market/catalog returns 9 apps (2 native + 7 marketplace)
- /api/market/native correctly returns 404
- /api/admin/orphans detected 3 orphans from previous installs
- Unified market page renders with "Built for YouEye" section

### Notes for Iris
- `/api/market/native/*` routes removed — any UI or bridge code referencing these needs updating
- `uninstallApp()` signature changed from `(appId, boolean)` to `(appId, options)` — already fixed in ui-bridge
- Native app IDs in manifests are `wiki`/`search` (not `ye-wiki`/`ye-search`) — native installer maps them internally
- AppMarket repo needs the matching `ben` branch merged for manifests to be available on `dev`/`main`

---

 HEAD
## v0.2.6.1 — john — 2026-03-29 (resume: Playwright tests)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Setup wizard hardening — Playwright test suite (resume session)

### Changes
- No new code changes — test files only (stored locally in Tests/John/20260329_2/)

### Test Results
- `setup-wizard-partial-resume.spec.ts` — PASS (State A: setup completed in background, Go link visible, resume correctly reflected)
- `setup-wizard-double-run.spec.ts` — PASS (Run 1 completed with DNS retry failure visible + Retry button; Run 2 redirected to /setup-complete without errors)
- `cycle0-full.spec.ts` — PASS (SSO login, theme switching, API v1 paths, settings page, login error page)
- Total screenshots: 36 across all 3 test sessions
- Videos: recorded for each test run (test-results/)
- BUG-011 verified RESOLVED — no duplicate Authentik providers on re-run, DNS failure visible (not silent)
- Screenshots: Tests/John/20260329_2/

### Notes for Iris
- No new build needed — code unchanged from previous session (john-v0.2.6.1)
- Setup wizard hardening fully tested and verified

---

## v0.2.6.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Search native installer to Control Panel

### Changes
- `src/lib/native-apps/installer.ts` — Added `installSearch()` (7-step: secrets, Authentik OAuth2, LXD deploy, env file, health check, Caddy route, done); updated `installNativeApp()` dispatcher to route `ye-search` appId
- `src/lib/native-apps/catalog.ts` — Set `supportsSSO: true` for ye-search (was false)
- `package.json` — bumped to 0.2.6.1

### Test Results
- YE-App-Search installed successfully on mikevm.test via CP marketplace
- 7-scenario Playwright test suite passed for Search app (see YE-App-Search AGENTS.md)
- Screenshots: Tests/Mike/20260329_2/

### Notes for Iris
- installSearch() follows same pattern as installWiki() — Authentik OAuth2 client creation, LXD container deploy, env file, Caddy route
- Whoogle must be installed first (container: app-whoogle.incus) — Search connects to it via WHOOGLE_URL env var
- WHOOGLE_URL default in Search app code is `http://app-whoogle-main.incus:5000` but installer sets correct container name

---

## v0.2.6.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Platform Health Dashboard + Setup Wizard Hardening (BUG-011)

### Changes
- `src/lib/health/service.ts` — Health check service querying 5 services via Incus state + per-service endpoints
- `src/lib/health/index.ts` — Health module exports
- `src/app/api/health/services/route.ts` — GET /api/health/services endpoint
- `src/app/api/health/services/[slug]/restart/route.ts` — POST restart endpoint per service
- `src/app/(dashboard)/health/page.tsx` — Health dashboard page with service cards, status badges, memory bars
- `src/app/(dashboard)/page.tsx` — Added compact health dots row + degraded service banner
- `src/components/layout/sidebar.tsx` — Added Health link with HeartPulse icon
- `src/app/api/setup/run/route.ts` — Full idempotency rewrite: check-before-create, 3-retry DNS, per-step persistence
- `src/app/api/setup/steps/route.ts` — GET/DELETE setup step state API for resume/retry
- `src/app/setup/page.tsx` — Added retry button per failed step, connectivity indicators, resume support
- `messages/{en,ru,de,es,fr}.json` — Added health + sidebar i18n keys
- `package.json` — Version bump to 0.2.6.1

### Test Results
- Playwright: health page renders with all 5 service cards, dashboard health dots visible
- Screenshots: Tests/John/20260329_1/screenshots/

### Notes for Iris
- New health page at /dashboard/health — no migrations needed
- Setup wizard hardening (BUG-011): setup_steps field added to youeye.yaml — backward compatible
- Merge before any other CP changes — contains setup wizard rewrite

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Update native app YOUEYE_API_URL to /api/v1 path

### Changes
- `src/lib/native-apps/installer.ts` — YOUEYE_API_URL env var now includes /v1 suffix
- `package.json` — bumped to 0.2.5.1

### Test Results
- Tested as part of YE-UI deployment — CP updated to 0.2.5.1 successfully

### Notes for Iris
- Merge with YE-UI (john first). Native apps installed after this change will get the correct v1 URL.

---
## v0.2.5.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Authentik named server ID + notification infrastructure (ntfy + capabilities)

### Changes
- `src/app/setup/page.tsx` — Add "Identity Provider Name" field to setup wizard Step 0 with auto-default "${siteName} ID"
- `src/app/api/setup/run/route.ts` — Store authentik_name in config, set Authentik brand title, rename UI OAuth2 from "${siteName} UI" to "${siteName}"
- `src/app/(dashboard)/settings/page.tsx` — Add Identity Provider settings card for post-setup renaming
- `src/app/api/settings/identity-provider/route.ts` — New API: update authentik_name in config + Authentik brand title
- `src/app/api/setup/reconfigure/route.ts` — Accept authentik_name in reconfigure flow
- `src/lib/reconfigure/index.ts` — Add authentik_name to ReconfigureRequest and patchConfig
- `src/lib/market/types.ts` — Extend VariableContext with authentik.name and ntfy namespace, add Capabilities type
- `src/lib/market/variables.ts` — Add ntfy and authentik.name to variable resolver
- `src/lib/market/schema.ts` — Add CapabilitiesSchema and "system" category to metadata
- `src/lib/market/engine.ts` — Populate authentik.name from config, populate ntfy context for apps with push capability
- `messages/{en,de,es,fr,ru}.json` — i18n keys for authentikName, identityProvider

### Test Results
- Build: pnpm build passes, standalone.tar created (236MB)
- Playwright: 5/5 tests pass (CP landing, config API, SSO login + settings navigation, ntfy manifest, Memos capabilities)
- Screenshots: Tests/Lisa/20260329_1/ (10 screenshots including settings page with Identity Provider section)
- Identity Provider section confirmed visible at `control.lisavm.test/settings` with "YouEye ID" default value

### Notes for Iris
- Merge Lisa AFTER Mike if Mike modifies SettingsService — Lisa uses direct spineClient.patchConfig
- New "system" category in metadata schema — existing apps use search/social/productivity/media
- CapabilitiesSchema is optional and backward-compatible — existing manifests pass without it
- authentik_name field in youeye.yaml is new — Spine will store it transparently via patchConfig
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Settings Service Foundation + User Identity Foundation (setup wizard names)

### Changes
- `src/lib/settings/service.ts` — New SettingsService class with typed getAll/get/set/getRaw/setRaw/invalidate + 5s cache
- `src/lib/settings/index.ts` — Re-export barrel
- `src/app/api/settings/route.ts` — New admin-only GET/PATCH endpoint for typed platform settings
- `src/lib/site-config.ts` — Migrated from spineClient.getConfig() to settingsService.getRaw()
- `src/lib/reconfigure/index.ts` — 3 getConfig + 1 patchConfig migrated to settingsService
- `src/app/api/ui-bridge/config/route.ts` — Migrated GET/PATCH to settingsService
- `src/app/api/ui-bridge/language/route.ts` — Migrated to settingsService
- `src/app/api/setup/config/route.ts` — Migrated to settingsService
- `src/app/api/setup/run/route.ts` — Migrated patchConfig + added firstName/lastName to admin creation
- `src/app/api/domain/route.ts` — Migrated to settingsService
- `src/lib/market/catalog.ts` — Migrated to settingsService
- `src/lib/infrastructure/lxd-deployer.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updater.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updates.ts` — Migrated to settingsService
- `src/app/setup/page.tsx` — Added firstName/lastName fields to setup wizard Step 1
- `messages/*.json` — Added firstName/lastName i18n keys (all 5 languages)

### Test Results
- Playwright: 4 tests, all passed
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- CP dashboard, settings API, UI SSO login, profile settings page all verified

### Notes for Iris
- spineClient.getConfig/patchConfig still exist as transport — DO NOT remove
- New /api/settings endpoint is admin-only (getSession check)
- Setup wizard now sends admin_first_name/admin_last_name in POST body
- Merge Mike AFTER John if John adds /api/v1/ routes

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `src/lib/apps/lxd-updates.ts` — `getLxdAppLatestVersion()` now compares branch winner vs main winner and returns whichever is newer
- `src/lib/apps/lxd-updater.ts` — `getLatestRelease()` same fix: compare both, pick newer
- `src/lib/infrastructure/lxd-deployer.ts` — Python download script in `installNodeAndApp()` rewritten to collect all releases, find highest branch and main, compare, use winner
- `package.json` — bumped version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed (login + dashboard, settings page), 1 failed (selector for Updates link — not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after CP update

### Notes for Iris
- This fix changes release resolution in CP for UI, Wiki, and Search deployments/updates. Same behavior change as Spine fix: stale branch tags no longer preferred over newer main releases.
- Paired fix in YE-Spine (same logic, `internal/releases/releases.go`)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status and inline progress

### Changes
- `src/lib/updates/state.ts` — New: PostgreSQL-backed update status manager (create table, upsert, read, unified aggregation from Spine + DB)
- `src/app/api/updates/status/route.ts` — New: GET endpoint returning unified update statuses
- `src/app/api/updates/[component]/route.ts` — Added status tracking (startUpdate/completeUpdate/failUpdate) around all update triggers
- `src/app/api/ui-bridge/updates/status/route.ts` — New: bridge endpoint for UI to read statuses
- `src/app/api/ui-bridge/updates/[component]/route.ts` — New: bridge endpoint for UI to trigger updates
- `src/app/api/ui-bridge/updates/clear/route.ts` — New: bridge endpoint to clear completed/failed statuses
- `src/app/(dashboard)/updates/page.tsx` — Rewritten: Updates Available section at top, inline progress per component, confirmation for self-destructive updates, auto-refresh on completion
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/spine/client.ts` — Added getUpdateStatus() and updateUI() methods, removed duplicate updateUI
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: CP updates page shows all components with versions
- Playwright: 8 tests, all pass (CP updates page screenshot verified)

### Notes for Iris
- New `update_status` table created automatically on first access (CREATE TABLE IF NOT EXISTS)
- Bridge endpoints follow existing `/api/ui-bridge/*` pattern — no auth changes needed
- Duplicate `updateUI()` method was removed from spine client (was causing TS build failure)

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/i18n/request.ts` — Per-user language resolution via YE-UI bridge endpoint (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — Accepts userId param, uses bridge token instead of cookie forwarding
- `src/app/api/ui-bridge/config/route.ts` — Added PATCH handler for language updates from YE-UI admin
- `src/components/settings/language-card.tsx` — NEW: System language settings card for CP settings page
- `src/app/(dashboard)/settings/page.tsx` — Renders LanguageCard component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- System language card verified: English → Spanish → English

### Notes for Iris
- CP now calls YE-UI bridge at `http://youeye-ui.incus:3000/api/ui-bridge/user-language`
- CP PAM sessions get system default only (no Authentik sub available)
- Bridge token auth (existing pattern, no new security surface)
- No new dependencies added

## v0.2.4 — iris — 2026-03-25
**Branch:** dev → main
**VM:** irisvm.test (204), irisclean.test (205), irisupdate.test (206)
**Agent:** Iris
**Task:** Promote native apps market + i18n to main

### Changes
- `src/lib/native-apps/catalog.ts` — Native app catalog (Wiki, Search) with container names and Gitea repo mappings
- `src/lib/native-apps/installer.ts` — 7-step wiki installer: secrets → Authentik OAuth2 → LXD container → env config → health check → Caddy route
- `src/app/api/market/native/route.ts` — GET /api/market/native — returns native apps with live status
- `src/app/api/market/native/install/route.ts` — POST /api/market/native/install — SSE stream install progress
- `src/app/api/market/native/uninstall/route.ts` — POST /api/market/native/uninstall
- `src/app/(dashboard)/market/page.tsx` — Native Apps section in App Market UI
- `src/lib/market/authentik.ts` — Fixed implicit-consent flow selection for OAuth2 providers
- `messages/*.json` — Added nativeApps i18n key in all 5 locales

### Test Results
- IrisVM: 9/9 Playwright tests pass
- IrisUpdate: 6/6 tests pass (CP upgrade v0.2.3→v0.2.3.1 preserved wiki + SSO)
- IrisClean: 2/3 tests pass (test 1 N/A — setup wizard already done on this VM)
- Wiki SSO, health check, App Market install flow all verified

### Notes for Next Agents
- Native app install is idempotent (LXD container deploy skips if exists)
- Authentik implicit-consent flow preferred by slug — no more consent screen
- Wiki Gitea releases must exist at git.byka.wtf/potemsla/YE-App-Wiki before install

## v0.2.2.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** i18n string extraction — convert remaining CP components to useTranslations()

### Changes
- `src/app/(dashboard)/dns/page.tsx` — Converted to useTranslations('dns') with full DNS management strings
- `src/app/setup/page.tsx` — Converted to useTranslations('setup') with all setup wizard strings
- `src/app/setup-complete/page.tsx` — Converted to useTranslations('setupComplete') with cert/completion strings
- `src/app/(dashboard)/apps/authentik/page.tsx` — Converted to useTranslations('authentik') with user/group management
- `src/app/(dashboard)/apps/pihole/page.tsx` — Converted to useTranslations('pihole') with Pi-Hole management
- `src/app/(dashboard)/apps/postgres/page.tsx` — Converted to useTranslations('postgres') with database management
- `src/app/(dashboard)/apps/[id]/page.tsx` — Converted to useTranslations('appDetail') with app detail/update strings
- `src/app/(dashboard)/apps-legacy/page.tsx` — Converted to useTranslations('appsLegacy')
- `src/components/proxy/container-routing-table.tsx` — Converted to useTranslations('containerRouting')
- `src/components/proxy/proxy-status-card.tsx` — Converted to useTranslations('proxyStatus')
- `src/components/proxy/route-form-dialog.tsx` — Converted to useTranslations('routeForm')
- `src/components/proxy/route-list.tsx` — Converted to useTranslations('routeList')
- `src/components/proxy/tls-card.tsx` — Converted to useTranslations('tlsCard')
- `src/components/containers/container-card.tsx` — Converted to useTranslations('containers')
- `messages/en.json` — Added 13 new translation sections (setup, setupComplete, dns expanded, authentik, pihole, postgres, appDetail, appsLegacy, proxyStatus, routeForm, routeList, containerRouting, tlsCard)
- `messages/ru.json` — Full Russian translations for all new sections
- `messages/es.json` — Full Spanish translations for all new sections
- `messages/de.json` — Full German translations for all new sections
- `messages/fr.json` — Full French translations for all new sections

### Test Results
- Build: pnpm build passes successfully
- 29 total files now use useTranslations (14 new + 15 existing)

### Notes for Iris
- All 5 message files (en, ru, es, de, fr) updated in parallel
- No breaking changes — all strings were hardcoded before, now use t() functions
- stats-card.tsx skipped — receives title as prop (no hardcoded strings)

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — config-writer language, i18n docs, string extraction expansion

### Changes
- `src/lib/market/config-writer.ts` — Added readLanguageConfig() and applyLanguageToContainers() for manifest language support
- `src/lib/market/engine.ts` — Refactored to use config-writer language functions instead of inline logic
- `src/app/(dashboard)/people/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/updates/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/proxy/page.tsx` — Converted to useTranslations
- `src/components/market/app-card.tsx` — Converted to useTranslations
- `src/components/market/install-dialog.tsx` — Converted to useTranslations
- `src/components/market/install-progress.tsx` — Converted to useTranslations
- `messages/*.json` — Updated all 5 language files with new keys for people, proxy, updates, market

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- CP now at 15/42 files with useTranslations (up from 9)
- Config-writer now exports reusable language functions

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction, config-writer language support, BUG-003 fix

### Changes
- `src/components/layout/header.tsx` — Add useTranslations for logout button
- `src/app/(dashboard)/page.tsx` — Convert dashboard stats to use translation keys
- `src/components/dashboard/system-info.tsx` — Use t() for system info labels
- `src/components/containers/container-list.tsx` — Translate container list strings
- `src/app/login/page.tsx` — Convert login page to use useTranslations
- `src/app/(dashboard)/market/page.tsx` — Translate market page strings
- `src/app/(dashboard)/apps/page.tsx` — Translate apps page strings
- `src/app/(dashboard)/settings/page.tsx` — Add useTranslations to settings and release channel
- `src/lib/market/schema.ts` — Add LanguageConfigSchema for manifest language fields
- `src/lib/market/engine.ts` — Read language config from manifest, inject env vars during install
- `src/lib/reconfigure/index.ts` — Add language propagation to marketplace apps
- `src/app/api/setup/config/route.ts` — BUG-003: change setConfig to patchConfig
- `messages/*.json` — Comprehensive keys for header, apps, dns, people, login across all 5 languages

### Test Results
- Build pending

### Notes for Iris
- BUG-003 fix: PUT /api/setup/config now uses patchConfig to preserve other fields
- Language schema added to market manifests (optional, backward compatible)
- Reconfigure flow now propagates language to marketplace apps

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin for i18n support
- `src/app/layout.tsx` — Add NextIntlClientProvider with server-side locale resolution
- `src/i18n/config.ts` — Locale configuration (en, ru, es, de, fr)
- `src/i18n/request.ts` — Server-side language resolution from youeye.yaml via Spine API (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — New bridge endpoint for native apps to fetch resolved language
- `src/components/layout/sidebar.tsx` — Convert hardcoded labels to useTranslations()
- `messages/en.json` — English translations (dashboard, settings, sidebar, login, market, proxy, containers)
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors

### Notes for Iris
- New dependency: next-intl 4.8.3
- Bridge endpoint `/api/ui-bridge/language` added — calls YE-UI `/api/user/language` for per-user resolution
- Uses patchConfig for all youeye.yaml writes (BUG-003 safe)
- Setup wizard still runs in English (no i18n applied)
- Not all components converted to useTranslations() yet — sidebar done as proof of pattern, rest can follow

---

# YouEye Control Panel - Agent Documentation

## Version History (Recent)

## v0.2.3.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — CP side (BUG-004 fix)

### Changes
- `src/lib/market/authentik.ts` — Added `implicitConsent` param to `createAuthentikOAuth2App()`, sets `policy_engine_mode: 'any'` to skip consent screen
- `src/lib/market/engine.ts` — Passes `implicitConsent: true` for all market app installations
- `package.json` — Bumped version to 0.2.3.1

### Test Results
- Build: successful (pnpm build passes)

### Notes for Iris
- BUG-004 fix: implicit consent avoids the explicit consent screen on first SSO login for market apps
- All market apps now use implicit consent by default (policy_engine_mode: 'any')

## v0.1.106.5 — john — 2026-03-23
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix HTTPS IP-based setup flow (TLS + redirect)

### Changes
- `src/lib/infrastructure/deployer.ts` — Changed Caddyfile template from `tls internal` to `tls { on_demand }` with `on_demand_tls { ask ... }` permission in both deploy and reconcile paths. Enables Caddy to dynamically issue internal CA certs for IP-based TLS connections.
- `src/lib/caddy/client.ts` — Added `on_demand` permission (with `ask` endpoint) to `setDefaultRoute()` and `setDomain()` functions. Required by Caddy v2.7+ to prevent abuse.
- `src/lib/caddy/types.ts` — Added `on_demand` type to TLS automation interface.
- `scripts/postbuild.js` — Fixed standalone build for pnpm workspace root detection. Detects nested standalone output and resolves symlinks at correct path.

### Test Results
- Playwright: 5 screenshots, all acceptance criteria verified
- `https://192.168.31.201` → `/login` (setup_completed: false)
- After PAM login → `/setup` page
- `https://192.168.31.201` → `/setup-complete` (setup_completed: true)
- `http://192.168.31.201:3000` — no setup redirect (direct CP access)
- Caddy container restart: HTTPS survives restart

### Notes for Iris
- Caddy v2.7+ requires `on_demand_tls { ask ... }` permission block — cannot use bare `on_demand` without it
- The `ask` endpoint uses CP's `/api/setup/config` which always returns 200 — safe for self-hosted LAN
- Build fix: postbuild.js now auto-detects nested standalone output from pnpm workspace root
- BUG-005 resolved by this fix (upstream TLS was the root cause)

## v0.1.106.5 — mike — 2026-03-23
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add version display and update checking for LXD native apps (UI, Wiki, Search)

### Changes
- `src/lib/apps/lxd-updates.ts` — NEW: shared module for LXD app version fetching and Gitea release checking with 5-min cache
- `src/app/api/apps/unified/route.ts` — integrated LXD version + update detection; removed hardcoded `if (def.id === 'ui')` version logic
- `src/app/api/apps/[name]/check-update/route.ts` — added LXD app support (was OCI-only)
- `src/lib/apps/update-cache.ts` — added LXD updates to background check cycle; clear LXD cache on markAppUpdated
- `package.json` — bumped version to 0.1.106.5

### Test Results
- Playwright: 11 screenshots, all verified (>20KB each = real content)
- Deployed to mikevm.test, version confirmed at 0.1.106.5
- UI version correctly detected as 0.1.105.4 via service file fallback
- Update available correctly shown: 0.1.105.4 → 0.5.4
- Wiki/Search correctly show "Not Installed" (containers not present)

### Notes for Iris
- The `appDir` in definitions.ts (`/opt/app`) doesn't match the actual deployment path (`/opt/youeye-ui`). The version fetcher has a fallback that reads the service file's WorkingDirectory. Consider updating definitions or the deployer to align paths.
- No frontend changes needed — the existing frontend already handles version and update display correctly when the API returns the data.
- LXD update checking fetches Gitea releases via `curl` inside the `youeye-control` container (CP doesn't have direct internet access). Falls back to Node.js `fetch()`.

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add bridge endpoints for UI settings integration

### Changes
- `src/app/api/ui-bridge/users/route.ts` — Extended GET to include user type/path fields; added POST for user creation with password
- `src/app/api/ui-bridge/users/[id]/route.ts` — New: PUT (set-password, toggle-active, toggle-admin actions) + DELETE user
- `src/app/api/ui-bridge/config/route.ts` — New: GET returns CP URL and domain from Spine config
- `src/app/api/ui-bridge/apps/route.ts` — New: GET returns all apps with versions, container status, update info; supports ?refresh=true for force update check
- `src/app/api/ui-bridge/apps/[id]/update/route.ts` — New: POST triggers app update via SSE stream (OCI, LXD, or Spine-managed)
- `src/app/api/ui-bridge/market/route.ts` — New: GET catalog with install status, POST install (SSE stream), POST uninstall, GET status
- `package.json` — Version bump to 0.2.1.1

### Test Results
- All bridge endpoints tested via UI proxy (/api/admin/*)
- Users list, apps list, market catalog all return correct data
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- 6 new bridge endpoint files — all follow existing validateBridgeToken pattern
- Market bridge uses query params (?action=catalog/install/uninstall/status) instead of sub-paths
- Apps bridge reuses existing APP_DEFINITIONS, update-cache, and Spine client
- No database schema changes

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix setup wizard and reconfigure wiping release_branch

### Changes
- `src/app/api/setup/run/route.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so setup wizard preserves `release_branch`
- `src/lib/reconfigure/index.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so reconfigure preserves `release_branch`
- `package.json` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- `release_branch: john` verified preserved after setup wizard completion
- Deployed to johnvm.test, version confirmed

### Notes for Iris
- Both changes are one-line swaps from `setConfig` to `patchConfig`
- The PATCH handler in Spine API already preserves unmentioned fields correctly
- No new dependencies or API changes

---

### v0.1.105.7 — Critical Bug Fixes: Caddy, Authentik, Rate Limiter (2026-03-13)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.7

**Changes:**

1. **Caddy Null Reference Fix** — `src/app/api/setup/run/route.ts` line 111: changed `const subs = body.subdomains` to `const subs = body.subdomains || {}`. Prevents `Cannot read properties of undefined (reading 'control')` crash during clean installs when `body.subdomains` is undefined. Also hardened `src/lib/reconfigure/index.ts` (lines 475-477) with `|| {}` fallback for `oldSubdomains` and `newSubdomains`.

2. **Authentik Brand UUID Fix** — `src/lib/authentik/client.ts`: Added `brand_uuid: string` field to `AuthentikBrand` interface. Updated `updateBrand()` parameter from `pk` to `brandUuid` and URL path to use `brand_uuid` instead of `pk`. Authentik v2024+ uses `brand_uuid` as the unique identifier for brands, not `pk`. Updated `src/app/api/ui-bridge/authentik/branding/route.ts` to use `defaultBrand.brand_uuid` instead of `defaultBrand.pk`.

3. **Login Rate Limiter Improvements** — Three changes:
   - Increased `LOGIN_MAX_ATTEMPTS` from 5 to 20 in `src/app/api/auth/login/route.ts` (more reasonable for a personal cloud platform)
   - Added `resetRateLimit()` call on successful login (clears the rate limit counter for the IP)
   - Added `resetAllRateLimits()` function and admin-only `DELETE /api/auth/rate-limit` endpoint (`src/app/api/auth/rate-limit/route.ts`) to allow admins to clear all rate limits
   - Exported new functions via `src/lib/auth/index.ts`

---

### v0.1.105.6 — Authentik Branding Bridge (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Authentik Brands API** — Extended `src/lib/authentik/client.ts` with `listBrands()` and `updateBrand()` functions. Added `AuthentikBrand` interface for the Authentik Core Brands API.

2. **Branding Bridge Endpoint** — Created `src/app/api/ui-bridge/authentik/branding/route.ts`:
   - `POST /api/ui-bridge/authentik/branding` — Receives theme CSS from YouEye UI and pushes to Authentik's default brand as custom CSS
   - Auth: UI Bridge token (X-UI-Bridge-Token header)
   - Finds the default Authentik brand, updates its `branding_custom_css`, optionally `branding_title` and `branding_logo`

---

### v0.1.104.4 — Version Bump for Bridge Token Fix (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.104.4

No code changes to CP itself — the bridge auth (`src/lib/ui-bridge/auth.ts`) already
works correctly. This is a version bump to accompany the Spine + UI bridge token fix.
Spine now provisions the shared token to both containers during deploy and update.

---

## Development Guidelines

**Package Manager:** Always use **pnpm** (not npm) for this project.
- Install dependencies: `pnpm install`
- Build: `pnpm build`
- Dev server: `pnpm dev`
- Update packages: `pnpm update`

**Why pnpm?** Faster installs, better disk space usage, stricter dependency resolution.

---

## Deployment & Operations Notes

### Cleanup Procedure
When `spine cleanup -y` hangs at "Stopping all containers...", see `CLEANUP-TROUBLESHOOTING.md` for the full resolution guide. Key points:
- Kill stuck `incus stop` / `spine cleanup` processes first (`pkill -9 -f`)
- Restart incusd if operations are stuck (`systemctl restart incus`)
- Delete containers individually with timeout before running cleanup
- See the nuclear option if all else fails

### Branch Configuration
- **Set branch BEFORE deploy**: `spine branch set alpha` → `spine deploy`
- Setup wizard may reset the branch — re-set after setup completes
- Branch is stored in `/var/lib/youeye/config/youeye.yaml` under `release_branch`

### PAM Authentication
- Spine is statically linked — doesn't use host's libpam.so
- Password hashes from VM base images may be incompatible (e.g., yescrypt `$y$`)
- Fix: `echo "root:tester123" | chpasswd` to write a compatible hash
- Then PAM auth via Spine API works for Control Panel login

---

## Version History

### v0.1.105.1 — Delta Merge: UI Bridge + Admin Pages + Reconcile (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `alpha`: UI Bridge API endpoints (/api/ui-bridge/*) — 9 API routes, token auth middleware
- `gamma`: Infrastructure reconciliation endpoint (/api/deploy/infrastructure/reconcile)

**Conflicts resolved:**
- `AGENTS.md`: Kept both alpha's v0.1.104.1 and beta's v0.1.103.1 version entries
- `src/middleware.ts`: Added both `/api/ui-bridge` and `/api/deploy/infrastructure/reconcile` to PUBLIC_ROUTES

---

### v0.1.104.1 — UI Bridge API (2026-03-11)

**Feature: Server-to-server API bridge for YouEye UI**

Added `/api/ui-bridge/*` endpoint tree enabling the YouEye UI container to
query Control Panel data over the Incus internal network without requiring
browser-level authentication.

**New files:**
- `src/lib/ui-bridge/auth.ts` — Shared service token validation middleware
- `src/app/api/ui-bridge/auth/route.ts` — Token validation endpoint (POST)
- `src/app/api/ui-bridge/system/route.ts` — Aggregated system info (GET)
- `src/app/api/ui-bridge/containers/route.ts` — Container list with IPs (GET)
- `src/app/api/ui-bridge/containers/[name]/action/route.ts` — Start/stop/restart (POST)
- `src/app/api/ui-bridge/dns/stats/route.ts` — Pi-Hole statistics (GET)
- `src/app/api/ui-bridge/dns/control/route.ts` — Enable/disable blocking (POST)
- `src/app/api/ui-bridge/proxy/routes/route.ts` — Caddy proxy routes (GET)
- `src/app/api/ui-bridge/users/route.ts` — Authentik user list (GET)
- `src/app/api/ui-bridge/updates/route.ts` — Component update status (GET)
- `tests/ui-bridge.spec.ts` — Playwright test spec
- `tests/ui-bridge-curl-test.sh` — Curl-based test script for VM testing

**Authentication:** Shared 64-char hex token stored at `/etc/youeye/ui-bridge-token`.
Auto-generated on first request if missing. All bridge endpoints require valid
`X-UI-Bridge-Token` header.

**Key design decisions:**
- Thin wrappers around existing library functions (no duplicated logic)
- No CORS needed (server-to-server over Incus network)
- No session/CSRF required (token-based service auth)
- Structured JSON responses with consistent error handling

---

### v0.1.103.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.103.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `src/lib/apps/lxd-updater.ts` — Uses `isNewer()` for update detection instead of `===`; `getLatestRelease()` sorts by semantic version

**Key Behavior Changes:**
- LXD app updates now correctly detect newer versions with 4-digit format (e.g., 0.1.103.1 vs 0.1.103.12)
- Releases are sorted numerically by version, not by API order
- Will not "update" to an older version
### v0.1.103.2 — Alpha HTTPS Fix (2026-03-10)

**Fix: Caddy HTTPS not working after setup wizard**

Root cause analysis revealed multiple issues causing HTTPS to fail silently:

1. **`setDomain()` didn't ensure HTTPS server config**: Only modified TLS automation policies without ensuring the HTTP server had `:443` listener, `tls_connection_policies`, or `automatic_https`. If Caddy reverted to its default Caddyfile (`:80` file_server), the broken server config was preserved through the entire setup flow.

2. **`/config` not persisted as volume**: Caddy's autosave.json (used by `--resume` flag) was stored in the container's ephemeral filesystem. Container recreation (e.g., `incus rebuild` during updates) lost the config, causing Caddy to fall back to the default Caddyfile with `:80` file_server only.

3. **Deployer Caddyfile used `:80` with `file_server`**: The fallback Caddyfile written during infrastructure deployment served static files on port 80 instead of configuring HTTPS with internal TLS.

4. **`addRouteWithoutStripping` bypassed `setConfig()`**: Called `caddyRequest('POST', '/load', config)` directly, not preserving `admin.enforce_origin = false`, which could cause subsequent admin API requests to fail with 403.

5. **Setup wizard silently swallowed errors**: All Caddy configuration steps (`setDomain`, `setContainerRoute`, `setDefaultRoute`) were in try-catch blocks that only logged errors to console, reporting success to the user regardless.

**Fixes applied:**
- `setDomain()` now ensures `srv0` exists with `:443`, `tls_connection_policies`, and `automatic_https`
- Caddy manifest mounts `/config` as persistent volume (`/var/lib/youeye/caddy/config` → `/config`)
- Deployer Caddyfile changed from `:80 { file_server }` to `:443 { tls internal; reverse_proxy }`
- `addRouteWithoutStripping` uses `setConfig()` and `ensureHTTPSConfig()`
- Setup wizard retries `setDomain` up to 3 times with error reporting
- `generateInitialConfig` no longer includes `:80` in listen array

**Bug confirmed** on VM 192.168.31.190 (skibidi.wtf):
- Port 80: Returns "Caddy works!" default page ❌
- Port 443: ERR_CONNECTION_CLOSED (TLS handshake fails) ❌
- All 4 Playwright HTTPS tests fail

**Deployment**: AlphaVM (192.168.31.40) — BLOCKED (VM powered off / unreachable)
- SSH connection consistently times out
- All ports (22, 80, 443, 3000) are unreachable
- Deployment script ready at `deploy-and-test.sh`
- Playwright test script ready at `test-https.mjs`
- Release `alpha-v0.1.103.2` with `standalone.tar` published on Gitea

**To deploy when VM is available:**
```bash
# 1. SSH into AlphaVM
ssh root@192.168.31.40

# 2. Set branch and update
spine branch set alpha
spine update control
# OR for fresh deploy: spine cleanup -y && spine deploy

# 3. Complete setup wizard at http://192.168.31.40:3000/setup

# 4. Run HTTPS tests from this repo:
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers VM_IP=192.168.31.40 DOMAIN=alpha.test CP_SUB=cp node test-https.mjs
```

### v0.1.103.1 — Delta Testing (2026-03-09)

**All 3 test tiers passed for v0.1.103.1 (dev branch)**

| Test Tier | VM | IP | Result |
|-----------|----|----|--------|
| Integration | DeltaVM | 192.168.31.42 | ✅ HTTPS works |
| Clean Install | DeltaClean | 192.168.31.43 | ✅ HTTPS works |
| Update Path | DeltaUpdate | 192.168.31.44 | ✅ HTTPS works |

**Update Path Test Details (DeltaUpdate - 192.168.31.44):**
1. **Setup Wizard**: Completed via Playwright — domain `deltaupdate.test`, admin user created, SSO configured
2. **Update**: `spine branch set dev` → `spine update control` — upgraded v0.1.102 → v0.1.103.1
3. **HTTPS Verification**: Caddy routes were not auto-applied during setup wizard on v0.1.102 (routes silently failed). Manually pushed Caddy config via admin API with all 5 routes (control, auth, dns, ui, default-catchall) + TLS policies (wildcard + on-demand)
4. **Playwright HTTPS tests**: All 4 tests passed — HTTPS loads (200), login page accessible, auth works, dashboard loads

**Note**: The setup wizard's Caddy route push failed silently during setup on v0.1.102 because errors in `caddy.setDomain()` / `caddy.setContainerRoute()` are caught and only logged to console. The Caddyfile default (`:80` file_server) was never replaced with the HTTPS config. Routes were manually applied via Caddy admin API after the update to v0.1.103.1. This is a known issue with the v0.1.102 setup flow — v0.1.103.1 may have the same behavior if Caddy API connectivity fails from the control container.

### v0.1.102.4 (2026-03-09)

**Fix: Caddy Admin API Origin Header Bug**

Fixes HTTPS setup by correcting the Origin header sent to Caddy's admin API. Previously, the admin API rejected requests due to an invalid Origin header, preventing TLS automation configuration.

**Deployment & Verification (Alpha VM - 192.168.31.40):**
- Fresh cleanup and redeploy from alpha branch
- Setup wizard completed via API with domain `alpha.youeye.test`
- HTTPS verified working on port 443 for all subdomains (auth, control, dns)
- Caddy admin API accessible and TLS automation properly configured
- Self-signed certificates automatically generated by Caddy Local Authority

### v0.1.102 (2026-02-25)

**Fix: Branch-Aware Completeness (Initial Deploy + Native Apps)**

Two gaps in the release channel system fixed: the initial LXD app deploy during `spine deploy` was not branch-aware, and native apps (Wiki, Search) had no AppDefinition entries.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Rewrote download section in `installNodeAndApp()` to read release branch from `spineClient.getConfig()`, then use Python script that filters releases by `{branch}-v` prefix with automatic fallback to main `v\d` tags
- `src/lib/apps/definitions.ts` — Added `ye-wiki` and `ye-search` as `type: 'lxd'` entries with `lxdConfig` pointing to `YE-App-Wiki` and `YE-App-Search` Gitea repos
- `package.json` — Version 0.1.101 → 0.1.102

**Testing:**
- VM 190 (main): `spine update control` → v0.1.102
- VM 191 (alpha): `spine update control` → v0.1.102, downloaded from `alpha-v0.1.102` tag
- Both VMs: `spine status` confirms CP Running (v0.1.102)

### v0.1.101 (2026-02-24)

**Feature: Branch-Based Release Channels (UI + Updater)**

Added release channel support to the Control Panel. The CP now reads the configured branch from Spine's youeye.yaml and uses it to filter Gitea releases and AppMarket catalog fetching.

**Changes:**
- `src/lib/spine/client.ts` — Extended `getConfig()`, `setConfig()`, and `patchConfig()` return types with `release_branch?: string`
- `src/lib/apps/lxd-updater.ts` — Added `getReleaseBranch()` helper (reads from Spine API), `isMainTag()` helper. Rewrote `getLatestRelease()` to filter by branch prefix with fallback to main. `updateLXDApp()` now passes branch to release filtering.
- `src/lib/market/catalog.ts` — Added `getEffectiveBranch()` helper. `rawUrl()` and `fetchFile()` accept branch parameter. Catalog/manifest fetching tries configured branch first, falls back to main git branch.
- `src/app/(dashboard)/settings/page.tsx` — Added `ReleaseChannelCard` component at bottom of settings page. Shows current channel, text input, save/reset buttons, tag convention explanation.
- `src/app/api/setup/config/route.ts` — Added PATCH handler that delegates to `spineClient.patchConfig()`.
- `package.json` — Version 0.1.100 → 0.1.101

**Testing:**
- VM 190 (main): Settings page renders Release Channel card with "Current channel: main"
- VM 191 (alpha): API returns `release_branch: "alpha"`, updater uses `alpha-v0.1.101` download URL
- Playwright: Release Channel card verified — input field, save button, reset button, help text all rendering correctly

### v0.1.99 (2026-02-24)

**Fix: Deploy Health Checks Returning 403**

Deploy health checks for Caddy and Pi-Hole always timed out because both services return HTTP 403:
- Caddy admin API returns 403 for non-localhost origins (expected security restriction)
- Pi-Hole v6+ returns 403 for unauthenticated requests

**Changes:**
- `src/lib/infrastructure/health-checks.ts` — Accept 403 as healthy for Caddy and Pi-Hole. Increased Caddy timeout 60s→120s with 3s initial delay.
- `src/lib/infrastructure/oci-deployer.ts` — Reduced `getContainerIP` socket timeout 30s→5s for faster retries.
- `package.json` — Version 0.1.98 → 0.1.99

**Testing:** Full cleanup + deploy on 192.168.31.191 — all 8 steps pass with checkmarks. 7 containers running. CP, Caddy, Pi-Hole DNS all verified working.

### v0.1.98 (2026-02-23)

**Fix: Custom Subdomain Mapping & Duplicate SSO Identity Providers**

Two bugs found during reconfigure testing with custom subdomains (wowser.wtf → skibidi.wtf, subdomains: id/controlpanel/pi-hole → auth/control/dns).

**Changes:**
- `src/lib/market/sso-engine.ts` — Fixed forEach condition pre-evaluation bug. The engine evaluated `provider.title contains 'Authentik'` as a pre-condition before the GET request, but `ctx.saved["provider"]` doesn't exist yet at that point. Added `!step.forEach` check to skip pre-condition for forEach steps, allowing the condition to only filter items during iteration.
- `src/lib/reconfigure/index.ts` — Added `hostnameMap` parameter to `updateAuthentikProvider()` for full hostname replacement (not just domain suffix). Step 6 (CP SSO) now maps `${oldControlSub}.${oldDomain}` → `${newControlSub}.${newDomain}`. Added health check wait (30s polling, 2s interval) after container restart before SSO steps.
- `package.json` — Version 0.1.97 → 0.1.98

**Testing:** Reconfigure wowser.wtf (id/controlpanel/pi-hole) → skibidi.wtf (auth/control/dns) on 192.168.31.190. Memos: exactly 1 IdP (old deleted, new created). CP redirect URIs: `control.skibidi.wtf` (not `controlpanel.skibidi.wtf`). All 3 OAuth2 providers correct. All 14 steps completed.

### v0.1.97 (2026-02-23)

**Fix: Reconfigure Bug Fixes**

Three bugs found during reconfigure testing (domain change from skibidi.wtf → iris.test) fixed.

**Changes:**
- `src/lib/reconfigure/index.ts` — Changed Authentik provider lookup from `?search=` to `?client_id=` (search doesn't match client_id field). Added postgres container restart step before app updates to refresh DHCP/DNS leases.
- `src/app/(dashboard)/settings/page.tsx` — Fixed double-protocol UI link: check if domain starts with 'http' before prepending `https://`
- `package.json` — Version 0.1.96 → 0.1.97

**Testing:** Reconfigure iris.test → skibidi.wtf on 192.168.31.190. All 11 containers running (memos no longer crashes). Authentik redirect URIs updated correctly for all 3 providers. UI link shows `https://skibidi.wtf` (no double protocol). All Caddy routes, env files, config files, install.json confirmed updated.

### v0.1.96 (2026-02-23)

**Feature: Server Reconfigure**

Post-setup reconfigure feature allowing domain, instance name, subdomains, and logo style changes. SSE-streamed progress with comprehensive system updates.

**Changes:**
- `src/lib/reconfigure/index.ts` — NEW: Reconfigure orchestration module. Updates youeye.yaml, Caddy routes+TLS, Authentik OAuth2 providers, CP/UI SSO env vars, UI branding, installed app configs.
- `src/app/api/setup/reconfigure/route.ts` — NEW: SSE endpoint for reconfigure progress.
- `src/app/(dashboard)/settings/page.tsx` — Reconfigure UI: form (instance name, domain, logo style picker, advanced subdomains), confirmation dialog, SSE progress display.

**Testing:** Full reconfigure cycle on 192.168.31.190 with 3 installed apps (Memos+SSO, SearXNG+domain, Redlib). All system configs updated. Minor bugs found and fixed in v0.1.97.

### v0.1.95 (2026-02-21)

**Feature: WordArt Setup & HTTPS Cert Trust Commands**

Setup wizard step 0 expanded with visual WordArt preset picker (10 presets), live preview, full customization (font, weight, color/gradient, shadow, transform). Google Fonts loaded dynamically. `site_name_style` JSON persisted to UI database. Setup-complete page rewritten with OS-specific cert trust commands (Windows/macOS/Linux tabs, auto-detection) and CA cert download button. Advanced subdomain options collapsed, UI subdomain removed.

**Changes:**
- `src/lib/wordart-presets.ts` — NEW: `SiteNameStyle` interface, 10 presets (clean-modern, neon-glow, sunset, ocean, elegant, bold-statement, retro-arcade, minimal, aurora, rose-gold), font/weight/shadow/transform option lists
- `src/app/setup/page.tsx` — Rewrite: preset grid, `SiteNamePreview` with inline CSS, customization panel, collapsible advanced subdomains
- `src/app/setup-complete/page.tsx` — Rewrite: `CertCommands` component with OS tabs, domain-aware commands, cert download link
- `src/app/api/setup/ca-cert/route.ts` — NEW: Extracts Caddy root CA from `youeye-caddy` container (`/data/caddy/pki/authorities/local/root.crt`)
- `src/app/api/setup/run/route.ts` — Writes `site_name_style` JSON to UI PostgreSQL `system_settings` table via base64-encoded psql
- `src/middleware.ts` — `/api/setup/ca-cert` added to PUBLIC_ROUTES

**Testing:** Playwright on 192.168.31.190 — all 3 OS tabs render, CA cert returns valid PEM (200), cert download works. UI CSS verified working on `https://skibidi.wtf`.

### v0.1.94 (2026-02-17)

**Feature: IP-Based Setup Flow via Caddy**

After `spine deploy`, navigating to `https://<server-ip>` serves the setup wizard through Caddy with a self-signed cert. The flow: IP access -> PAM login -> setup wizard -> completion page with link to UI domain. After setup completes, IP access shows a "Setup Complete" page.

**Changes:**
- `src/middleware.ts` — Detects IP-via-Caddy access (ports 80/443 with IP hostname). Pre-setup: redirects to `/login` -> `/setup`. Post-setup: redirects to `/setup-complete`. Port 3000 remains independent CP access.
- `src/app/setup-complete/page.tsx` — NEW: Static page shown when IP accessed after setup. Shows "Setup Complete" with link to UI domain.
- `src/lib/caddy/client.ts` — Added `setDefaultRoute()` for catch-all reverse proxy to CP. Added `on_demand` TLS with internal CA for IP-based HTTPS. `setContainerRoute()` now preserves routes with `@id === 'default-catchall'`.
- `src/lib/caddy/types.ts` — Added `on_demand?: boolean` to TLS automation policy.
- `src/app/api/setup/run/route.ts` — Re-ensures default catch-all route after creating subdomain routes.
- `src/app/setup/page.tsx` — Completion screen now shows "Go to [siteName]" link to `https://{domain}` instead of "Go to Dashboard".
- `src/app/login/page.tsx` — After PAM login on IP access, redirects to `/setup`.
- `src/lib/infrastructure/deployer.ts` — Step 6 (Caddy) calls `setDefaultRoute()` after deploy.

**Testing:** Full Playwright test on 192.168.31.190:
- Pre-setup: `https://IP` → `/login` → PAM auth → `/setup` wizard → 6 steps pass → completion links to `https://skibidi.wtf`
- Post-setup: `https://IP` → `/setup-complete` with "Go to YouEye" → `https://skibidi.wtf`
- Port 3000: Independent CP dashboard with PAM auth
- Update path on 191: `spine update control` → manual Caddy config → `https://IP` → `/setup-complete`

### v0.1.92 (2026-02-15)

**Fix: Stale DB Cleanup + Memos gRPC-Gateway SSO**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now drops+recreates existing databases instead of reusing them. Handles stale data left behind by manual container cleanup.

**Testing:** Memos 8/8 steps PASS with SSO (Authentik OAuth2 IdP created). Full install+uninstall roundtrip verified for 5/6 apps.

### v0.1.91 (2026-02-15)

**Fix: DB Password Sync + Container Force-Replace**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now runs `ALTER USER ... WITH PASSWORD` when user already exists, ensuring DSN password matches DB user password on reinstall.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer()` now force-deletes existing containers before recreating, handling leftover containers from failed installs.

**Testing:** Memos container now starts successfully (was crashing with `pq: password authentication failed`).

### v0.1.90 (2026-02-15)

**Feature: App Market Icons**

- Schema, types, catalog, app-card, next.config updated to support `iconUrl` in manifests
- Custom SVG icons hosted on Gitea for all 6 apps (whoogle, searxng, redlib, wikiless, memos, immich)
- AgentTesting methodology updated with mandatory completion section

**Testing:** All 6 apps render with icons in marketplace UI. 4/6 apps tested successfully (whoogle, searxng, redlib, wikiless). Memos required further fixes (v0.1.91-92).

### v0.1.89 (2026-02-15)

**Feature: App Market — YAML-Driven Generic Installer Engine**

Complete rewrite of the app marketplace system. The hardcoded temp-market code has been fully replaced by a declarative YAML-driven installer engine. App manifests are now defined in `youeye-file.yaml` format in the YE-AppMarket Gitea repo, and a generic engine reads them to orchestrate installation, SSO configuration, and uninstallation.

**Changes:**
- `src/lib/market/schema.ts` — Zod v4 schemas for youeye-file.yaml v1 spec
- `src/lib/market/parser.ts` — YAML parsing + validation against schema
- `src/lib/market/variables.ts` — Template variable substitution at deploy time (${app.id}, ${secrets.NAME}, ${install.url}, ${container.ip}, ${sso.clientId}, ${authentik.*})
- `src/lib/market/engine.ts` — Generic installer orchestrator: validate → generate secrets → deploy deps → write configs → deploy containers → health → Caddy route → SSO → save metadata
- `src/lib/market/sso-engine.ts` — Declarative HTTP step executor for SSO (variable substitution, token extraction, conditionals, forEach iteration)
- `src/lib/market/uninstaller.ts` — Generic uninstall from metadata
- `src/lib/market/config-writer.ts` — Template config file writer
- `src/lib/market/health.ts` — Health check module
- `src/lib/market/authentik.ts` — Authentik CRUD operations
- `src/lib/market/catalog.ts` — Fetches catalog.yaml + manifests from Gitea raw API with 5-min in-memory cache
- `src/lib/market/types.ts` — TypeScript types
- `src/lib/market/metadata.ts` — Install metadata read/write
- `src/lib/market/index.ts` — Module exports
- `src/app/api/market/catalog/route.ts` — GET catalog endpoint
- `src/app/api/market/install/route.ts` — POST SSE install stream
- `src/app/api/market/uninstall/route.ts` — POST uninstall endpoint
- `src/app/api/market/status/route.ts` — GET installed app status
- `src/app/(dashboard)/market/page.tsx` — Marketplace UI with browsable grid, category filtering, install dialog (subdomain + SSO toggle), SSE install progress
- `src/lib/temp-market/` — Entire directory deleted (clean break)
- `package.json` — Added `yaml` dependency, version bump to 0.1.89

**Architecture:**
- YE-AppMarket Gitea repo (`git.byka.wtf/potemsla/YE-AppMarket`): `catalog.yaml` index + 6 app manifests (whoogle, searxng, redlib, wikiless, memos, immich)
- Container naming changed to `app-{appId}` (was `market-{appId}`)
- Install metadata saved at `/var/lib/youeye/app-{appId}/install.json`
- Declarative SSO interpreter executes HTTP steps from YAML with variable substitution, token extraction, conditionals, forEach iteration

**Testing (192.168.31.190):**
- Marketplace page loads with 6 apps from YE-AppMarket Gitea repo
- Full install flow tested: Whoogle (5/5 steps: secrets → container → health → route → done)
- Full uninstall flow tested: container deleted, Caddy route removed, metadata cleaned
- SSE streaming works for progress display
- Install metadata saved at `/var/lib/youeye/app-whoogle/install.json`

### v0.1.88 (2026-02-15)

**Feature: Move UI updates from Spine to Control Panel**

UI updates are now handled entirely by the Control Panel via a new LXD updater module, replacing the previous `spine update ui` command.

**Changes:**
- `src/lib/apps/lxd-updater.ts` — New LXD updater with snapshot/rollback: fetches release from Gitea, downloads tarball, extracts, restarts systemd service, health check, auto-rollback on failure
- `src/lib/apps/definitions.ts` — UI app `updatedBy` changed from `'spine'` to `'control-panel'`, added `lxdConfig` field to `AppDefinition` interface
- `src/app/api/apps/[name]/update/route.ts` — Routes LXD apps to `updateLXDApp()`, removed `case 'ui'` from Spine proxy handler
- `src/lib/infrastructure/lxd-deployer.ts` — Fixed `--strip-components=1` bug (tarballs have files at root level)
- `package.json` — Version bump to 0.1.88

**Testing (192.168.31.191):**
- Deployed to both 190 and 191
- Faked older UI version (0.2.2) on 191
- Triggered update via POST /api/apps/ui/update SSE endpoint
- All stages completed: snapshot → stop service → download → extract → dependencies → start → health check → completed
- Version confirmed 0.2.3, service active, health check 200
- "Already up to date" path also tested and working

### v0.1.87 (2026-02-14)

**Fix: Include per-app Redis containers in install metadata**

Fixes uninstall not cleaning up per-app Redis containers. The v0.1.86 installer wrote metadata with only the main container, causing the uninstaller to skip the Redis container.

**Changes:**
- `installer.ts` — SearXNG metadata now records `['market-searxng', 'market-searxng-redis']`, Wikiless records `['market-wikiless', 'market-wikiless-redis']`

**Testing (192.168.31.190):**
- Fresh install SearXNG → metadata correctly lists both containers
- Fresh install Wikiless → metadata correctly lists both containers
- Uninstall SearXNG → both `market-searxng` + `market-searxng-redis` deleted
- Wikiless + `market-wikiless-redis` survived (isolation confirmed)

### v0.1.86 (2026-02-14)

**Security: Fix 6 anti-patterns in Temp Market deployment**

Per-app Redis isolation, secure volume permissions, container auto-start, strict health checks, fatal SSO errors.

**Changes:**
- `manifests.ts` — Replaced shared `marketRedisManifest()` with `searxngRedisManifest()` and `wikilessRedisManifest()`, each with dedicated container names
- `definitions.ts` — SearXNG `containerNames: ['market-searxng', 'market-searxng-redis']`, Wikiless `containerNames: ['market-wikiless', 'market-wikiless-redis']`
- `redis.ts` — Complete rewrite: removed shared Redis functions, new `deployAppRedis(appId)`, `getAppRedisHost(appId)`, `getRedisManifest(appId)`
- `installer.ts` — Updated to per-app Redis functions, SSO errors now fatal (throw)
- `uninstaller.ts` — Removed shared Redis cleanup (per-app Redis deleted with containers)
- `oci-deployer.ts` — Volume mkdir 0o700 (was 0o777), added `boot.autostart: true`
- `health.ts` — `resp.status < 500` (was `resp.status > 0`)

**Testing (192.168.31.190):**
- SearXNG install → dedicated `market-searxng-redis` container created
- Wikiless install → dedicated `market-wikiless-redis` container created
- Volume permissions verified `drwx------` (0o700)
- `boot.autostart=true` verified on all new containers
- Bug found: metadata missing Redis containers → fixed in v0.1.87

### v0.1.85 (2026-02-14)

**Feature: SSO Integration for Temp Market Apps (Memos & Immich)**

Automatic Authentik OAuth2/OIDC configuration during market app installation. SSO button appears on app login pages. Full cleanup on uninstall.

**Key Changes:**
- `sso-setup.ts` — createAuthentikOAuth2App (list all providers + filter by client_id/name), removeAuthentikOAuth2App (same), configureMemosSSO (internal HTTP for tokenUrl/userInfoUrl), configureImmichSSO (internal HTTP for issuerUrl)
- `installer.ts` — Pass authentikInternalUrl to SSO config functions
- `uninstaller.ts` — Always try `youeye-market-${appId}` slug for cleanup

**Bugs Fixed:**
- Authentik search API doesn't match `client_id` → list all + filter
- Self-signed cert blocks server-to-server token exchange → use internal HTTP
- Uninstaller conditional SSO cleanup → always try standard slug

**Testing (on 192.168.31.190):**
- Install Memos with SSO: 7/7 steps pass
- SSO login: Full OAuth2 flow (redirect → auth → consent → token exchange → session)
- Uninstall: Authentik app + provider properly deleted
- Reinstall: No duplicate errors

### v0.1.81 (2026-02-13)

**Feature: Temp Market — One-Click App Marketplace**

Complete marketplace system for installing/uninstalling 6 third-party self-hosted apps. Each app deploys as OCI containers in Incus with automatic Caddy reverse proxy configuration and health checks.

**6 Supported Apps:**
- **Whoogle** — Privacy-focused Google search proxy (docker.io, port 5000)
- **SearXNG** — Privacy metasearch engine with shared Redis (docker.io, port 8080)
- **Redlib** — Reddit privacy frontend (quay.io, port 8080)
- **Wikiless** — Wikipedia privacy frontend with shared Redis (ghcr.io, port 8080)
- **Memos** — Note-taking app with shared PostgreSQL (docker.io, port 5230)
- **Immich** — Photo/video management with 4-container stack (ghcr.io, port 2283)

**New Files (18):**
- `src/lib/temp-market/definitions.ts` — App catalog (6 apps with metadata)
- `src/lib/temp-market/types.ts` — TypeScript interfaces
- `src/lib/temp-market/manifests.ts` — OCI manifest factories for all containers
- `src/lib/temp-market/installer.ts` — Install orchestrator with SSE progress
- `src/lib/temp-market/uninstaller.ts` — Uninstall (containers, routes, metadata)
- `src/lib/temp-market/status.ts` — Check installed/running status per app
- `src/lib/temp-market/health.ts` — HTTP and PostgreSQL health checks
- `src/lib/temp-market/metadata.ts` — Read/write install.json files
- `src/lib/temp-market/redis.ts` — Shared Redis lifecycle management
- `src/lib/temp-market/postgres-setup.ts` — Create/drop Memos database
- `src/lib/temp-market/searxng-config.ts` — Write SearXNG settings.yml
- `src/app/(dashboard)/temp-market/page.tsx` — Marketplace UI page
- `src/app/api/temp-market/install/route.ts` — POST SSE install stream
- `src/app/api/temp-market/uninstall/route.ts` — POST uninstall app
- `src/app/api/temp-market/status/route.ts` — GET app statuses
- `src/components/temp-market/app-card.tsx` — App card component
- `src/components/temp-market/install-dialog.tsx` — Install configuration dialog
- `src/components/temp-market/install-progress.tsx` — SSE progress display

**Modified Files:**
- `src/components/layout/sidebar.tsx` — Added Temp Market nav item
- `src/lib/apps/registry.ts` — Minor import adjustments
- `package.json` — Version 0.1.81

**Deployment Patterns Demonstrated:**
1. Simple standalone (Whoogle, Redlib) — 4 steps
2. Shared Redis dependency (SearXNG, Wikiless) — 5-6 steps
3. Shared PostgreSQL (Memos) — 5 steps
4. Multi-container with dedicated DB (Immich) — 8 steps

**Key Technical Decisions:**
- `ensureRoute()` wrapper for idempotent Caddy route creation (handles partial install retries)
- Immich PostgreSQL needs 2 GiB memory (pgvecto.rs loads ~400MB geocoding data)
- Immich server requires `IMMICH_HOST=0.0.0.0` (otherwise IPv6-only binding)
- 660s fetch timeout / 600s operation timeout for large OCI images (~1.5GB Immich ML)
- Shared Redis uses DB number isolation (SearXNG=DB0, Wikiless=DB1)
- Container naming: `market-{appId}` for single-container, `market-{appId}-{role}` for multi

**Bug fixes during development (v0.1.77→v0.1.81):**
- v0.1.78: Fixed CPU limits (`'0.5'`→`'1'` — Incus rejects fractional)
- v0.1.79: Fixed Redlib image (quay.io/redlib/redlib, added quay remote)
- v0.1.80: Fixed Immich PG OOM (512MiB→2GiB), fixed IPv6 binding (IMMICH_HOST=0.0.0.0)
- v0.1.81: Added ensureRoute() for idempotent route creation

**Testing (192.168.31.190):**
- All 6 apps: install + uninstall confirmed working
- Whoogle: Install 4/4 steps ✓, Uninstall ✓
- SearXNG: Install 6/6 steps ✓, Uninstall ✓ (shared Redis created/cleaned)
- Redlib: Install 4/4 steps ✓, Uninstall ✓
- Wikiless: Install 5/5 steps ✓, Uninstall ✓ (shared Redis reused/cleaned)
- Memos: Install 5/5 steps ✓, Uninstall ✓ (DB created/dropped in shared PG)
- Immich: Install 8/8 steps ✓, Uninstall ✓ (4 containers, ~7GB memory, 8+ min deploy)
- Health checks pass for all apps
- Caddy routes created and removed correctly
- Metadata files saved and cleaned up

---

### v0.1.76 (2026-02-12)

**Fix: Deployer continues past Authentik timeout**

The infrastructure deployer previously bailed out entirely when Authentik's health check timed out (step 3), skipping Caddy, Pi-Hole, and UI deployment. Authentik is slow to start (~3-5 min) and downstream steps don't depend on it being immediately healthy.

**Changes:**
- `src/lib/infrastructure/deployer.ts` — Removed `if (!healthy) return;` after Authentik health check. Deployment now continues through all 8 steps regardless of Authentik startup time.

**Testing:**
- Full deploy on dev server (192.168.31.190): Steps 1-8 all execute. Caddy deployed successfully even with Authentik still warming up.

---

### v0.1.75 (2026-02-12)

**Fix: Caddy config persistence across restarts**

After a VM restart, Caddy lost all routes pushed via Admin API because config was only held in memory. Implemented `--resume` flag approach which makes Caddy automatically save API-pushed config to `/config/caddy/autosave.json` and reload it on restart.

**Root Cause Analysis:**
- Caddy Admin API config is in-memory by default
- Previous attempts to write config files before container start failed (chicken-and-egg: container needed the file that needed the container to create it)
- Mounting a disk device at `/config` conflicted with Caddy's internal `XDG_CONFIG_HOME` directory

**Solution: `--resume` flag**
- Caddy's `--resume` flag auto-saves config pushed via `/load` endpoint to `/config/caddy/autosave.json`
- On restart, it loads autosave first, falling back to Caddyfile
- No external volume needed for `/config` — Caddy writes to its own container filesystem
- Eliminates ALL manual persistence code

**Changes:**
- `src/lib/infrastructure/manifests.ts` — Changed Caddy command to `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume`. Removed `/config` volume mount (kept `/data` for TLS certs only).
- `src/lib/infrastructure/deployer.ts` — Removed `initializeCaddyConfig` import and call from Step 6
- `src/lib/infrastructure/authentik-setup.ts` — Removed `initializeCaddyConfig()` function and unused imports
- `src/lib/caddy/client.ts` — Removed `persistConfigToDisk()` function, simplified `setConfig()` to just POST to Admin API

**Testing:**
- Deployed Caddy with `--resume` on dev server
- Pushed Authentik route via Admin API
- Restarted container — config persisted with both default and Authentik routes intact
- Port 80 proxy verified working from host

---

### v0.1.72 (2026-02-12)

**Feature: Unified Apps Tab with OCI Update Detection**

Complete overhaul of the Apps section. Consolidates all YouEye services (system components + OCI containers) into a single unified view with update detection, container controls, and SSE-powered update streaming.

**New Files:**
- `src/lib/apps/definitions.ts` — Single source of truth for 9 app definitions (host-system, incus, spine, control-panel, postgres, authentik, caddy, pihole, ui)
- `src/lib/apps/update-cache.ts` — Background 3-hour periodic update checking with in-memory cache
- `src/lib/apps/updater.ts` — OCI container rebuild via Incus API with snapshot-based rollback
- `src/app/api/apps/unified/route.ts` — GET /api/apps/unified combines definitions + Incus status + Spine status + digest cache
- `src/app/api/apps/[name]/update/route.ts` — POST SSE stream for app updates (OCI or Spine)
- `src/app/api/apps/[name]/check-update/route.ts` — POST per-app digest check
- `src/app/api/apps/check-updates/route.ts` — POST bulk check all OCI apps
- `src/app/(dashboard)/apps/[id]/page.tsx` — App detail page with container controls, update streaming, management links
- `src/app/(dashboard)/apps-legacy/page.tsx` — Copy of old apps page

**Modified Files:**
- `src/app/(dashboard)/apps/page.tsx` — Rewritten: unified list view with "Updates Available" section
- `src/lib/apps/registry.ts` — Rewritten: added digest checking functions (fetchRemoteDigest, checkAppUpdate, etc.)
- `src/lib/spine/client.ts` — Added getRegistryDigest method
- `src/components/layout/sidebar.tsx` — Removed "Updates" nav item, added "Apps (Legacy)"

**Architecture:**
- CP container now has internet access (firewall removed). Digest checks still go through Spine's `/api/registry/digest` endpoint for consistency
- OCI updates: CP creates snapshots → stops containers → rebuilds via Incus → starts → verifies → rollback on failure
- Spine-managed updates: proxied to Spine API (update self, control, incus, system, ui)

**Bug Fix (v0.1.71 → v0.1.72):**
- Fixed Next.js routing conflict: `[id]` vs `[name]` dynamic segments at `/api/apps/` level
- Moved new API routes from `[id]` to `[name]` to match existing convention

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.72
- Clean startup, no routing errors
- Spine registry digest endpoint verified for Docker Hub, GHCR images

---

### v0.1.70 (2026-02-12)

**Fix: UI SSO Environment Variables Not Loaded**

After running the setup wizard, the UI showed "SSO is not configured" because the LXD deployer's systemd service template did not include `EnvironmentFile` directive. The env file existed (written by Spine) but the service never loaded it.

**Root Cause:**
- `lxd-deployer.ts` created the UI systemd service without `EnvironmentFile=-/etc/youeye-ui.env`
- Spine's `handleUISSO` wrote the env file but only called `systemctl start` (no-op if already running)
- Result: UI process ran without AUTHENTIK_URL, AUTHENTIK_CLIENT_SECRET, etc.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Added `EnvironmentFile=-/etc/${spec.containerName}.env` to service template

**Testing:**
- Verified on dev server (192.168.31.190): UI login page shows `ssoConfigured: true` and "Sign in with Authentik" button
- All services healthy: UI 307, CP 307, Authentik 302

---

### v0.1.69 (2026-02-12)

**Fix: Authentik HTTP 400 Error via Caddy**

Caddy proxy returned HTTP 400 when accessing Authentik because the setup wizard configured the upstream port as 9443 (HTTPS) while Caddy sends plain HTTP.

**Changes:**
- `src/app/api/setup/run/route.ts` — Changed Authentik route port from 9443 to 9000

**Testing:**
- Verified on dev server: Authentik returns 302 via Caddy proxy

---

### v0.1.68 (2026-02-12)

**Feature: Infrastructure Deployment Moved from Spine to Control Panel**

All infrastructure app deployment logic previously in Spine (Go) has been moved to the Control Panel (TypeScript). Spine now only: (1) installs Incus, (2) starts its API, (3) deploys the CP container, (4) calls the CP's SSE endpoint to deploy everything else.

**Architecture:**
- SSE endpoint at `/api/deploy/infrastructure` deploys 8 steps: PostgreSQL, Authentik DB setup, Authentik server, Authentik worker, API token, Caddy, Pi-Hole, YouEye UI
- OCI containers deployed via Incus REST API (Unix socket)
- LXD containers (YouEye UI) deployed as Debian + Node.js with systemd service
- Secrets stored in `/var/lib/youeye/` per-service with auto-generation
- Keepalive SSE comments every 10s prevent idle timeout during long operations

**New Files (10):**
- `src/lib/infrastructure/types.ts` — OCIManifest, LXDContainerSpec, DeploymentEvent types
- `src/lib/infrastructure/manifests.ts` — All 7 app manifests (postgres, authentik, caddy, pihole, ui)
- `src/lib/infrastructure/secrets.ts` — Secret generation and persistence
- `src/lib/infrastructure/oci-deployer.ts` — OCI container lifecycle via Incus API
- `src/lib/infrastructure/lxd-deployer.ts` — LXD container deploy with Node.js + systemd
- `src/lib/infrastructure/health-checks.ts` — Service health checks (postgres, authentik, caddy, pihole)
- `src/lib/infrastructure/postgres-setup.ts` — Authentik database/user creation via psql
- `src/lib/infrastructure/authentik-setup.ts` — API token creation, Caddy route setup
- `src/lib/infrastructure/deployer.ts` — Main orchestrator (8-step sequential deployment)
- `src/app/api/deploy/infrastructure/route.ts` — SSE endpoint with auth and keepalive

**Modified Files:**
- `src/lib/incus/server.ts` — Added `execCommand`/`execShell` with chunked `/wait?timeout=30` polling, `incusRawGet` for log files
- `src/middleware.ts` — Added `/api/deploy/infrastructure` to API routes

**Key Bugs Fixed:**
- SSE idle timeout: Added keepalive comments every 10s
- Port 3000 conflict: Made port proxy errors non-fatal (UI port 3000 vs CP port 3000)
- Missing systemd service: LXD deployer now creates and starts `.service` file
- Socket timeout in execCommand: Changed from bare `/wait` to chunked `/wait?timeout=30` with retry
- npm install styled-jsx: Replaced with direct curl from npm registry (avoids 3min+ pnpm node_modules scanning)
- Service file creation: Uses base64 encode/decode instead of heredoc for reliability over exec API

**Testing:**
- 5 iterative deploy cycles on dev server (192.168.31.190)
- All 7 containers deploy and run: postgres, authentik (server+worker), caddy, pihole, control, ui
- CP returns 200, Authentik healthy, Pi-Hole DNS resolving, UI service active
- `spine deploy` exits 0 with full SSE stream

---

### v0.1.62 (2026-02-11)

**Feature: Auto Pi-Hole DNS Rewrite on Domain Change**

When a user configures a domain name (via setup wizard or proxy page), Pi-Hole automatically gets a wildcard DNS entry so `domain.com` and `*.domain.com` resolve to the server's LAN IP.

**How it works:**
- Uses Pi-Hole FTL v6 `misc.dnsmasq_lines` config API
- Single `address=/domain.com/IP` directive handles base domain + all subdomains
- Old domain entries are automatically cleaned up on domain change
- Runs silently — no UI changes needed, errors are non-critical

**Changes:**
- `src/lib/apps/pihole-api.ts` — Added `getDnsmasqLines()`, `setDnsmasqLines()`, `setDomainDNS()`, `removeDomainDNS()` functions
- `src/app/api/setup/run/route.ts` — Added DNS step after Caddy routes in setup wizard
- `src/app/api/domain/route.ts` — Added Pi-Hole DNS rewrite + Spine config sync on domain POST

**Bug Fix:**
- Proxy page domain POST was not syncing to Spine config. Added `spineClient.patchConfig({ domain })` call.

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.62
- Set domain to `mytest.local` → Pi-Hole entry added, DNS resolves correctly
- Changed to `newdomain.example` → old entry removed, new entry added
- Wildcard works: `app.newdomain.example` resolves to `192.168.31.190`
- Old domain `mytest.local` returns NXDOMAIN after change
- Spine config synced correctly

---

### v0.1.60 (2026-02-10)

**Feature: Setup Wizard + White-Labeling**

Initial setup wizard for first-time configuration, plus white-labeling support using dynamic `site_name` from Spine config.

**Setup Wizard:**
- `src/app/setup/layout.tsx` — Minimal centered layout (no sidebar)
- `src/app/setup/page.tsx` — 3-step client wizard: server config, admin account, SSE installation progress
- `src/app/api/setup/config/route.ts` — Public GET for config check, admin PUT for updates
- `src/app/api/setup/run/route.ts` — Full SSE-streamed setup: save config, create Caddy routes, create admin user, configure SSO for CP + UI, write site_name to UI DB, mark setup complete
- `src/lib/spine/client.ts` — Added `getConfig()`, `setConfig()`, `patchConfig()` methods
- `src/middleware.ts` — Added `/api/setup/config` to PUBLIC_ROUTES

**White-Labeling:**
- `src/lib/site-config.ts` — Server-side `getSiteConfig()` reads from Spine
- `src/hooks/use-site-config.ts` — Client-side `useSiteConfig()` hook
- `src/app/layout.tsx` — Dynamic `generateMetadata()` using site_name
- `src/app/login/page.tsx` — Login heading uses site_name
- `src/app/(dashboard)/settings/page.tsx` — UI section uses site_name

**Bug Fix:**
- GET `/api/setup/config` was returning 401 because the route handler had its own `getSession()` check. Removed session check from GET (public endpoint for setup-check). PUT still requires admin auth.

**Testing:**
- Deployed to dev server (192.168.31.190)
- `/api/setup/config` returns 200 with config (verified public access)
- Login page renders with dynamic title ("YouEye Control Panel")
- Setup page requires authentication (redirects to login)

---

### v0.1.59 (2026-02-10)

**Fix: Spine client timeout race**

Increased Spine Unix socket client timeout from 30s to 60s. The old timeout raced with Spine's health check loop (30s max), causing "Request timeout" when enabling UI.

**Changes:**
- `src/lib/spine/client.ts` — `req.setTimeout(60000)` (was 30000)

**Testing:**
- Deployed to dev server, full deploy passes, 7 containers running

---

### v0.1.56 (2026-02-09)

**Feature: YouEye UI Management (Phase 2)**

Automated UI container lifecycle management from the Settings page.

**Changes:**
- Settings page: Added YouEye UI section (visible when SSO configured + UI installed)
  - Domain input with auto-suggestion (ui.{domain})
  - Enable UI button: creates Authentik OAuth2, Caddy route, DB, starts service
  - Disable UI button: removes Authentik resources, Caddy route, stops service
  - Live status indicator (not-installed/installed/running)
- New API route: `/api/ui` (GET status, POST enable, DELETE disable)
- New library: `src/lib/ui/manager.ts` — full UI lifecycle management
- Spine client: added getUISSO(), setUISSO(), deleteUISSO(), updateUI() methods
- SpineStatusResponse: added `ui` field with status/installed/enabled/version/ip

**Testing:**
- Deployed to dev VM (192.168.31.190)
- Spine API returns correct UI status (installed, enabled, version, IP)
- CP Settings page bundle includes full UI management code
- API route `/api/ui` responds correctly

### v0.1.55 (2026-02-09)

**Fix: SSO Callback Redirect — All Redirects Now Use CONTROL_EXTERNAL_URL**

**Problem:**
After SSO login with Authentik, the browser was redirected to `http://0.0.0.0:3000/` instead of `https://control.skibidi.wtf/`. The v0.1.54 fix only applied `CONTROL_EXTERNAL_URL` to the OAuth2 token exchange `redirect_uri`, but the `NextResponse.redirect()` calls for navigation (success → `/`, errors → `/login?error=...`) still used `request.url` as the base URL. Inside the container, `request.url` resolves to `http://0.0.0.0:3000/...`.

**Root Cause:**
`NextResponse.redirect(new URL('/', request.url))` uses `request.url` which is `http://0.0.0.0:3000/api/auth/callback?code=...` inside the container.

**Solution:**
Compute `baseUrl` once at the top of the GET handler from `CONTROL_EXTERNAL_URL` (with forwarded-header fallback), then use it for ALL redirects — not just the token exchange redirect_uri.

**Deployment Note:**
Previous deployment used `rm -rf /opt/app/*` which doesn't remove dotfiles (`.next` directory). The old `.next` survived, causing stale compiled chunks to be served. Fixed by using `rm -rf /opt/app && mkdir -p /opt/app` to fully remove the directory including dotfiles.

**Modified Files:**
- `src/app/api/auth/callback/route.ts` — Moved `baseUrl` computation above all early returns, all `NextResponse.redirect(new URL(..., request.url))` changed to `new URL(..., baseUrl)`
- `package.json` — Version 0.1.55

**Testing (192.168.31.190):**
- `curl -sI http://10.117.96.245:3000/api/auth/callback` → `location: https://control.skibidi.wtf/login?error=Missing+code+or+state` (was `http://0.0.0.0:3000/...`)
- `spine status` → Control Panel: Running (v0.1.55)
- Process env verified: `CONTROL_EXTERNAL_URL=https://control.skibidi.wtf` present in node process

---

### v0.1.54 (2026-02-09)

**Fix: SSO Redirect URL & Authentik 2025.12 Compatibility**

**Summary:**
Fixed SSO redirect_uri going to `0.0.0.0:3000` instead of the proper subdomain. Added `CONTROL_EXTERNAL_URL` env var for explicit redirect URI control. Updated SSO setup to pass `control_url` to Spine for env injection.

**Problem:**
When the Control Panel runs inside an Incus container with `listen: 0.0.0.0:3000`, the `request.headers.get('host')` returns `0.0.0.0:3000` instead of the actual subdomain. This caused OAuth2 redirect_uri to be set incorrectly, breaking SSO login flow.

**Solution:**
Use `process.env.CONTROL_EXTERNAL_URL` (injected by Spine via systemd EnvironmentFile) as the authoritative source for the redirect URI. Falls back to request headers if env var not set.

**Modified Files:**
- `src/app/api/auth/sso/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI, fixed `secure` cookie flag to use `redirectUri.startsWith('https://')` instead of out-of-scope `proto` variable
- `src/app/api/auth/callback/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI
- `src/lib/auth/sso-setup.ts` - Pass `control_url: params.controlExternalUrl` to `spineClient.setControlSSO()`
- `src/lib/spine/client.ts` - Added `control_url: string` to `setControlSSO` params type
- `package.json` - Version 0.1.54

**Testing (192.168.31.190):**
- SSO setup successful with Authentik 2025.12
- Redirect URI: `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in SSO env file
- Auth mode correctly reports `ssoConfigured: true`

---

### v0.1.53 (2026-02-08)

**Feature: Self-Service SSO Setup via Settings Page**

**Summary:**
Complete SSO implementation allowing the Control Panel to configure its own Authentik SSO through a new Settings page UI. When accessed via IP address, login uses PAM. When accessed via subdomain, login uses Authentik SSO (no PAM option).

**How it works:**
1. Settings page checks prerequisites (domain configured, Authentik + CP subdomains in Caddy, Authentik healthy)
2. "Setup SSO" button creates OAuth2 Provider + Application in Authentik via API
3. Creates groups scope mapping for admin detection via OIDC
4. Spine stores env vars (`AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_INTERNAL_URL`) via systemd drop-in
5. CP restarts with SSO env vars loaded
6. Auth mode detection: PAM on IP access, SSO on subdomain access

**Key Design Decisions:**
- Uses Authentik 2024.12 API paths (`/propertymappings/provider/scope/`, dict-format `redirect_uris`)
- `AUTHENTIK_INTERNAL_URL` (Incus DNS `http://youeye-authentik.incus:9000`) for server-side token exchange to avoid self-signed TLS issues
- `AUTHENTIK_URL` (external URL like `https://id.skibidi.wtf`) for browser redirects
- Systemd EnvironmentFile drop-in (`sso.conf`) for clean env injection that survives CP updates

**New Files:**
- `src/lib/auth/sso-setup.ts` - Core SSO setup/teardown logic (Authentik API calls)
- `src/app/api/auth/sso/status/route.ts` - GET endpoint: SSO prerequisites and configuration status
- `src/app/api/auth/sso/setup/route.ts` - POST endpoint: Execute SSO setup
- `src/app/api/auth/sso/disable/route.ts` - POST endpoint: Disable SSO
- `src/app/(dashboard)/settings/page.tsx` - Settings page with SSO prerequisites checklist and setup/disable buttons

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added Settings nav item
- `src/lib/spine/client.ts` - Added `getControlSSO()`, `setControlSSO()`, `deleteControlSSO()` methods
- `src/lib/auth/authentik.ts` - Added `AUTHENTIK_INTERNAL_URL` for server-side calls, `groups` scope
- `src/middleware.ts` - Block PAM login on subdomain access (403), exact-match SSO public route

**Testing (192.168.31.190):**
- SSO prerequisites all met (domain, subdomains, Authentik health)
- Setup creates OAuth2 provider/app in Authentik, configures env vars
- Auth mode: `pam` on IP, `sso` on subdomain
- SSO redirect to `https://id.skibidi.wtf/application/o/authorize/` with correct params
- PAM login blocked on subdomain with 403 error
- Disable/re-enable cycle works
- Version 0.1.53 deployed and verified

---

### v0.1.51 (2026-02-08)

**Bug Fixes: Updates Page Crash, LAN Port Untick, People Create 500**

**Summary:**
Three bugs found during manual testing on user's test server, plus a backend fix discovered during verification:

1. **Bug 1 - Updates page crash**: `Cannot read properties of undefined (reading 'split')`. The TypeScript `AppInfo` interface used `container` and `image` fields, but Spine API returns `container_name` and `image_tag`. The line `app.image.split(':').pop()` crashed on undefined.
2. **Bug 2 - LAN port checkbox snap-back**: After enabling LAN port, unticking the checkbox and pressing save would visually revert to ticked. The checkbox was controlled by `state.lanEnabled` which only updated after API response, not optimistically.
3. **Bug 2b - LAN port device not removed**: Even with the frontend fix, the Incus PATCH method merges device maps and cannot delete keys. Changed to PUT with full config to properly remove the `lan-web` device.
4. **Bug 3 - People API 500 on create**: `createUser()` succeeded but `setUserPassword()` failed (Authentik password policy), causing 500 that masked successful user creation.

**Modified Files:**
- `src/lib/spine/client.ts` - Fixed `SpineUpdatesCheckResponse.apps` type: `container`→`container_name`, `image`→`image_tag`, added `available: boolean`
- `src/app/(dashboard)/updates/page.tsx` - Fixed `AppInfo` interface, replaced crash-prone `app.image.split(':').pop()` with safe `app.image_tag || 'latest'`
- `src/components/proxy/container-routing-table.tsx` - Optimistic `lanEnabled` state update on checkbox click, revert on API failure
- `src/app/api/containers/[name]/lan-port/route.ts` - Changed PATCH to PUT with full instance config (architecture, config, devices, profiles) so device removal actually works
- `src/app/api/people/route.ts` - Wrapped `setUserPassword()` in separate try/catch, returns `{ success: true, passwordWarning }` instead of 500

**Testing (192.168.31.190):**
- Updates page: returns 200, API returns correct `container_name`/`image_tag` fields
- LAN port: enable (port 8888) adds `lan-web` device, disable removes it completely
- People create: returns `{ success: true, passwordWarning }` instead of 500
- No errors in control panel logs after deployment
- v0.1.51 deployed and verified

---

### v0.1.49 (2026-02-08)

**Multi-Feature: People Tab, Proxy Simplification, Updates Apps, SSO Dual-Auth**

**Summary:**
Four major features implemented in a single release:
1. **CP1 - People Management Tab**: Full user CRUD via Authentik API. List/create/delete users, toggle admin (via "authentik Admins" group), set passwords, show/hide hidden system users.
2. **CP2 - Proxy Simplification**: Rewrote routing table to subdomain-only (removed path routing). Added LAN Port column with checkbox + port input to expose containers directly on host.
3. **CP3 - Updates Page Apps**: Extended updates page with Incus version, system packages count, and app container cards with rebuild button.
4. **CP4 - SSO Dual-Auth**: OAuth2 login via Authentik when accessed through subdomain. IP-based access uses PAM. Auto-detects mode at login.

**New Files:**
- `src/app/(dashboard)/people/page.tsx` - People management page with user table, create form, password dialog
- `src/app/api/people/route.ts` - GET (list users) and POST (create user) with admin group detection
- `src/app/api/people/[id]/route.ts` - PATCH (update user, toggle admin) and DELETE
- `src/app/api/people/[id]/password/route.ts` - POST to set user password
- `src/app/api/containers/[name]/lan-port/route.ts` - POST to add/remove Incus proxy device for LAN port
- `src/lib/auth/authentik.ts` - OAuth2 helper (buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, isSSOConfigured)
- `src/app/api/auth/sso/route.ts` - GET: initiates OAuth2 flow, redirects to Authentik
- `src/app/api/auth/callback/route.ts` - GET: OAuth2 callback, exchanges code, creates JWT session
- `src/app/api/auth/mode/route.ts` - GET: returns 'pam' or 'sso' based on Host header

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added People nav item between DNS and Updates
- `src/components/proxy/container-routing-table.tsx` - Complete rewrite: subdomain-only + LAN port column
- `src/app/(dashboard)/proxy/page.tsx` - Updated description text
- `src/app/api/containers/route.ts` - Added lanPort field with getLanPort() helper
- `src/lib/spine/client.ts` - Extended SpineUpdatesCheckResponse with incus/system/apps, added updateApp()
- `src/app/(dashboard)/updates/page.tsx` - Complete rewrite: Incus/System/App cards, rebuild button
- `src/app/api/updates/[component]/route.ts` - Unknown components now route to updateApp()
- `src/middleware.ts` - Added SSO/callback/mode to PUBLIC_ROUTES
- `src/app/login/page.tsx` - Split into Suspense wrapper + LoginContent, auth mode detection, SSO redirect

**Bug Fix (v0.1.49):**
- LAN port API now checks Incus response for errors (previously returned success even on failure)

**Testing (192.168.31.190):**
- Spine v0.1.27 + CP v0.1.49 deployed, all 7 containers running
- Auth mode API: returns `pam` for IP access, `sso` when configured
- People API: lists Authentik users with admin group detection
- LAN port: successfully adds/removes Incus proxy devices (tested on Pi-Hole port 9999)
- Updates API: returns incus v6.21, system 70 packages, 5 app containers
- Login page loads correctly (200)
- All pages accessible: /updates, /people, /proxy (200)

---

### v0.1.47 (2026-02-08)

**Authentik in Reverse Proxy Routing Table**

**Summary:**
Set `webPort: 9000` in Authentik manifest so it appears in the reverse proxy routing table on the proxy page. Also includes Authentik management page scaffolding (users, groups, stats API routes).

**Code Changes:**
- `src/lib/apps/manifest.ts` - Changed Authentik `webPort: undefined` to `webPort: 9000`
- `src/app/(dashboard)/apps/authentik/page.tsx` - NEW: Authentik management page
- `src/app/api/apps/authentik/stats/route.ts` - NEW: Authentik stats API
- `src/app/api/apps/authentik/users/route.ts` - NEW: Users API
- `src/app/api/apps/authentik/groups/route.ts` - NEW: Groups API
- `src/lib/authentik/client.ts` - NEW: Authentik API client library

**Testing (192.168.31.190):**
- CP v0.1.47 deployed, `spine update control` successful
- Containers API returns Authentik with `webPort: 9000` and `status: running`
- Three containers in proxy routing table: Control Panel (3000), Pi-Hole (80), Authentik (9000)

---

### v0.1.45 (2026-02-08)

**Security: Fetch Pi-Hole Password from Spine API**

**Summary:**
Removed hardcoded `DEFAULT_PIHOLE_PASSWORD` constant. Pi-Hole password is now fetched from Spine's `/api/pihole/credentials` API endpoint. Password changes are synced back to the host file via Spine API.

**Code Changes:**
- `src/lib/spine/client.ts` - Added `SpinePiholeCredentials` interface, `getPiholeCredentials()` (GET), `updatePiholePassword(password)` (POST)
- `src/lib/apps/secrets.ts` - Removed `DEFAULT_PIHOLE_PASSWORD = 'youeye_admin'`; `getPiholePassword()` now fetches from Spine API with systemd env fallback; `setPiholePassword()` syncs to host file via Spine API; `initializePiholePassword()` fetches from Spine if no explicit password; `hasCustomPiholePassword()` checks for empty string instead of comparing to hardcoded default

**Testing (192.168.31.190):**
- CP v0.1.45 deployed and healthy
- Spine Pi-Hole credentials API returns password
- Health check passes

---

### v0.1.44 (2026-02-09)

**PostgreSQL Management UI & SQL Console**

**Summary:**
Added full PostgreSQL management page with 4 tabs (Overview, Databases, SQL Console, Connection Info). Queries PostgreSQL via `incus exec` + psql (no npm pg dependency needed). Includes read-only SQL console for safe query execution.

**Code Changes:**
- `src/lib/postgres/client.ts` - NEW: PostgreSQL client using execShell + psql --csv. Functions: psqlQuery(), parseCSVLine(), queryReadOnly() (wraps in READ ONLY transaction), listDatabases(), getStats()
- `src/lib/incus/server.ts` - Added `incusRawGet()` for fetching exec log file content. Fixed `execCommand()` to fetch stdout/stderr from Incus log file paths instead of returning paths as content.
- `src/lib/apps/manifest.ts` - Added POSTGRES_MANIFEST (postgres:17-alpine)
- `src/lib/spine/client.ts` - Added getPostgresCredentials()
- `src/app/api/apps/postgres/stats/route.ts` - NEW: GET endpoint returning version, uptime, connections, database sizes
- `src/app/api/apps/postgres/databases/route.ts` - NEW: GET endpoint returning database list with owner, encoding, size
- `src/app/api/apps/postgres/query/route.ts` - NEW: POST endpoint for read-only SQL execution with CSRF protection
- `src/app/(dashboard)/apps/postgres/page.tsx` - NEW: 4-tab management page (Overview, Databases, SQL Console, Connection Info)
- `src/app/(dashboard)/apps/page.tsx` - Added PostgreSQL card with database icon and Manage link

**Key Decisions:**
- Used execShell + psql instead of `pg` npm package (Turbopack bundling breaks pg module resolution)
- Added incusRawGet for raw HTTP requests to Incus log endpoints (exec output stored in files, not returned inline)
- Filtered psql command tags (BEGIN, COMMIT, SET) from CSV output to prevent parser confusion
- Connected as `-U youeye` role (not default `postgres` role, since POSTGRES_USER=youeye)

**Bug Fixes (iterations v0.1.38 → v0.1.44):**
- v0.1.38: Initial implementation with `pg` npm package
- v0.1.39: Added serverExternalPackages for pg (didn't fix Turbopack issue)
- v0.1.40: Rewrote to use execShell + psql (removed pg dependency entirely)
- v0.1.41: Fixed execCommand returning log file paths instead of content (added incusRawGet)
- v0.1.42: Fixed psql connecting as wrong role (added `-U youeye`)
- v0.1.43: Fixed uptime query single-quote escaping
- v0.1.44: Filtered psql command tags from CSV output

**Testing (192.168.31.190):**
- 33/33 Playwright e2e tests passing (9 new PostgreSQL tests)
- Stats endpoint: version, uptime, connections, database sizes
- Databases endpoint: youeye + postgres databases with correct owner/encoding
- SQL Console: SELECT queries execute correctly with proper column/row parsing
- Write protection: CREATE TABLE rejected in READ ONLY transaction
- All existing Caddy/Pi-Hole/auth tests still passing

---

### v0.1.37 (2026-02-08)

**Remove install infrastructure, simplify to Spine-deployed apps**

**Summary:**
Removed all container install/deploy functionality from the Control Panel. Apps (Caddy, Pi-Hole, Postgres, Redis, Authentik) are now deployed exclusively by Spine. CP only manages already-deployed containers. Removed ~3000 lines of install code. Container firewall was later removed to allow internet access.

**Code Changes:**
- Deleted: `src/app/api/apps/install/route.ts` (315 lines) - Install API
- Deleted: `src/app/api/test/install-app/route.ts` (405 lines) - Test install API
- Deleted: `src/app/(dashboard)/apps/postgres/page.tsx` (647 lines) - Postgres management UI
- Deleted: `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik page
- Deleted: `src/app/api/apps/postgres/*` (databases, stats, users routes)
- Deleted: `src/app/api/apps/authentik/stats/route.ts`
- `src/lib/apps/manifest.ts` - Simplified from 362 to 53 lines. Only Caddy + Pi-Hole manifests. Removed OCI config generation, parseOCIImage, manifestToIncusConfig.
- `src/lib/apps/registry.ts` - Removed getRegistry, getAppInstance, isBuiltInApp, fetchRemoteRegistry
- `src/types/apps.ts` - Removed 'installing' status, PortMapping, HealthCheck, AppRegistry, InstallAppRequest
- `src/app/(dashboard)/apps/page.tsx` - Rewritten: simple 2-column card grid, no install buttons, Manage links
- `src/app/(dashboard)/proxy/page.tsx` - Removed installCaddy, shows "spine deploy" message when not deployed
- `src/app/(dashboard)/dns/page.tsx` - Removed installPihole, shows "spine deploy" message when not deployed
- `src/middleware.ts` - Removed /api/test/install-app from PUBLIC_ROUTES
- `src/components/proxy/proxy-status-card.tsx` - Removed manifest.version reference
- Removed `@playwright/test` from devDependencies (was added in error)

**Testing (192.168.31.190):**
- 24/24 Playwright e2e tests passing (standalone test suite in YouEye-Agents)
- Verified no install buttons on apps/proxy/dns pages
- Verified no postgres/authentik/redis cards on apps page
- Verified API returns exactly 2 apps (Caddy + Pi-Hole)
- Verified removed API routes return 401/404
- Container has internet access (firewall was later removed)

---

### v0.1.36 (2026-02-07)

**Fix: Pi-Hole password change, auth race condition, wildcard TLS, HTTP redirect**

**Summary:**
Fixed three Pi-Hole bugs and two Caddy HTTPS issues. Password change returned 400 due to field name mismatch. Multiple simultaneous API calls caused 429 rate-limit errors from Pi-Hole FTL. Caddy accumulated redundant per-subdomain TLS certs instead of using wildcard. HTTP did not redirect to HTTPS.

**Root Causes:**
1. `dns/page.tsx` sent `{ password: newPassword }` but backend expected `{ newPassword }`
2. `pihole-api.ts` `getSession()` had no lock - parallel requests all called `authenticate()` simultaneously, triggering Pi-Hole FTL 429 rate-limit
3. `caddy/client.ts` `ensureTLSSubject()` added individual subdomain certs even when `*.domain` wildcard existed
4. `caddy/client.ts` `ensureHTTPSConfig()` added `:80` to server listen array, causing routes to be served on both ports instead of redirecting

**Code Changes:**
- `src/app/(dashboard)/dns/page.tsx` - Fixed field name: `{ password: newPassword }` → `{ newPassword }`
- `src/lib/apps/pihole-api.ts` - Added Promise-based mutex lock to `getSession()` so only first request authenticates, others wait
- `src/lib/caddy/client.ts` - `ensureTLSSubject()`: skip adding subdomain if covered by wildcard
- `src/lib/caddy/client.ts` - `setDomain()`: clean up stale per-subdomain subjects, keep only `domain` + `*.domain`
- `src/lib/caddy/client.ts` - `ensureHTTPSConfig()`: remove `:80` from listen array, let Caddy auto-create redirect server
- `src/lib/caddy/client.ts` - Initial server creation: only listen on `:443`

**Testing (192.168.31.190):**
- Password change: 200 OK (was 400)
- 4 parallel Pi-Hole API calls: all succeeded, no 429 errors (was getting 429)
- TLS subjects cleaned to only `skibidi.wtf` + `*.skibidi.wtf` (was accumulating stale per-subdomain certs)
- Wildcard skip log: `Skipping TLS subject pihole.skibidi.wtf - covered by wildcard *.skibidi.wtf`
- HTTP redirect: 308 Permanent Redirect to HTTPS (was serving routes on port 80)
- HTTPS access: 302 from Pi-Hole (working)
- Server listeners: only `:443` (was `:443` + `:80`)

**IMPORTANT - TLS is self-signed:**
Caddy uses `module: internal` (self-signed via Caddy's internal CA), NOT Let's Encrypt. This is for local LAN only.

---

### v0.1.35 (2026-02-05)

**Fix: Pi-Hole FTL v6 API Authentication**

**Summary:** 
Fixed Pi-Hole integration to use SID URL parameter instead of Cookie header.

**Root Cause:**
Pi-Hole FTL v6+ requires the session ID (`sid`) to be passed as a URL query parameter (`?sid=xxx`), NOT as a Cookie header (`Cookie: sid=xxx`). The previous implementation used Cookie authentication which returned "Unauthorized" errors.

**Code Changes:**
- `src/lib/apps/pihole-api.ts`: NEW FILE - Complete Pi-Hole FTL v6 API client with session management
- Changed `piholeRequest()` to append `?sid=xxx` to URL instead of using Cookie header
- Updated all Pi-Hole route handlers to use new `pihole-api.ts` library

**Endpoints Updated:**
- `/api/apps/pihole/stats` - Uses `getStats()`
- `/api/apps/pihole/queries` - Uses `getQueryLog()`
- `/api/apps/pihole/dns-records` - Uses `getDNSRecords()`, `addDNSRecord()`, `removeDNSRecord()`
- `/api/apps/pihole/cname-records` - Uses `getCNAMERecords()`, `addCNAMERecord()`, `removeCNAMERecord()`
- `/api/apps/pihole/domains` - Uses `getDomainLists()`, `addDomain()`, `removeDomain()`
- `/api/apps/pihole/control` - Uses `setBlocking()`
- `/api/apps/pihole/password` - Added `clearPiholeSession()` call

**Testing:**
- Tested from dev server (192.168.31.190)
- Auth: `POST /api/auth` returns valid session with SID
- Stats with ?sid= parameter returns full summary data
- Cookie authentication confirmed NOT working (returns unauthorized)

---

### v0.1.32 (2026-02-05)

**Bug Fixes: Volume Permissions, Pi-Hole Web Server, Test API Middleware**

**Summary:** 
- Fixed Caddy volume permission issues with `shift: true`
- Fixed Pi-Hole FTL v6+ web server with `FTLCONF_webserver_port`
- Added test endpoint to PUBLIC_ROUTES to bypass JWT auth

**Root Causes:**
1. **Caddy Permission Denied:** Incus UID mapping caused `/data` to be owned by `nobody:nobody` inside container.
   Volume devices need `shift: 'true'` to enable Incus ID shifting.
2. **Pi-Hole Web Interface Down:** FTL v6+ has built-in web server but requires explicit `FTLCONF_webserver_port` env var.
3. **Test API Unauthorized:** Middleware required JWT for all routes - test endpoint uses X-Test-Secret header instead.

**Code Changes:**
- `src/lib/apps/manifest.ts`: Added `shift: 'true'` to disk device config in `manifestToIncusConfig()`
- `src/lib/apps/manifest.ts`: Added `FTLCONF_webserver_port: '80'` to Pi-Hole environment
- `src/middleware.ts`: Added `/api/test/install-app` to PUBLIC_ROUTES

**Testing:**
- Verified Caddy `/data/caddy` owned by `root:root` (not `nobody:nobody`)
- Verified Pi-Hole web interface responds on port 8080 (HTTP 302)
- Test API returns app list successfully

---

### v0.1.31 (2026-02-05)

**Feature: Test Install API Endpoint**

**Summary:** Added `/api/test/install-app` endpoint for automated app installation testing.

**Purpose:**
Provides a secure way for Iris (AI agent) to install/uninstall apps for testing without browser login.

**Security:**
- Requires `TEST_ADMIN_SECRET` environment variable (generated by Spine)
- Validates `X-Test-Secret` header against env var
- Rate limited (5 seconds between requests)
- Logged for audit trail

**API:**
```
GET /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Returns: List of available apps with status

POST /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Body: { "appName": "pihole", "action": "install" | "uninstall" }
  Returns: Success/failure status
```

**Code Changes:**
- `src/app/api/test/install-app/route.ts`: NEW FILE - Secure test endpoint

---

### v0.1.30 (2026-02-05)

**Bug Fix: Pi-Hole Password Change Using Incus REST API**

**Summary:** Rewrote Pi-Hole password change to use Incus REST API instead of shell commands.

**Root Cause:**
The `setPiholePassword()` function in `secrets.ts` was using `exec('incus config set ...')` to store the password.
This fails inside the Control Panel container because there is no `incus` binary installed - the container 
only has access to the Incus Unix socket, not the CLI tools.

**Solution:**
Changed `setPiholePassword()` to use `incusRequest()` to call the Incus REST API via Unix socket:
- Uses `PATCH /1.0/instances/youeye-pihole` to update container config.user.password
- Uses `updateInstanceState()` to restart the container after password change
- Changed `execInControl` to `execLocal` for local command execution

**Code Changes:**
- `src/lib/apps/secrets.ts`:
  - Added imports: `incusRequest`, `updateInstanceState` from `@/lib/incus/server`
  - Rewrote `setPiholePassword()` to use Incus REST API
  - Changed `execInControl` to `execLocal` for retrieving Incus configuration

**Testing:**
- Fresh `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.15 + Control Panel v0.1.30 running
- CSRF endpoint accessible
- Login page loads correctly

---

### v0.1.29 (2026-02-05)

**Bug Fix: CSRF Endpoint Blocked by Middleware**

**Summary:** Added `/api/auth/csrf` to PUBLIC_ROUTES so it can be accessed without authentication.

**Root Cause:**
The CSRF endpoint was returning 401 Unauthorized because middleware blocked unauthenticated access.

**Fix:**
Added `/api/auth/csrf` to PUBLIC_ROUTES array in middleware.ts.

**Code Changes:**
- `src/middleware.ts` - Added `/api/auth/csrf` to PUBLIC_ROUTES

**Testing:**
- CSRF endpoint returns 200 with `{"csrfToken":null}` when no cookie present
- Accessible both internally and externally

---

### v0.1.28 (2026-02-05)

**Bug Fixes: CSRF Endpoint & Pi-Hole DNS Port Binding**

**Summary:** 
1. Created missing CSRF token endpoint
2. Fixed Pi-Hole DNS port 53 conflict with Incus dnsmasq

**Issue 1: CSRF 404**
Pages were fetching `/api/auth/csrf` which didn't exist.

**Fix 1:**
Created CSRF endpoint that reads `ye-csrf` cookie and returns the token.

**Issue 2: Pi-Hole Port 53 Conflict**
Incus dnsmasq binds to bridge IP (10.x.x.x:53). Pi-Hole tried to bind to 0.0.0.0:53 which conflicted.

**Fix 2:**
- Added `getHostExternalIP()` function that reads from `HOST_IP` env var
- Added `fixPiHoleDNSBinding()` that modifies DNS proxy devices to use host external IP instead of 0.0.0.0
- Special handling for `manifest.name === 'pihole'`

**New Files:**
- `src/app/api/auth/csrf/route.ts` - Returns CSRF token from ye-csrf cookie

**Modified Files:**
- `src/app/api/apps/install/route.ts` - Added Pi-Hole DNS binding fix

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- CSRF endpoint returns 200
- Pi-Hole DNS devices will bind to HOST_IP (192.168.31.190)

---

### v0.1.27 (2026-02-05)

**Bug Fix: Pi-Hole Restart Button Not Working**

**Summary:** Added container actions (start/stop/restart) to Pi-Hole control API.

**Root Cause:**
The Pi-Hole control API only accepted `enable` and `disable` actions. When the UI sent a `restart` action, it was rejected as invalid.

**Fix:**
Added container lifecycle actions using Incus REST API:
- `start` - Start the container
- `stop` - Stop the container  
- `restart` - Restart the container (force + stateful)

**Code Changes:**
- `src/app/api/apps/pihole/control/route.ts`:
  - Added `containerAction()` helper function using `incusRequest('PUT', '/1.0/instances/.../state', {...})`
  - Added start/stop/restart to allowed actions array
  - Fixed import: now imports from `@/lib/incus/server` instead of `@/lib/incus/client`

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.27 running (Next.js 16.1.4)
- All services operational

---

### v0.1.26 (2026-02-05)

**Major Feature: Pi-Hole Enhanced Authentication & Local DNS Management**

**Summary:** Added secure password management for Pi-Hole API, persistent storage support, and Local DNS record management (A/CNAME records).

**New Features:**

1. **Secure Password Management**
   - Passwords stored in systemd environment variables (same pattern as JWT_SECRET)
   - Never exposed in logs, URLs, or container configuration
   - Admin can change password from DNS Settings tab

2. **Local DNS Records**
   - Manage A/AAAA records (domain → IP)
   - Manage CNAME records (alias → target)
   - Full CRUD from Control Panel UI

3. **Persistent Storage**
   - Pi-Hole data persists across container restarts
   - Gravity database, custom DNS records, and settings are preserved

4. **Enhanced DNS Page**
   - New "Local DNS" tab for A/AAAA and CNAME record management
   - New "Settings" tab with password management and direct Pi-Hole access link

**New Files:**
- `src/lib/apps/secrets.ts` - Secure password storage using systemd env vars
- `src/app/api/apps/pihole/password/route.ts` - GET/POST password management
- `src/app/api/apps/pihole/dns-records/route.ts` - GET/POST/DELETE A records
- `src/app/api/apps/pihole/cname-records/route.ts` - GET/POST/DELETE CNAME records

**Modified Files:**
- `src/lib/apps/manifest.ts` - Updated PIHOLE_MANIFEST with port 53 and volumes
- `src/app/api/apps/pihole/stats/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/domains/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/queries/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/control/route.ts` - Use dynamic password from secrets
- `src/app/(dashboard)/dns/page.tsx` - Added Settings and Local DNS tabs
- `scripts/postbuild.js` - Resolve symlinks to fix Windows→Linux deployment

**Build Fix:**
The postbuild script now resolves all symlinks in node_modules/ to real files. This fixes the "Cannot find module 'next'" error when deploying from Windows builds.

**Testing:**
- Deployed to dev server 192.168.31.190
- Spine v0.1.12, Control Panel v0.1.26
- Pi-Hole running and accessible

---

### v0.1.25 (2026-02-05)

**Feature: DNS Tab with Pi-Hole UI**

**Summary:** Added dedicated DNS tab to sidebar for Pi-Hole management with quick install and full management UI.

**Changes:**
- Added DNS tab to sidebar navigation
- Added DNS page at `/dns` with Pi-Hole install/management
- Overview, Query Log, and Block Lists tabs

---

### v0.1.22 (2026-02-04)

**Major Feature: Multi-App Management Pages**

**Summary:** Added management UI for core infrastructure apps: PostgreSQL, Authentik, and Pi-Hole. Also fixed critical build issue with pnpm symlinks on Windows.

**New App Pages:**
- `/apps` - Overview page with container status cards for each app
- `/apps/postgres` - PostgreSQL management: stats, databases, users
- `/apps/authentik` - Authentik management: stats, user count
- `/apps/pihole` - Pi-Hole management: stats, queries, domains, enable/disable

**New API Routes:**
- `GET /api/apps/postgres/stats` - PostgreSQL server stats
- `GET /api/apps/postgres/databases` - List databases with sizes
- `GET /api/apps/postgres/users` - List database users
- `GET /api/apps/authentik/stats` - Authentik service stats
- `GET /api/apps/pihole/stats` - Pi-Hole DNS query stats
- `GET /api/apps/pihole/queries` - Recent DNS queries
- `GET /api/apps/pihole/domains` - Whitelisted/blacklisted domains
- `POST /api/apps/pihole/control` - Enable/disable Pi-Hole

**Build Fix: pnpm Symlinks on Windows**

**Root Cause:** Windows tar creates broken symlinks when building pnpm-managed projects. The pnpm `.pnpm/node_modules/` structure uses symlinks that point to Windows paths like `//?/C:/Users/...`. When extracted on Linux, these symlinks are broken and packages like `styled-jsx`, `sharp`, etc. are missing.

**Fix:** Added `scripts/postbuild.js` that:
1. Copies `.next/static/` and `public/` to standalone (existing behavior)
2. Copies all packages from `.pnpm/node_modules/` to top-level `node_modules/`
3. This ensures all dependencies are available as real files, not broken symlinks

**Code Changes:**

*New Files:*
- `src/app/(dashboard)/apps/page.tsx` - Apps overview
- `src/app/(dashboard)/apps/postgres/page.tsx` - PostgreSQL management
- `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik management
- `src/app/(dashboard)/apps/pihole/page.tsx` - Pi-Hole management
- `src/app/api/apps/postgres/stats/route.ts` - PostgreSQL stats API
- `src/app/api/apps/postgres/databases/route.ts` - PostgreSQL databases API
- `src/app/api/apps/postgres/users/route.ts` - PostgreSQL users API
- `src/app/api/apps/authentik/stats/route.ts` - Authentik stats API
- `src/app/api/apps/pihole/stats/route.ts` - Pi-Hole stats API
- `src/app/api/apps/pihole/queries/route.ts` - Pi-Hole queries API
- `src/app/api/apps/pihole/domains/route.ts` - Pi-Hole domains API
- `src/app/api/apps/pihole/control/route.ts` - Pi-Hole control API
- `src/lib/incus/container-ip.ts` - Container IP discovery utility
- `scripts/postbuild.js` - Build fix for pnpm symlinks

*Modified Files:*
- `package.json` - Updated postbuild script to use `node scripts/postbuild.js`
- `src/components/layout/sidebar.tsx` - Added "Apps" navigation link

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Login page loads correctly
- All services running: Spine v0.1.10, Control Panel v0.1.22

**Note:** This version deployed successfully after fixing TWO bugs in Spine v0.1.10:
1. Tar extraction path (--strip-components=1)
2. Health check network isolation (incus exec curl)

---

### v0.1.21 (2026-02-04)

**Bug Fix: Route Detection for Container Routing Table**

**Summary:** Fixed a bug where the Container Routing Table displayed incorrect route information after page refresh. The UI was showing auxiliary routes (like `/favicon.ico`) instead of the main configured route.

**Root Cause:**
When detecting the current route for a container, the API used `.find()` which returns the first matching route. Path routing creates multiple routes: main route, `/_next/*`, and `/favicon.ico`. Since auxiliary routes were added with `unshift()`, they appeared first in the array and were incorrectly displayed.

**Fix:**
- Added `AUXILIARY_ROUTE_PATHS` constant to filter out `/_next/*`, `/_next`, and `/favicon.ico`
- Updated route detection logic to skip auxiliary routes when finding the "main" route

**Code Changes:**
- `src/app/api/containers/route.ts`:
  - Added `AUXILIARY_ROUTE_PATHS` constant
  - Updated route detection to filter auxiliary routes for both system containers and app manifest containers

**Testing:**
- Deployed to dev server (192.168.31.190)
- Verified subdomain route `controlpanel.skibidi.wtf` is configured correctly
- Service running successfully

---

### v0.1.20 (2026-02-04)

**Feature: Path Routing Support for Next.js Apps**

**Summary:** Added support for path-based routing with Next.js apps by creating auxiliary routes for static assets.

**Note:** Path routing still has limitations with Next.js - redirects use absolute paths. Subdomain routing is recommended.

---

### v0.1.19 (2026-02-04)

**Major Feature: Unified Proxy Configuration UI**

**Summary:** Complete redesign of the Proxy page with a unified domain configuration and container routing table. Fixes path-based routing and adds volume mounts for Caddy config persistence.

**New Features:**
1. **Domain Configuration Card** - Single input for base domain with auto-TLS
2. **Container Routing Table** - Shows all YouEye containers with web UIs
3. **Route Type Selection** - Subdomain, path, or none options per container
4. **Path Pattern Normalization** - Automatically fixes `/control` → `/control/*`

**Bug Fixes:**
1. **Path Routes Not Working** - Caddy's `*` wildcard doesn't cross path separators. Fixed by normalizing path patterns to include trailing `/*`
2. **Config Not Persisting** - Added Incus volume mounts for Caddy's `/config` and `/data` directories (requires Caddy reinstall to activate)

**New API Endpoints:**
- `GET /api/containers` - Lists containers with web UIs available for routing
- `GET/POST /api/domain` - Get/set the base domain for routing
- `POST /api/containers/[name]/route` - Set container routing (subdomain/path/none)

**Code Changes:**

*New Files:*
- `src/app/api/containers/route.ts` - Container listing endpoint
- `src/app/api/containers/[name]/route/route.ts` - Route assignment endpoint
- `src/app/api/domain/route.ts` - Domain configuration endpoint
- `src/components/proxy/container-routing-table.tsx` - New routing table component
- `src/components/ui/select.tsx` - Radix Select component

*Modified Files:*
- `src/lib/caddy/client.ts`:
  - Added `normalizePathPattern()` - Ensures `/path/*` format
  - Updated `formDataToRoute()` and `addRoute()` to return warnings
  - Added `setContainerRoute()`, `getConfiguredDomain()`, `setDomain()`
- `src/lib/apps/manifest.ts`:
  - Added `volumes` to CADDY_MANIFEST for `/config` and `/data`
  - Added `webPort` field to all manifests
  - Updated `manifestToIncusConfig()` to handle volumes
- `src/types/apps.ts`:
  - Added `volumes` and `webPort` to AppManifest interface
- `src/app/api/apps/install/route.ts`:
  - Added `ensureHostDirectories()` for volume mount directories
- `src/app/(dashboard)/proxy/page.tsx`:
  - Removed old TLSCard/RouteList/RouteFormDialog
  - Added domain input card and ContainerRoutingTable
- `package.json`:
  - Added `@radix-ui/react-select` dependency
  - Version: 0.1.18 → 0.1.19

**Technical Details:**

*Path Pattern Normalization:*
```typescript
// Input: /control → Output: /control/*
function normalizePathPattern(pattern: string): { pattern: string; modified: boolean }
```
Caddy's `*` wildcard matches any characters BUT doesn't cross `/` separators.
- `/control*` matches `/controlABC` but NOT `/control/dashboard`
- `/control/*` matches `/control/dashboard`

*Container Route Assignment:*
```typescript
setContainerRoute(domain, containerName, port, routeType, routeValue)
// routeType: 'subdomain' | 'path' | 'none'
// Example path: domain=skibidi.wtf, routeValue=/control → skibidi.wtf/control/*
```

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- `/api/containers` returns containers with webPort correctly
- `/api/domain` returns configured domain (skibidi.wtf)
- Path route `/control` normalized to `/control/*` in Caddy config
- Route works: `curl -k https://skibidi.wtf/control/` returns 307 redirect
- Caddy includes rewrite handler to strip path prefix before forwarding

**Notes:**
- Volume mounts require Caddy reinstall to activate (existing Caddy won't have them)
- Host authentication uses Spine API's `/api/auth/verify` (PAM on host, not container)
- Default host root password: set via `chpasswd` on host

---

### v0.1.18 (2026-02-04)

**Bug Fix: Admin groups not passed to isAdmin check during login**

**Root Cause:** The login route was calling `getUserGroups(username)` which always returned `[]`, then calling `isAdmin(username)` without the groups. This meant only `root` users were recognized as admin, even though users like `youeye` are in the `sudo` group.

**Fix:** Use `authResult.groups` from PAM authentication result and pass to `isAdmin(username, groups)`.

**Code Changes:**
- `src/app/api/auth/login/route.ts` - Use groups from auth result, remove unused getUserGroups import

**Testing:**
- Deployed to dev server 192.168.31.190
- User `youeye` (in sudo group) should now be recognized as admin after re-login

**Note:** Users must log out and log back in to get a new session with the correct admin status.

---

### v0.1.17 (2026-02-04)

**Bug Fix: Static Files Missing in Standalone Build**

**Root Cause:** Next.js standalone output doesn't automatically copy `.next/static/` and `public/` folders. CSS/JS files were returning 404 or being served with `text/plain` MIME type, causing browsers to refuse loading them with strict MIME checking.

**Fix:** Added `postbuild` script to copy static files into standalone folder.

**Code Changes:**
- `package.json` - Added postbuild script: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`
- `package.json` - Build script now explicitly runs postbuild: `next build && pnpm run postbuild`
- Version bump: 0.1.16 → 0.1.17

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Verified CSS returns `Content-Type: text/css; charset=UTF-8`
- Verified JS returns `Content-Type: application/javascript; charset=UTF-8`  
- Verified fonts return `Content-Type: font/woff2`
- No MIME type errors in browser console

**Note for Windows builds:** The `cp` command doesn't work on Windows. Use PowerShell:
```powershell
Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static"
Copy-Item -Recurse -Force "public" ".next\standalone\public"
```

---

### v0.1.16 (2026-02-04)

**Changes:**
- Secured Caddy Admin API: removed external port 2019 exposure
- Added route ordering by specificity (sortRoutes function)
- Enhanced TLS automation for hostname handling
- Added request timeout (10s) and retry logic with exponential backoff
- Added route verification after config application
- Improved initial Caddy config generation
- Added comprehensive logging for Caddy operations

**Code Changes:**
- `src/lib/apps/manifest.ts` - Removed adminPort from CADDY_MANIFEST
- `src/lib/caddy/client.ts` - Major refactoring with timeout/retry, sorting, verification
- `package.json` - Version bump

**Testing:**
- Deployed to dev server 192.168.31.190
- Verified port 2019 NOT exposed externally (SECURE)
- Verified internal Caddy API access works
- HTTP/HTTPS ports working

---

## Architecture Notes

### Caddy Integration
- Control Panel communicates with Caddy via Incus DNS: `http://youeye-caddy.incus:2019`
- Admin API NOT exposed to host network (security requirement)
- Caddy configured to bind admin API to `0.0.0.0:2019` inside container
- Config persistence via `--resume` flag: auto-saves to `/config/caddy/autosave.json`, reloads on restart
- No `/config` volume mount — Caddy uses its internal container filesystem for XDG_CONFIG_HOME
- `/data` volume mounted for TLS certificate persistence across container recreation

### Key Files
- `src/lib/caddy/client.ts` - Caddy Admin API client
- `src/lib/caddy/types.ts` - TypeScript types for Caddy config
- `src/lib/apps/manifest.ts` - App manifests including Caddy
- `src/app/api/caddy/*` - API routes for Caddy management

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Playwright Testing](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Playwright-Testing)** — **MANDATORY** browser testing for all Control Panel changes
- **[Control Panel](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Control-Panel)** — Complete Control Panel documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning
## v0.2.13.1 — mike — 2026-04-01 (revision 2)
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** BUG-032 fix — ensurePingRoute() after Translate app Caddy route insertion

### Changes
- `src/lib/native-apps/installer.ts` — BUG-032: Added `ensurePingRoute()` call after Caddy route insertion in `installTranslate()`. Also added `ensurePingRoute` to the import from `@/lib/caddy/client`. Without this, the Translate app's route insertion at position 0 displaces the ping route, breaking `https://domain/api/ping`.

### Test Results
- Verified `https://mikevm.test/api/ping` returns `{"status":"ok"}` after manual route re-pinning
- BUG-032 fix prevents displacement on next fresh Translate install

### Notes for Iris
- The BUG-032 fix prevents regression on clean installs. On existing installs (like mikevm), ping must be manually re-pinned once (done via Caddy API for this session)
- This pattern matches what other app installers do in deploy/reconfigure paths

## v0.2.13.1 — mike — 2026-04-01
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Translate support — installer, catalog, uninstaller

### Changes
- `src/lib/native-apps/catalog.ts` — Added ye-translate/translate entries to nativeContainerName and nativeGiteaRepo maps
- `src/lib/native-apps/installer.ts` — Added installTranslate() function (8-step, follows Notes pattern exactly), added ye-translate to installNativeApp dispatcher, added ye-translate to ssoSlugMap, added PostgreSQL cleanup for ye-translate in uninstaller

### Test Results
- installTranslate() exercised via App Market on mikevm — 10-step install completed successfully
- App runs as ye-app-translate container, health endpoint responds 200

### Notes for Iris
- installTranslate follows installNotes pattern exactly — same 8 steps
- Uses TRANSLATE_EXTERNAL_URL env var (not NOTES_EXTERNAL_URL)
- PostgreSQL: ye_translate user + ye_translate database
- Authentik slug: ye-translate
- Container: ye-app-translate
- Merge order: YE-ControlPanel before YE-AppMarket

## v0.2.9.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 5 QA bugs from v0.2.9 (BUG-021 through BUG-025)

### Changes
- `src/app/setup/page.tsx` — BUG-021: Detect ye-setup-language cookie on page load to skip past language selection after reload; avoids infinite language step loop
- `src/app/api/setup/language/route.ts` — BUG-021: Set cookie httpOnly=false so client JS can detect it
- `src/lib/caddy/client.ts` — BUG-022: New ensurePingRoute() adds /api/ping at route position 0 (before host-matched routes) so Spine health checks work on any domain
- `src/app/api/setup/run/route.ts` — BUG-022: Call ensurePingRoute during setup wizard Caddy step
- `src/lib/infrastructure/deployer.ts` — BUG-022: Call ensurePingRoute in both deploy and reconcile paths (including when Caddy is already running)
- `src/lib/native-apps/installer.ts` — BUG-023: Add trailing newline to all env file writes (wiki, search, notes) to prevent line concatenation
- `src/lib/health/service.ts` — BUG-024: Add 1-retry with 1s delay to Authentik, Caddy, and Spine health checks to reduce transient false positives
- `src/lib/market/installed-apps.ts` — BUG-025: Replace 'su - postgres -c "psql..."' with 'psql -U youeye' directly (BusyBox su incompatibility)
- `package.json` — version bump to 0.2.9.1

### Test Results
- Build: successful standalone tarball (242MB)
- BUG-022: curl -sk https://johnvm.test/api/ping returns {"status":"ok"}
- BUG-025: installed_apps table exists (verified via psql -U youeye)
- All 7 containers RUNNING

### Notes for Iris
- BUG-022 fix adds a Caddy route at position 0 without host matcher; this is intentional to override host-matched routes for /api/ping
- BUG-025 fix uses psql -U youeye instead of su postgres; all future psql calls should use this pattern for BusyBox compatibility
- BUG-023 fix adds trailing newline to ALL native app env writes; existing malformed env files will be fixed on next app reinstall

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Search engine detection in installer + catalog cache resilience + dynamic native app discovery

### Changes
- `src/lib/native-apps/installer.ts` — detectSearchEngine() checks installed_apps DB + install.json metadata; installSearch() writes SEARCH_ENGINE_TYPE + SEARCH_ENGINE_URL env vars; step count increased from 7 to 8
- `src/lib/market/catalog.ts` — catalog cache persistence at /var/lib/youeye/catalog-cache.json; fetchCatalog() saves to disk on success, loads from cache on failure; getNativeApps() filters catalog by type: native; getCatalogCacheAge() for UI display; refreshCatalog() for manual refresh
- `src/lib/market/schema.ts` — CatalogEntrySchema extended with optional type field (native | marketplace)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- catalog.yaml now has type: native entries for wiki and search — CatalogEntrySchema accepts optional type with default 'marketplace'
- /var/lib/youeye/catalog-cache.json is created at runtime — no migration needed

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Improved setup wizard + language propagation + install from URL

### Changes
- `src/app/setup/page.tsx` — Complete rewrite: language selection as Step 0 (5 languages with flags), step progress indicator ("Step N of M" with stepper), smooth fade/slide transitions (200ms), contextual help expandable per step, mobile-friendly layout
- `src/app/setup-complete/page.tsx` — Confetti animation on completion, personalized welcome message, quick start links (dashboard, marketplace, docs)
- `src/app/api/setup/language/route.ts` — New endpoint: stores setup language in cookie for pre-setup i18n resolution
- `src/i18n/request.ts` — Added ye-setup-language cookie resolution before system/user language
- `src/lib/language/service.ts` — New LanguageService: propagateLanguageToAll() cascades to Authentik locale, app container env vars via Incus API
- `src/app/api/ui-bridge/user/language/route.ts` — New bridge endpoint: PATCH triggers full language propagation pipeline
- `src/app/api/market/validate-url/route.ts` — New endpoint: SSRF-safe manifest URL validation (HTTPS only, blocks RFC1918 IPs)
- `src/app/api/market/install-url/route.ts` — New endpoint: SSE install from URL with audit logging
- `src/components/market/install-from-url-dialog.tsx` — New dialog: URL input, manifest preview with capabilities, subdomain config, SSE install progress
- `src/app/(dashboard)/market/page.tsx` — Added "Install from URL" button in marketplace header
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSource() for URL source tracking (source + source_url columns)
- `messages/*.json` — New i18n keys for setup wizard (stepOf, help texts) and setup-complete (welcomeUser, quickStart) in all 5 locales

### Test Results
- Build: Both YE-ControlPanel and YE-UI build successfully
- Deploy: lisavm running v0.2.8.1, 7 containers running, 0 stopped

### Notes for Iris
- New DB columns: installed_apps.source (TEXT) and installed_apps.source_url (TEXT) — added via ALTER TABLE IF NOT EXISTS, safe for existing data
- New i18n keys in all 5 locale files — merge carefully if other agents added keys in the same section
- YE-UI has a new PATCH handler in admin proxy catch-all — needed for language propagation bridge calls
## v0.2.7.1 — john — 2026-03-30 (bugfix update)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 4 bugs from Cycle 2 testing (BUG-016, BUG-017, BUG-018, BUG-019)

### Changes
- `src/middleware.ts` — BUG-016: When setup is complete and accessed via IP+Caddy, let request through instead of redirecting to /setup-complete interstitial. BUG-017: Added /api/ping to PUBLIC_ROUTES.
- `src/app/api/ping/route.ts` — BUG-017: New unauthenticated health-check endpoint for Spine post-update verification. Returns `{"status":"ok"}`.
- `messages/en.json`, `ru.json`, `de.json`, `es.json`, `fr.json` — BUG-018: Added missing i18n keys `market.builtForYouEye` and `market.orphanScanPrompt` to all 5 locale files.
- `src/lib/health/service.ts` — BUG-019: Pi-Hole health check switched from HTTP API (returns 401 in v6) to exec-based `pihole status`. PostgreSQL check switched from `su - postgres` (fails with BusyBox) to `pg_isready`. Restructured health dispatch for clarity.

### Test Results
- /api/ping returns 200 without auth (verified via curl through Caddy)
- pihole status and pg_isready both work inside containers
- CP starts and runs correctly after deploy

### Notes for Iris
- /api/ping is a new public route — no auth required, by design
- Health check for Pi-Hole now uses exec-based approach (container name, not IP)
- Health check for PostgreSQL uses pg_isready instead of psql via su
- Caddy health check unchanged (was already working correctly)

## v0.2.7.1 — john — 2026-03-30
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cycle 2 polish fixes + LXD update path mismatch (BUG-012)

### Changes
- `src/lib/health/service.ts` — CPU delta-sampling: in-memory map tracks cumulative nanoseconds, computes real CPU % between polls. Spine returns cpuPercent: -2 (N/A). First poll returns -1 (no baseline).
- `src/app/(dashboard)/health/page.tsx` — Added CPU % display with Cpu icon alongside memory bar. Shows N/A for Spine, dash for first poll.
- `src/app/api/market/route.ts` — New: GET /api/market convenience route (re-exports catalog handler)
- `src/lib/native-apps/installer.ts` — installSearch() now calls saveInstallMetadata() (was missing). Uninstaller now removes Authentik OAuth2 for search. Both installers detect previous keepData installs.
- `src/lib/apps/lxd-updater.ts` — Added getServiceWorkingDir() helper using systemctl show. updateLXDApp() resolves real WorkingDirectory from systemd before file operations. Emits SSE note when paths differ (BUG-012 fix).
- `src/lib/apps/lxd-updates.ts` — getLxdAppVersion() fallback now uses systemctl show instead of grep for consistency with lxd-updater.
- `package.json` — Version bump to 0.2.7.1

### Test Results
- Playwright: 4 screenshots, 2 tests passed
- Screenshots: Tests/John/20260330_1/

### Notes for Iris
- Health dashboard cpuPercent field added to ServiceHealth interface — frontend and API both updated
- LXD updater path resolution is backward-compatible: if systemctl show fails, falls back to configured appDir
- installSearch() metadata fix ensures uninstall works correctly for search app

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — CP orchestrator, SSE progress, backup page, manifest backup schema

### Changes
- `src/lib/backup/types.ts` — backup types: config, events, manifest backup section, app backup plan
- `src/lib/backup/service.ts` — backup orchestrator: enumerate targets, dump PostgreSQL, call Spine, poll status
- `src/app/api/backup/run/route.ts` — SSE endpoint for triggering and streaming backup progress
- `src/app/api/backup/status/route.ts` — polls Spine for current backup status
- `src/app/(dashboard)/backup/page.tsx` — backup configuration and progress UI page
- `src/lib/spine/client.ts` — startBackup() and getBackupStatus() methods
- `src/lib/market/schema.ts` — BackupSchema: stopOrder, startOrder, ownPostgres, volumes, exclude
- `src/lib/market/types.ts` — BackupSpec type export
- `src/components/layout/sidebar.tsx` — added Backup navigation item
- `messages/{en,ru,fr,es,de}.json` — i18n for Backup sidebar label
- `package.json` — version bump to 0.2.7.1

### Test Results
- CP backup status endpoint responds correctly (requires auth)
- Full backup pipeline tested via Spine API: archive created, encrypted, decryptable
- Platform healthy after deploy: 7 running, 0 stopped

### Notes for Iris
- New lib/backup/ directory with service and types
- New API routes: /api/backup/run (SSE), /api/backup/status
- New page: /backup in dashboard sidebar
- Manifest schema extended with optional backup: section
- No database migrations needed

## v0.2.7.1 — ben — 2026-03-30
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** App version pinning + system health notifications

### Changes
- `src/lib/market/installed-apps.ts` — New installed_apps PostgreSQL table: CRUD, migration from install.json, update detection via version comparison
- `src/lib/market/version-checker.ts` — Background job (6h cycle): compare installed vs catalog versions, track update availability
- `src/lib/market/schema.ts` — Added `version` field to AppManifestSchema, `latestVersion` to CatalogEntrySchema
- `src/lib/market/types.ts` — Added `version` to MarketApp, `installedVersion` to InstallMetadata
- `src/lib/market/catalog.ts` — Include `version` in manifestToMarketApp conversion
- `src/lib/market/engine.ts` — Save installedVersion to both install.json and installed_apps DB on install
- `src/lib/market/uninstaller.ts` — Remove from installed_apps DB on uninstall
- `src/lib/health/monitor.ts` — Background health monitor (60s cycle): service state transitions, disk/memory/cert/update alerts
- `src/lib/health/notification-bridge.ts` — CP-to-UI notification delivery via bridge token auth
- `src/lib/health/index.ts` — Exported monitor and bridge modules
- `src/app/api/ui-bridge/notifications/route.ts` — New POST endpoint for creating notifications in YE-UI
- `src/app/api/ui-bridge/market/route.ts` — Added updates, installed-versions, refresh-catalog actions with version data
- `src/app/api/health/services/route.ts` — Side-effect imports to start monitor and version checker
- `package.json` — Bumped to 0.2.7.1

### Test Results
- Build: TypeScript compilation passes
- Screenshots: Tests/Ben/20260330_1/

### Notes for Iris
- New `installed_apps` PostgreSQL table is auto-created on first use (no manual migration needed)
- install.json files are migrated to DB on first boot — keep both during transition
- Health monitor sends notifications to all admin users via bridge token
- YE-UI notification POST route now accepts bridge token auth (not just session cookies)
- Version checker runs 45s after startup (after update-cache at 30s)

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** SMTP email configuration + user avatar bridge endpoint

### Changes
- `src/app/(dashboard)/settings/page.tsx` — SMTP settings card: host, port, username, password, from, TLS toggle, test button, status display
- `src/app/api/settings/smtp/route.ts` — GET/POST SMTP config (non-sensitive fields via SettingsService, password to secrets file)
- `src/app/api/settings/smtp/test/route.ts` — POST send test email via configured SMTP to admin address
- `src/app/api/ui-bridge/user/avatar/route.ts` — Bridge endpoint: receive multipart avatar from YE-UI, sync to Authentik via set_avatar API
- `src/lib/settings/service.ts` — Extended PlatformSettings with smtpHost, smtpPort, smtpFrom, smtpUsername, smtpRequireTls; KEY_MAP/REVERSE_KEY_MAP updated
- `src/lib/smtp/authentik-sync.ts` — Patch Authentik email stage and brand with SMTP credentials after save
- `src/lib/smtp/mailer.ts` — nodemailer wrapper for test email sending
- `src/lib/smtp/secrets.ts` — Read/write SMTP password to /var/lib/youeye/control/.secret_smtp_password (0600)
- `src/lib/market/variables.ts` — Added smtp.* namespace: host, port, username, password, from, tls, configured
- `src/lib/market/engine.ts` — Inject smtp.* vars for apps with capabilities.smtp: true
- `src/lib/market/types.ts` — Added smtp capability to CapabilitiesSchema
- `messages/{en,ru,de,es,fr}.json` — SMTP i18n keys
- `package.json` — bumped to 0.2.6.1

### Test Results
- Playwright: 5 tests, 5 passed — CP landing loads, CP settings has SMTP section, UI SSO login, UI profile avatar section, Avatar API endpoint
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- SMTP password stored at /var/lib/youeye/control/.secret_smtp_password — ensure volume persists across CP updates
- Avatar bridge uses multipart/form-data — Authentik set_avatar API receives the file directly
- smtp.* namespace resolves empty strings when SMTP not configured — apps install fine without it

---

---

 HEAD

## v0.2.6.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Unified app market + app lifecycle management

### Changes
- `src/lib/market/schema.ts` — Add `type` field (native/marketplace), `NativeConfigSchema`, make `containers` optional for native apps, add `native` category to metadata
- `src/lib/market/types.ts` — Add `type` to `MarketApp`, add `UninstallOptions`, `UninstallVerification`, `OrphanResource` types, add `NativeConfig` type
- `src/lib/market/catalog.ts` — Include `type` in `manifestToMarketApp()` conversion
- `src/lib/market/authentik.ts` — Export `getAuthentikConfig()` and `authentikAPI()` for orphan detector
- `src/lib/market/uninstaller.ts` — Complete rewrite: unified for marketplace + native, Pi-Hole DNS cleanup, keepData option, post-uninstall verification
- `src/lib/market/orphan-detector.ts` — New: detect orphaned Caddy routes, Authentik apps, PostgreSQL DBs, containers, volume dirs
- `src/lib/native-apps/catalog.ts` — Remove hardcoded `NATIVE_APP_CATALOG`, keep only utility functions (`nativeContainerName`, `nativeGiteaRepo`)
- `src/lib/native-apps/installer.ts` — Save `InstallMetadata` after wiki install for unified tracking
- `src/app/api/market/install/route.ts` — Unified: routes to native installer for `type: native`
- `src/app/api/market/uninstall/route.ts` — Accept `keepData` param, use options object
- `src/app/api/market/status/route.ts` — Include native app containers in status (pre-migration support)
- `src/app/api/market/catalog/route.ts` — Comment update (unified)
- `src/app/api/admin/orphans/route.ts` — New: GET detects orphans, POST cleans up
- `src/app/api/ui-bridge/market/route.ts` — Fix uninstaller call signature
- `src/app/(dashboard)/market/page.tsx` — Unified: single app grid, "Built for YouEye" section, orphan section, uninstall dialog
- `src/components/market/app-card.tsx` — Add "YouEye" badge for native apps, add BellRing/Shield icons
- `src/components/market/uninstall-dialog.tsx` — New: keep-data/delete-all confirmation dialog
- `src/components/market/orphan-section.tsx` — New: orphan scan + cleanup UI
- `src/app/api/market/native/` — **Deleted** (3 route files): functionality moved to unified routes
- `package.json` — Bump to 0.2.6.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/Ben/20260329_3/
- /api/market/catalog returns 9 apps (2 native + 7 marketplace)
- /api/market/native correctly returns 404
- /api/admin/orphans detected 3 orphans from previous installs
- Unified market page renders with "Built for YouEye" section

### Notes for Iris
- `/api/market/native/*` routes removed — any UI or bridge code referencing these needs updating
- `uninstallApp()` signature changed from `(appId, boolean)` to `(appId, options)` — already fixed in ui-bridge
- Native app IDs in manifests are `wiki`/`search` (not `ye-wiki`/`ye-search`) — native installer maps them internally
- AppMarket repo needs the matching `ben` branch merged for manifests to be available on `dev`/`main`

---

 HEAD
## v0.2.6.1 — john — 2026-03-29 (resume: Playwright tests)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Setup wizard hardening — Playwright test suite (resume session)

### Changes
- No new code changes — test files only (stored locally in Tests/John/20260329_2/)

### Test Results
- `setup-wizard-partial-resume.spec.ts` — PASS (State A: setup completed in background, Go link visible, resume correctly reflected)
- `setup-wizard-double-run.spec.ts` — PASS (Run 1 completed with DNS retry failure visible + Retry button; Run 2 redirected to /setup-complete without errors)
- `cycle0-full.spec.ts` — PASS (SSO login, theme switching, API v1 paths, settings page, login error page)
- Total screenshots: 36 across all 3 test sessions
- Videos: recorded for each test run (test-results/)
- BUG-011 verified RESOLVED — no duplicate Authentik providers on re-run, DNS failure visible (not silent)
- Screenshots: Tests/John/20260329_2/

### Notes for Iris
- No new build needed — code unchanged from previous session (john-v0.2.6.1)
- Setup wizard hardening fully tested and verified

---

## v0.2.6.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Search native installer to Control Panel

### Changes
- `src/lib/native-apps/installer.ts` — Added `installSearch()` (7-step: secrets, Authentik OAuth2, LXD deploy, env file, health check, Caddy route, done); updated `installNativeApp()` dispatcher to route `ye-search` appId
- `src/lib/native-apps/catalog.ts` — Set `supportsSSO: true` for ye-search (was false)
- `package.json` — bumped to 0.2.6.1

### Test Results
- YE-App-Search installed successfully on mikevm.test via CP marketplace
- 7-scenario Playwright test suite passed for Search app (see YE-App-Search AGENTS.md)
- Screenshots: Tests/Mike/20260329_2/

### Notes for Iris
- installSearch() follows same pattern as installWiki() — Authentik OAuth2 client creation, LXD container deploy, env file, Caddy route
- Whoogle must be installed first (container: app-whoogle.incus) — Search connects to it via WHOOGLE_URL env var
- WHOOGLE_URL default in Search app code is `http://app-whoogle-main.incus:5000` but installer sets correct container name

---

## v0.2.6.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Platform Health Dashboard + Setup Wizard Hardening (BUG-011)

### Changes
- `src/lib/health/service.ts` — Health check service querying 5 services via Incus state + per-service endpoints
- `src/lib/health/index.ts` — Health module exports
- `src/app/api/health/services/route.ts` — GET /api/health/services endpoint
- `src/app/api/health/services/[slug]/restart/route.ts` — POST restart endpoint per service
- `src/app/(dashboard)/health/page.tsx` — Health dashboard page with service cards, status badges, memory bars
- `src/app/(dashboard)/page.tsx` — Added compact health dots row + degraded service banner
- `src/components/layout/sidebar.tsx` — Added Health link with HeartPulse icon
- `src/app/api/setup/run/route.ts` — Full idempotency rewrite: check-before-create, 3-retry DNS, per-step persistence
- `src/app/api/setup/steps/route.ts` — GET/DELETE setup step state API for resume/retry
- `src/app/setup/page.tsx` — Added retry button per failed step, connectivity indicators, resume support
- `messages/{en,ru,de,es,fr}.json` — Added health + sidebar i18n keys
- `package.json` — Version bump to 0.2.6.1

### Test Results
- Playwright: health page renders with all 5 service cards, dashboard health dots visible
- Screenshots: Tests/John/20260329_1/screenshots/

### Notes for Iris
- New health page at /dashboard/health — no migrations needed
- Setup wizard hardening (BUG-011): setup_steps field added to youeye.yaml — backward compatible
- Merge before any other CP changes — contains setup wizard rewrite

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Update native app YOUEYE_API_URL to /api/v1 path

### Changes
- `src/lib/native-apps/installer.ts` — YOUEYE_API_URL env var now includes /v1 suffix
- `package.json` — bumped to 0.2.5.1

### Test Results
- Tested as part of YE-UI deployment — CP updated to 0.2.5.1 successfully

### Notes for Iris
- Merge with YE-UI (john first). Native apps installed after this change will get the correct v1 URL.

---
## v0.2.5.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Authentik named server ID + notification infrastructure (ntfy + capabilities)

### Changes
- `src/app/setup/page.tsx` — Add "Identity Provider Name" field to setup wizard Step 0 with auto-default "${siteName} ID"
- `src/app/api/setup/run/route.ts` — Store authentik_name in config, set Authentik brand title, rename UI OAuth2 from "${siteName} UI" to "${siteName}"
- `src/app/(dashboard)/settings/page.tsx` — Add Identity Provider settings card for post-setup renaming
- `src/app/api/settings/identity-provider/route.ts` — New API: update authentik_name in config + Authentik brand title
- `src/app/api/setup/reconfigure/route.ts` — Accept authentik_name in reconfigure flow
- `src/lib/reconfigure/index.ts` — Add authentik_name to ReconfigureRequest and patchConfig
- `src/lib/market/types.ts` — Extend VariableContext with authentik.name and ntfy namespace, add Capabilities type
- `src/lib/market/variables.ts` — Add ntfy and authentik.name to variable resolver
- `src/lib/market/schema.ts` — Add CapabilitiesSchema and "system" category to metadata
- `src/lib/market/engine.ts` — Populate authentik.name from config, populate ntfy context for apps with push capability
- `messages/{en,de,es,fr,ru}.json` — i18n keys for authentikName, identityProvider

### Test Results
- Build: pnpm build passes, standalone.tar created (236MB)
- Playwright: 5/5 tests pass (CP landing, config API, SSO login + settings navigation, ntfy manifest, Memos capabilities)
- Screenshots: Tests/Lisa/20260329_1/ (10 screenshots including settings page with Identity Provider section)
- Identity Provider section confirmed visible at `control.lisavm.test/settings` with "YouEye ID" default value

### Notes for Iris
- Merge Lisa AFTER Mike if Mike modifies SettingsService — Lisa uses direct spineClient.patchConfig
- New "system" category in metadata schema — existing apps use search/social/productivity/media
- CapabilitiesSchema is optional and backward-compatible — existing manifests pass without it
- authentik_name field in youeye.yaml is new — Spine will store it transparently via patchConfig
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Settings Service Foundation + User Identity Foundation (setup wizard names)

### Changes
- `src/lib/settings/service.ts` — New SettingsService class with typed getAll/get/set/getRaw/setRaw/invalidate + 5s cache
- `src/lib/settings/index.ts` — Re-export barrel
- `src/app/api/settings/route.ts` — New admin-only GET/PATCH endpoint for typed platform settings
- `src/lib/site-config.ts` — Migrated from spineClient.getConfig() to settingsService.getRaw()
- `src/lib/reconfigure/index.ts` — 3 getConfig + 1 patchConfig migrated to settingsService
- `src/app/api/ui-bridge/config/route.ts` — Migrated GET/PATCH to settingsService
- `src/app/api/ui-bridge/language/route.ts` — Migrated to settingsService
- `src/app/api/setup/config/route.ts` — Migrated to settingsService
- `src/app/api/setup/run/route.ts` — Migrated patchConfig + added firstName/lastName to admin creation
- `src/app/api/domain/route.ts` — Migrated to settingsService
- `src/lib/market/catalog.ts` — Migrated to settingsService
- `src/lib/infrastructure/lxd-deployer.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updater.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updates.ts` — Migrated to settingsService
- `src/app/setup/page.tsx` — Added firstName/lastName fields to setup wizard Step 1
- `messages/*.json` — Added firstName/lastName i18n keys (all 5 languages)

### Test Results
- Playwright: 4 tests, all passed
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- CP dashboard, settings API, UI SSO login, profile settings page all verified

### Notes for Iris
- spineClient.getConfig/patchConfig still exist as transport — DO NOT remove
- New /api/settings endpoint is admin-only (getSession check)
- Setup wizard now sends admin_first_name/admin_last_name in POST body
- Merge Mike AFTER John if John adds /api/v1/ routes

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `src/lib/apps/lxd-updates.ts` — `getLxdAppLatestVersion()` now compares branch winner vs main winner and returns whichever is newer
- `src/lib/apps/lxd-updater.ts` — `getLatestRelease()` same fix: compare both, pick newer
- `src/lib/infrastructure/lxd-deployer.ts` — Python download script in `installNodeAndApp()` rewritten to collect all releases, find highest branch and main, compare, use winner
- `package.json` — bumped version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed (login + dashboard, settings page), 1 failed (selector for Updates link — not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after CP update

### Notes for Iris
- This fix changes release resolution in CP for UI, Wiki, and Search deployments/updates. Same behavior change as Spine fix: stale branch tags no longer preferred over newer main releases.
- Paired fix in YE-Spine (same logic, `internal/releases/releases.go`)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status and inline progress

### Changes
- `src/lib/updates/state.ts` — New: PostgreSQL-backed update status manager (create table, upsert, read, unified aggregation from Spine + DB)
- `src/app/api/updates/status/route.ts` — New: GET endpoint returning unified update statuses
- `src/app/api/updates/[component]/route.ts` — Added status tracking (startUpdate/completeUpdate/failUpdate) around all update triggers
- `src/app/api/ui-bridge/updates/status/route.ts` — New: bridge endpoint for UI to read statuses
- `src/app/api/ui-bridge/updates/[component]/route.ts` — New: bridge endpoint for UI to trigger updates
- `src/app/api/ui-bridge/updates/clear/route.ts` — New: bridge endpoint to clear completed/failed statuses
- `src/app/(dashboard)/updates/page.tsx` — Rewritten: Updates Available section at top, inline progress per component, confirmation for self-destructive updates, auto-refresh on completion
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/spine/client.ts` — Added getUpdateStatus() and updateUI() methods, removed duplicate updateUI
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: CP updates page shows all components with versions
- Playwright: 8 tests, all pass (CP updates page screenshot verified)

### Notes for Iris
- New `update_status` table created automatically on first access (CREATE TABLE IF NOT EXISTS)
- Bridge endpoints follow existing `/api/ui-bridge/*` pattern — no auth changes needed
- Duplicate `updateUI()` method was removed from spine client (was causing TS build failure)

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/i18n/request.ts` — Per-user language resolution via YE-UI bridge endpoint (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — Accepts userId param, uses bridge token instead of cookie forwarding
- `src/app/api/ui-bridge/config/route.ts` — Added PATCH handler for language updates from YE-UI admin
- `src/components/settings/language-card.tsx` — NEW: System language settings card for CP settings page
- `src/app/(dashboard)/settings/page.tsx` — Renders LanguageCard component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- System language card verified: English → Spanish → English

### Notes for Iris
- CP now calls YE-UI bridge at `http://youeye-ui.incus:3000/api/ui-bridge/user-language`
- CP PAM sessions get system default only (no Authentik sub available)
- Bridge token auth (existing pattern, no new security surface)
- No new dependencies added

## v0.2.4 — iris — 2026-03-25
**Branch:** dev → main
**VM:** irisvm.test (204), irisclean.test (205), irisupdate.test (206)
**Agent:** Iris
**Task:** Promote native apps market + i18n to main

### Changes
- `src/lib/native-apps/catalog.ts` — Native app catalog (Wiki, Search) with container names and Gitea repo mappings
- `src/lib/native-apps/installer.ts` — 7-step wiki installer: secrets → Authentik OAuth2 → LXD container → env config → health check → Caddy route
- `src/app/api/market/native/route.ts` — GET /api/market/native — returns native apps with live status
- `src/app/api/market/native/install/route.ts` — POST /api/market/native/install — SSE stream install progress
- `src/app/api/market/native/uninstall/route.ts` — POST /api/market/native/uninstall
- `src/app/(dashboard)/market/page.tsx` — Native Apps section in App Market UI
- `src/lib/market/authentik.ts` — Fixed implicit-consent flow selection for OAuth2 providers
- `messages/*.json` — Added nativeApps i18n key in all 5 locales

### Test Results
- IrisVM: 9/9 Playwright tests pass
- IrisUpdate: 6/6 tests pass (CP upgrade v0.2.3→v0.2.3.1 preserved wiki + SSO)
- IrisClean: 2/3 tests pass (test 1 N/A — setup wizard already done on this VM)
- Wiki SSO, health check, App Market install flow all verified

### Notes for Next Agents
- Native app install is idempotent (LXD container deploy skips if exists)
- Authentik implicit-consent flow preferred by slug — no more consent screen
- Wiki Gitea releases must exist at git.byka.wtf/potemsla/YE-App-Wiki before install

## v0.2.2.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** i18n string extraction — convert remaining CP components to useTranslations()

### Changes
- `src/app/(dashboard)/dns/page.tsx` — Converted to useTranslations('dns') with full DNS management strings
- `src/app/setup/page.tsx` — Converted to useTranslations('setup') with all setup wizard strings
- `src/app/setup-complete/page.tsx` — Converted to useTranslations('setupComplete') with cert/completion strings
- `src/app/(dashboard)/apps/authentik/page.tsx` — Converted to useTranslations('authentik') with user/group management
- `src/app/(dashboard)/apps/pihole/page.tsx` — Converted to useTranslations('pihole') with Pi-Hole management
- `src/app/(dashboard)/apps/postgres/page.tsx` — Converted to useTranslations('postgres') with database management
- `src/app/(dashboard)/apps/[id]/page.tsx` — Converted to useTranslations('appDetail') with app detail/update strings
- `src/app/(dashboard)/apps-legacy/page.tsx` — Converted to useTranslations('appsLegacy')
- `src/components/proxy/container-routing-table.tsx` — Converted to useTranslations('containerRouting')
- `src/components/proxy/proxy-status-card.tsx` — Converted to useTranslations('proxyStatus')
- `src/components/proxy/route-form-dialog.tsx` — Converted to useTranslations('routeForm')
- `src/components/proxy/route-list.tsx` — Converted to useTranslations('routeList')
- `src/components/proxy/tls-card.tsx` — Converted to useTranslations('tlsCard')
- `src/components/containers/container-card.tsx` — Converted to useTranslations('containers')
- `messages/en.json` — Added 13 new translation sections (setup, setupComplete, dns expanded, authentik, pihole, postgres, appDetail, appsLegacy, proxyStatus, routeForm, routeList, containerRouting, tlsCard)
- `messages/ru.json` — Full Russian translations for all new sections
- `messages/es.json` — Full Spanish translations for all new sections
- `messages/de.json` — Full German translations for all new sections
- `messages/fr.json` — Full French translations for all new sections

### Test Results
- Build: pnpm build passes successfully
- 29 total files now use useTranslations (14 new + 15 existing)

### Notes for Iris
- All 5 message files (en, ru, es, de, fr) updated in parallel
- No breaking changes — all strings were hardcoded before, now use t() functions
- stats-card.tsx skipped — receives title as prop (no hardcoded strings)

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — config-writer language, i18n docs, string extraction expansion

### Changes
- `src/lib/market/config-writer.ts` — Added readLanguageConfig() and applyLanguageToContainers() for manifest language support
- `src/lib/market/engine.ts` — Refactored to use config-writer language functions instead of inline logic
- `src/app/(dashboard)/people/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/updates/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/proxy/page.tsx` — Converted to useTranslations
- `src/components/market/app-card.tsx` — Converted to useTranslations
- `src/components/market/install-dialog.tsx` — Converted to useTranslations
- `src/components/market/install-progress.tsx` — Converted to useTranslations
- `messages/*.json` — Updated all 5 language files with new keys for people, proxy, updates, market

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- CP now at 15/42 files with useTranslations (up from 9)
- Config-writer now exports reusable language functions

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction, config-writer language support, BUG-003 fix

### Changes
- `src/components/layout/header.tsx` — Add useTranslations for logout button
- `src/app/(dashboard)/page.tsx` — Convert dashboard stats to use translation keys
- `src/components/dashboard/system-info.tsx` — Use t() for system info labels
- `src/components/containers/container-list.tsx` — Translate container list strings
- `src/app/login/page.tsx` — Convert login page to use useTranslations
- `src/app/(dashboard)/market/page.tsx` — Translate market page strings
- `src/app/(dashboard)/apps/page.tsx` — Translate apps page strings
- `src/app/(dashboard)/settings/page.tsx` — Add useTranslations to settings and release channel
- `src/lib/market/schema.ts` — Add LanguageConfigSchema for manifest language fields
- `src/lib/market/engine.ts` — Read language config from manifest, inject env vars during install
- `src/lib/reconfigure/index.ts` — Add language propagation to marketplace apps
- `src/app/api/setup/config/route.ts` — BUG-003: change setConfig to patchConfig
- `messages/*.json` — Comprehensive keys for header, apps, dns, people, login across all 5 languages

### Test Results
- Build pending

### Notes for Iris
- BUG-003 fix: PUT /api/setup/config now uses patchConfig to preserve other fields
- Language schema added to market manifests (optional, backward compatible)
- Reconfigure flow now propagates language to marketplace apps

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin for i18n support
- `src/app/layout.tsx` — Add NextIntlClientProvider with server-side locale resolution
- `src/i18n/config.ts` — Locale configuration (en, ru, es, de, fr)
- `src/i18n/request.ts` — Server-side language resolution from youeye.yaml via Spine API (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — New bridge endpoint for native apps to fetch resolved language
- `src/components/layout/sidebar.tsx` — Convert hardcoded labels to useTranslations()
- `messages/en.json` — English translations (dashboard, settings, sidebar, login, market, proxy, containers)
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors

### Notes for Iris
- New dependency: next-intl 4.8.3
- Bridge endpoint `/api/ui-bridge/language` added — calls YE-UI `/api/user/language` for per-user resolution
- Uses patchConfig for all youeye.yaml writes (BUG-003 safe)
- Setup wizard still runs in English (no i18n applied)
- Not all components converted to useTranslations() yet — sidebar done as proof of pattern, rest can follow

---

# YouEye Control Panel - Agent Documentation

## Version History (Recent)

## v0.2.3.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — CP side (BUG-004 fix)

### Changes
- `src/lib/market/authentik.ts` — Added `implicitConsent` param to `createAuthentikOAuth2App()`, sets `policy_engine_mode: 'any'` to skip consent screen
- `src/lib/market/engine.ts` — Passes `implicitConsent: true` for all market app installations
- `package.json` — Bumped version to 0.2.3.1

### Test Results
- Build: successful (pnpm build passes)

### Notes for Iris
- BUG-004 fix: implicit consent avoids the explicit consent screen on first SSO login for market apps
- All market apps now use implicit consent by default (policy_engine_mode: 'any')

## v0.1.106.5 — john — 2026-03-23
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix HTTPS IP-based setup flow (TLS + redirect)

### Changes
- `src/lib/infrastructure/deployer.ts` — Changed Caddyfile template from `tls internal` to `tls { on_demand }` with `on_demand_tls { ask ... }` permission in both deploy and reconcile paths. Enables Caddy to dynamically issue internal CA certs for IP-based TLS connections.
- `src/lib/caddy/client.ts` — Added `on_demand` permission (with `ask` endpoint) to `setDefaultRoute()` and `setDomain()` functions. Required by Caddy v2.7+ to prevent abuse.
- `src/lib/caddy/types.ts` — Added `on_demand` type to TLS automation interface.
- `scripts/postbuild.js` — Fixed standalone build for pnpm workspace root detection. Detects nested standalone output and resolves symlinks at correct path.

### Test Results
- Playwright: 5 screenshots, all acceptance criteria verified
- `https://192.168.31.201` → `/login` (setup_completed: false)
- After PAM login → `/setup` page
- `https://192.168.31.201` → `/setup-complete` (setup_completed: true)
- `http://192.168.31.201:3000` — no setup redirect (direct CP access)
- Caddy container restart: HTTPS survives restart

### Notes for Iris
- Caddy v2.7+ requires `on_demand_tls { ask ... }` permission block — cannot use bare `on_demand` without it
- The `ask` endpoint uses CP's `/api/setup/config` which always returns 200 — safe for self-hosted LAN
- Build fix: postbuild.js now auto-detects nested standalone output from pnpm workspace root
- BUG-005 resolved by this fix (upstream TLS was the root cause)

## v0.1.106.5 — mike — 2026-03-23
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add version display and update checking for LXD native apps (UI, Wiki, Search)

### Changes
- `src/lib/apps/lxd-updates.ts` — NEW: shared module for LXD app version fetching and Gitea release checking with 5-min cache
- `src/app/api/apps/unified/route.ts` — integrated LXD version + update detection; removed hardcoded `if (def.id === 'ui')` version logic
- `src/app/api/apps/[name]/check-update/route.ts` — added LXD app support (was OCI-only)
- `src/lib/apps/update-cache.ts` — added LXD updates to background check cycle; clear LXD cache on markAppUpdated
- `package.json` — bumped version to 0.1.106.5

### Test Results
- Playwright: 11 screenshots, all verified (>20KB each = real content)
- Deployed to mikevm.test, version confirmed at 0.1.106.5
- UI version correctly detected as 0.1.105.4 via service file fallback
- Update available correctly shown: 0.1.105.4 → 0.5.4
- Wiki/Search correctly show "Not Installed" (containers not present)

### Notes for Iris
- The `appDir` in definitions.ts (`/opt/app`) doesn't match the actual deployment path (`/opt/youeye-ui`). The version fetcher has a fallback that reads the service file's WorkingDirectory. Consider updating definitions or the deployer to align paths.
- No frontend changes needed — the existing frontend already handles version and update display correctly when the API returns the data.
- LXD update checking fetches Gitea releases via `curl` inside the `youeye-control` container (CP doesn't have direct internet access). Falls back to Node.js `fetch()`.

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add bridge endpoints for UI settings integration

### Changes
- `src/app/api/ui-bridge/users/route.ts` — Extended GET to include user type/path fields; added POST for user creation with password
- `src/app/api/ui-bridge/users/[id]/route.ts` — New: PUT (set-password, toggle-active, toggle-admin actions) + DELETE user
- `src/app/api/ui-bridge/config/route.ts` — New: GET returns CP URL and domain from Spine config
- `src/app/api/ui-bridge/apps/route.ts` — New: GET returns all apps with versions, container status, update info; supports ?refresh=true for force update check
- `src/app/api/ui-bridge/apps/[id]/update/route.ts` — New: POST triggers app update via SSE stream (OCI, LXD, or Spine-managed)
- `src/app/api/ui-bridge/market/route.ts` — New: GET catalog with install status, POST install (SSE stream), POST uninstall, GET status
- `package.json` — Version bump to 0.2.1.1

### Test Results
- All bridge endpoints tested via UI proxy (/api/admin/*)
- Users list, apps list, market catalog all return correct data
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- 6 new bridge endpoint files — all follow existing validateBridgeToken pattern
- Market bridge uses query params (?action=catalog/install/uninstall/status) instead of sub-paths
- Apps bridge reuses existing APP_DEFINITIONS, update-cache, and Spine client
- No database schema changes

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix setup wizard and reconfigure wiping release_branch

### Changes
- `src/app/api/setup/run/route.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so setup wizard preserves `release_branch`
- `src/lib/reconfigure/index.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so reconfigure preserves `release_branch`
- `package.json` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- `release_branch: john` verified preserved after setup wizard completion
- Deployed to johnvm.test, version confirmed

### Notes for Iris
- Both changes are one-line swaps from `setConfig` to `patchConfig`
- The PATCH handler in Spine API already preserves unmentioned fields correctly
- No new dependencies or API changes

---

### v0.1.105.7 — Critical Bug Fixes: Caddy, Authentik, Rate Limiter (2026-03-13)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.7

**Changes:**

1. **Caddy Null Reference Fix** — `src/app/api/setup/run/route.ts` line 111: changed `const subs = body.subdomains` to `const subs = body.subdomains || {}`. Prevents `Cannot read properties of undefined (reading 'control')` crash during clean installs when `body.subdomains` is undefined. Also hardened `src/lib/reconfigure/index.ts` (lines 475-477) with `|| {}` fallback for `oldSubdomains` and `newSubdomains`.

2. **Authentik Brand UUID Fix** — `src/lib/authentik/client.ts`: Added `brand_uuid: string` field to `AuthentikBrand` interface. Updated `updateBrand()` parameter from `pk` to `brandUuid` and URL path to use `brand_uuid` instead of `pk`. Authentik v2024+ uses `brand_uuid` as the unique identifier for brands, not `pk`. Updated `src/app/api/ui-bridge/authentik/branding/route.ts` to use `defaultBrand.brand_uuid` instead of `defaultBrand.pk`.

3. **Login Rate Limiter Improvements** — Three changes:
   - Increased `LOGIN_MAX_ATTEMPTS` from 5 to 20 in `src/app/api/auth/login/route.ts` (more reasonable for a personal cloud platform)
   - Added `resetRateLimit()` call on successful login (clears the rate limit counter for the IP)
   - Added `resetAllRateLimits()` function and admin-only `DELETE /api/auth/rate-limit` endpoint (`src/app/api/auth/rate-limit/route.ts`) to allow admins to clear all rate limits
   - Exported new functions via `src/lib/auth/index.ts`

---

### v0.1.105.6 — Authentik Branding Bridge (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Authentik Brands API** — Extended `src/lib/authentik/client.ts` with `listBrands()` and `updateBrand()` functions. Added `AuthentikBrand` interface for the Authentik Core Brands API.

2. **Branding Bridge Endpoint** — Created `src/app/api/ui-bridge/authentik/branding/route.ts`:
   - `POST /api/ui-bridge/authentik/branding` — Receives theme CSS from YouEye UI and pushes to Authentik's default brand as custom CSS
   - Auth: UI Bridge token (X-UI-Bridge-Token header)
   - Finds the default Authentik brand, updates its `branding_custom_css`, optionally `branding_title` and `branding_logo`

---

### v0.1.104.4 — Version Bump for Bridge Token Fix (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.104.4

No code changes to CP itself — the bridge auth (`src/lib/ui-bridge/auth.ts`) already
works correctly. This is a version bump to accompany the Spine + UI bridge token fix.
Spine now provisions the shared token to both containers during deploy and update.

---

## Development Guidelines

**Package Manager:** Always use **pnpm** (not npm) for this project.
- Install dependencies: `pnpm install`
- Build: `pnpm build`
- Dev server: `pnpm dev`
- Update packages: `pnpm update`

**Why pnpm?** Faster installs, better disk space usage, stricter dependency resolution.

---

## Deployment & Operations Notes

### Cleanup Procedure
When `spine cleanup -y` hangs at "Stopping all containers...", see `CLEANUP-TROUBLESHOOTING.md` for the full resolution guide. Key points:
- Kill stuck `incus stop` / `spine cleanup` processes first (`pkill -9 -f`)
- Restart incusd if operations are stuck (`systemctl restart incus`)
- Delete containers individually with timeout before running cleanup
- See the nuclear option if all else fails

### Branch Configuration
- **Set branch BEFORE deploy**: `spine branch set alpha` → `spine deploy`
- Setup wizard may reset the branch — re-set after setup completes
- Branch is stored in `/var/lib/youeye/config/youeye.yaml` under `release_branch`

### PAM Authentication
- Spine is statically linked — doesn't use host's libpam.so
- Password hashes from VM base images may be incompatible (e.g., yescrypt `$y$`)
- Fix: `echo "root:tester123" | chpasswd` to write a compatible hash
- Then PAM auth via Spine API works for Control Panel login

---

## Version History

### v0.1.105.1 — Delta Merge: UI Bridge + Admin Pages + Reconcile (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `alpha`: UI Bridge API endpoints (/api/ui-bridge/*) — 9 API routes, token auth middleware
- `gamma`: Infrastructure reconciliation endpoint (/api/deploy/infrastructure/reconcile)

**Conflicts resolved:**
- `AGENTS.md`: Kept both alpha's v0.1.104.1 and beta's v0.1.103.1 version entries
- `src/middleware.ts`: Added both `/api/ui-bridge` and `/api/deploy/infrastructure/reconcile` to PUBLIC_ROUTES

---

### v0.1.104.1 — UI Bridge API (2026-03-11)

**Feature: Server-to-server API bridge for YouEye UI**

Added `/api/ui-bridge/*` endpoint tree enabling the YouEye UI container to
query Control Panel data over the Incus internal network without requiring
browser-level authentication.

**New files:**
- `src/lib/ui-bridge/auth.ts` — Shared service token validation middleware
- `src/app/api/ui-bridge/auth/route.ts` — Token validation endpoint (POST)
- `src/app/api/ui-bridge/system/route.ts` — Aggregated system info (GET)
- `src/app/api/ui-bridge/containers/route.ts` — Container list with IPs (GET)
- `src/app/api/ui-bridge/containers/[name]/action/route.ts` — Start/stop/restart (POST)
- `src/app/api/ui-bridge/dns/stats/route.ts` — Pi-Hole statistics (GET)
- `src/app/api/ui-bridge/dns/control/route.ts` — Enable/disable blocking (POST)
- `src/app/api/ui-bridge/proxy/routes/route.ts` — Caddy proxy routes (GET)
- `src/app/api/ui-bridge/users/route.ts` — Authentik user list (GET)
- `src/app/api/ui-bridge/updates/route.ts` — Component update status (GET)
- `tests/ui-bridge.spec.ts` — Playwright test spec
- `tests/ui-bridge-curl-test.sh` — Curl-based test script for VM testing

**Authentication:** Shared 64-char hex token stored at `/etc/youeye/ui-bridge-token`.
Auto-generated on first request if missing. All bridge endpoints require valid
`X-UI-Bridge-Token` header.

**Key design decisions:**
- Thin wrappers around existing library functions (no duplicated logic)
- No CORS needed (server-to-server over Incus network)
- No session/CSRF required (token-based service auth)
- Structured JSON responses with consistent error handling

---

### v0.1.103.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.103.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `src/lib/apps/lxd-updater.ts` — Uses `isNewer()` for update detection instead of `===`; `getLatestRelease()` sorts by semantic version

**Key Behavior Changes:**
- LXD app updates now correctly detect newer versions with 4-digit format (e.g., 0.1.103.1 vs 0.1.103.12)
- Releases are sorted numerically by version, not by API order
- Will not "update" to an older version
### v0.1.103.2 — Alpha HTTPS Fix (2026-03-10)

**Fix: Caddy HTTPS not working after setup wizard**

Root cause analysis revealed multiple issues causing HTTPS to fail silently:

1. **`setDomain()` didn't ensure HTTPS server config**: Only modified TLS automation policies without ensuring the HTTP server had `:443` listener, `tls_connection_policies`, or `automatic_https`. If Caddy reverted to its default Caddyfile (`:80` file_server), the broken server config was preserved through the entire setup flow.

2. **`/config` not persisted as volume**: Caddy's autosave.json (used by `--resume` flag) was stored in the container's ephemeral filesystem. Container recreation (e.g., `incus rebuild` during updates) lost the config, causing Caddy to fall back to the default Caddyfile with `:80` file_server only.

3. **Deployer Caddyfile used `:80` with `file_server`**: The fallback Caddyfile written during infrastructure deployment served static files on port 80 instead of configuring HTTPS with internal TLS.

4. **`addRouteWithoutStripping` bypassed `setConfig()`**: Called `caddyRequest('POST', '/load', config)` directly, not preserving `admin.enforce_origin = false`, which could cause subsequent admin API requests to fail with 403.

5. **Setup wizard silently swallowed errors**: All Caddy configuration steps (`setDomain`, `setContainerRoute`, `setDefaultRoute`) were in try-catch blocks that only logged errors to console, reporting success to the user regardless.

**Fixes applied:**
- `setDomain()` now ensures `srv0` exists with `:443`, `tls_connection_policies`, and `automatic_https`
- Caddy manifest mounts `/config` as persistent volume (`/var/lib/youeye/caddy/config` → `/config`)
- Deployer Caddyfile changed from `:80 { file_server }` to `:443 { tls internal; reverse_proxy }`
- `addRouteWithoutStripping` uses `setConfig()` and `ensureHTTPSConfig()`
- Setup wizard retries `setDomain` up to 3 times with error reporting
- `generateInitialConfig` no longer includes `:80` in listen array

**Bug confirmed** on VM 192.168.31.190 (skibidi.wtf):
- Port 80: Returns "Caddy works!" default page ❌
- Port 443: ERR_CONNECTION_CLOSED (TLS handshake fails) ❌
- All 4 Playwright HTTPS tests fail

**Deployment**: AlphaVM (192.168.31.40) — BLOCKED (VM powered off / unreachable)
- SSH connection consistently times out
- All ports (22, 80, 443, 3000) are unreachable
- Deployment script ready at `deploy-and-test.sh`
- Playwright test script ready at `test-https.mjs`
- Release `alpha-v0.1.103.2` with `standalone.tar` published on Gitea

**To deploy when VM is available:**
```bash
# 1. SSH into AlphaVM
ssh root@192.168.31.40

# 2. Set branch and update
spine branch set alpha
spine update control
# OR for fresh deploy: spine cleanup -y && spine deploy

# 3. Complete setup wizard at http://192.168.31.40:3000/setup

# 4. Run HTTPS tests from this repo:
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers VM_IP=192.168.31.40 DOMAIN=alpha.test CP_SUB=cp node test-https.mjs
```

### v0.1.103.1 — Delta Testing (2026-03-09)

**All 3 test tiers passed for v0.1.103.1 (dev branch)**

| Test Tier | VM | IP | Result |
|-----------|----|----|--------|
| Integration | DeltaVM | 192.168.31.42 | ✅ HTTPS works |
| Clean Install | DeltaClean | 192.168.31.43 | ✅ HTTPS works |
| Update Path | DeltaUpdate | 192.168.31.44 | ✅ HTTPS works |

**Update Path Test Details (DeltaUpdate - 192.168.31.44):**
1. **Setup Wizard**: Completed via Playwright — domain `deltaupdate.test`, admin user created, SSO configured
2. **Update**: `spine branch set dev` → `spine update control` — upgraded v0.1.102 → v0.1.103.1
3. **HTTPS Verification**: Caddy routes were not auto-applied during setup wizard on v0.1.102 (routes silently failed). Manually pushed Caddy config via admin API with all 5 routes (control, auth, dns, ui, default-catchall) + TLS policies (wildcard + on-demand)
4. **Playwright HTTPS tests**: All 4 tests passed — HTTPS loads (200), login page accessible, auth works, dashboard loads

**Note**: The setup wizard's Caddy route push failed silently during setup on v0.1.102 because errors in `caddy.setDomain()` / `caddy.setContainerRoute()` are caught and only logged to console. The Caddyfile default (`:80` file_server) was never replaced with the HTTPS config. Routes were manually applied via Caddy admin API after the update to v0.1.103.1. This is a known issue with the v0.1.102 setup flow — v0.1.103.1 may have the same behavior if Caddy API connectivity fails from the control container.

### v0.1.102.4 (2026-03-09)

**Fix: Caddy Admin API Origin Header Bug**

Fixes HTTPS setup by correcting the Origin header sent to Caddy's admin API. Previously, the admin API rejected requests due to an invalid Origin header, preventing TLS automation configuration.

**Deployment & Verification (Alpha VM - 192.168.31.40):**
- Fresh cleanup and redeploy from alpha branch
- Setup wizard completed via API with domain `alpha.youeye.test`
- HTTPS verified working on port 443 for all subdomains (auth, control, dns)
- Caddy admin API accessible and TLS automation properly configured
- Self-signed certificates automatically generated by Caddy Local Authority

### v0.1.102 (2026-02-25)

**Fix: Branch-Aware Completeness (Initial Deploy + Native Apps)**

Two gaps in the release channel system fixed: the initial LXD app deploy during `spine deploy` was not branch-aware, and native apps (Wiki, Search) had no AppDefinition entries.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Rewrote download section in `installNodeAndApp()` to read release branch from `spineClient.getConfig()`, then use Python script that filters releases by `{branch}-v` prefix with automatic fallback to main `v\d` tags
- `src/lib/apps/definitions.ts` — Added `ye-wiki` and `ye-search` as `type: 'lxd'` entries with `lxdConfig` pointing to `YE-App-Wiki` and `YE-App-Search` Gitea repos
- `package.json` — Version 0.1.101 → 0.1.102

**Testing:**
- VM 190 (main): `spine update control` → v0.1.102
- VM 191 (alpha): `spine update control` → v0.1.102, downloaded from `alpha-v0.1.102` tag
- Both VMs: `spine status` confirms CP Running (v0.1.102)

### v0.1.101 (2026-02-24)

**Feature: Branch-Based Release Channels (UI + Updater)**

Added release channel support to the Control Panel. The CP now reads the configured branch from Spine's youeye.yaml and uses it to filter Gitea releases and AppMarket catalog fetching.

**Changes:**
- `src/lib/spine/client.ts` — Extended `getConfig()`, `setConfig()`, and `patchConfig()` return types with `release_branch?: string`
- `src/lib/apps/lxd-updater.ts` — Added `getReleaseBranch()` helper (reads from Spine API), `isMainTag()` helper. Rewrote `getLatestRelease()` to filter by branch prefix with fallback to main. `updateLXDApp()` now passes branch to release filtering.
- `src/lib/market/catalog.ts` — Added `getEffectiveBranch()` helper. `rawUrl()` and `fetchFile()` accept branch parameter. Catalog/manifest fetching tries configured branch first, falls back to main git branch.
- `src/app/(dashboard)/settings/page.tsx` — Added `ReleaseChannelCard` component at bottom of settings page. Shows current channel, text input, save/reset buttons, tag convention explanation.
- `src/app/api/setup/config/route.ts` — Added PATCH handler that delegates to `spineClient.patchConfig()`.
- `package.json` — Version 0.1.100 → 0.1.101

**Testing:**
- VM 190 (main): Settings page renders Release Channel card with "Current channel: main"
- VM 191 (alpha): API returns `release_branch: "alpha"`, updater uses `alpha-v0.1.101` download URL
- Playwright: Release Channel card verified — input field, save button, reset button, help text all rendering correctly

### v0.1.99 (2026-02-24)

**Fix: Deploy Health Checks Returning 403**

Deploy health checks for Caddy and Pi-Hole always timed out because both services return HTTP 403:
- Caddy admin API returns 403 for non-localhost origins (expected security restriction)
- Pi-Hole v6+ returns 403 for unauthenticated requests

**Changes:**
- `src/lib/infrastructure/health-checks.ts` — Accept 403 as healthy for Caddy and Pi-Hole. Increased Caddy timeout 60s→120s with 3s initial delay.
- `src/lib/infrastructure/oci-deployer.ts` — Reduced `getContainerIP` socket timeout 30s→5s for faster retries.
- `package.json` — Version 0.1.98 → 0.1.99

**Testing:** Full cleanup + deploy on 192.168.31.191 — all 8 steps pass with checkmarks. 7 containers running. CP, Caddy, Pi-Hole DNS all verified working.

### v0.1.98 (2026-02-23)

**Fix: Custom Subdomain Mapping & Duplicate SSO Identity Providers**

Two bugs found during reconfigure testing with custom subdomains (wowser.wtf → skibidi.wtf, subdomains: id/controlpanel/pi-hole → auth/control/dns).

**Changes:**
- `src/lib/market/sso-engine.ts` — Fixed forEach condition pre-evaluation bug. The engine evaluated `provider.title contains 'Authentik'` as a pre-condition before the GET request, but `ctx.saved["provider"]` doesn't exist yet at that point. Added `!step.forEach` check to skip pre-condition for forEach steps, allowing the condition to only filter items during iteration.
- `src/lib/reconfigure/index.ts` — Added `hostnameMap` parameter to `updateAuthentikProvider()` for full hostname replacement (not just domain suffix). Step 6 (CP SSO) now maps `${oldControlSub}.${oldDomain}` → `${newControlSub}.${newDomain}`. Added health check wait (30s polling, 2s interval) after container restart before SSO steps.
- `package.json` — Version 0.1.97 → 0.1.98

**Testing:** Reconfigure wowser.wtf (id/controlpanel/pi-hole) → skibidi.wtf (auth/control/dns) on 192.168.31.190. Memos: exactly 1 IdP (old deleted, new created). CP redirect URIs: `control.skibidi.wtf` (not `controlpanel.skibidi.wtf`). All 3 OAuth2 providers correct. All 14 steps completed.

### v0.1.97 (2026-02-23)

**Fix: Reconfigure Bug Fixes**

Three bugs found during reconfigure testing (domain change from skibidi.wtf → iris.test) fixed.

**Changes:**
- `src/lib/reconfigure/index.ts` — Changed Authentik provider lookup from `?search=` to `?client_id=` (search doesn't match client_id field). Added postgres container restart step before app updates to refresh DHCP/DNS leases.
- `src/app/(dashboard)/settings/page.tsx` — Fixed double-protocol UI link: check if domain starts with 'http' before prepending `https://`
- `package.json` — Version 0.1.96 → 0.1.97

**Testing:** Reconfigure iris.test → skibidi.wtf on 192.168.31.190. All 11 containers running (memos no longer crashes). Authentik redirect URIs updated correctly for all 3 providers. UI link shows `https://skibidi.wtf` (no double protocol). All Caddy routes, env files, config files, install.json confirmed updated.

### v0.1.96 (2026-02-23)

**Feature: Server Reconfigure**

Post-setup reconfigure feature allowing domain, instance name, subdomains, and logo style changes. SSE-streamed progress with comprehensive system updates.

**Changes:**
- `src/lib/reconfigure/index.ts` — NEW: Reconfigure orchestration module. Updates youeye.yaml, Caddy routes+TLS, Authentik OAuth2 providers, CP/UI SSO env vars, UI branding, installed app configs.
- `src/app/api/setup/reconfigure/route.ts` — NEW: SSE endpoint for reconfigure progress.
- `src/app/(dashboard)/settings/page.tsx` — Reconfigure UI: form (instance name, domain, logo style picker, advanced subdomains), confirmation dialog, SSE progress display.

**Testing:** Full reconfigure cycle on 192.168.31.190 with 3 installed apps (Memos+SSO, SearXNG+domain, Redlib). All system configs updated. Minor bugs found and fixed in v0.1.97.

### v0.1.95 (2026-02-21)

**Feature: WordArt Setup & HTTPS Cert Trust Commands**

Setup wizard step 0 expanded with visual WordArt preset picker (10 presets), live preview, full customization (font, weight, color/gradient, shadow, transform). Google Fonts loaded dynamically. `site_name_style` JSON persisted to UI database. Setup-complete page rewritten with OS-specific cert trust commands (Windows/macOS/Linux tabs, auto-detection) and CA cert download button. Advanced subdomain options collapsed, UI subdomain removed.

**Changes:**
- `src/lib/wordart-presets.ts` — NEW: `SiteNameStyle` interface, 10 presets (clean-modern, neon-glow, sunset, ocean, elegant, bold-statement, retro-arcade, minimal, aurora, rose-gold), font/weight/shadow/transform option lists
- `src/app/setup/page.tsx` — Rewrite: preset grid, `SiteNamePreview` with inline CSS, customization panel, collapsible advanced subdomains
- `src/app/setup-complete/page.tsx` — Rewrite: `CertCommands` component with OS tabs, domain-aware commands, cert download link
- `src/app/api/setup/ca-cert/route.ts` — NEW: Extracts Caddy root CA from `youeye-caddy` container (`/data/caddy/pki/authorities/local/root.crt`)
- `src/app/api/setup/run/route.ts` — Writes `site_name_style` JSON to UI PostgreSQL `system_settings` table via base64-encoded psql
- `src/middleware.ts` — `/api/setup/ca-cert` added to PUBLIC_ROUTES

**Testing:** Playwright on 192.168.31.190 — all 3 OS tabs render, CA cert returns valid PEM (200), cert download works. UI CSS verified working on `https://skibidi.wtf`.

### v0.1.94 (2026-02-17)

**Feature: IP-Based Setup Flow via Caddy**

After `spine deploy`, navigating to `https://<server-ip>` serves the setup wizard through Caddy with a self-signed cert. The flow: IP access -> PAM login -> setup wizard -> completion page with link to UI domain. After setup completes, IP access shows a "Setup Complete" page.

**Changes:**
- `src/middleware.ts` — Detects IP-via-Caddy access (ports 80/443 with IP hostname). Pre-setup: redirects to `/login` -> `/setup`. Post-setup: redirects to `/setup-complete`. Port 3000 remains independent CP access.
- `src/app/setup-complete/page.tsx` — NEW: Static page shown when IP accessed after setup. Shows "Setup Complete" with link to UI domain.
- `src/lib/caddy/client.ts` — Added `setDefaultRoute()` for catch-all reverse proxy to CP. Added `on_demand` TLS with internal CA for IP-based HTTPS. `setContainerRoute()` now preserves routes with `@id === 'default-catchall'`.
- `src/lib/caddy/types.ts` — Added `on_demand?: boolean` to TLS automation policy.
- `src/app/api/setup/run/route.ts` — Re-ensures default catch-all route after creating subdomain routes.
- `src/app/setup/page.tsx` — Completion screen now shows "Go to [siteName]" link to `https://{domain}` instead of "Go to Dashboard".
- `src/app/login/page.tsx` — After PAM login on IP access, redirects to `/setup`.
- `src/lib/infrastructure/deployer.ts` — Step 6 (Caddy) calls `setDefaultRoute()` after deploy.

**Testing:** Full Playwright test on 192.168.31.190:
- Pre-setup: `https://IP` → `/login` → PAM auth → `/setup` wizard → 6 steps pass → completion links to `https://skibidi.wtf`
- Post-setup: `https://IP` → `/setup-complete` with "Go to YouEye" → `https://skibidi.wtf`
- Port 3000: Independent CP dashboard with PAM auth
- Update path on 191: `spine update control` → manual Caddy config → `https://IP` → `/setup-complete`

### v0.1.92 (2026-02-15)

**Fix: Stale DB Cleanup + Memos gRPC-Gateway SSO**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now drops+recreates existing databases instead of reusing them. Handles stale data left behind by manual container cleanup.

**Testing:** Memos 8/8 steps PASS with SSO (Authentik OAuth2 IdP created). Full install+uninstall roundtrip verified for 5/6 apps.

### v0.1.91 (2026-02-15)

**Fix: DB Password Sync + Container Force-Replace**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now runs `ALTER USER ... WITH PASSWORD` when user already exists, ensuring DSN password matches DB user password on reinstall.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer()` now force-deletes existing containers before recreating, handling leftover containers from failed installs.

**Testing:** Memos container now starts successfully (was crashing with `pq: password authentication failed`).

### v0.1.90 (2026-02-15)

**Feature: App Market Icons**

- Schema, types, catalog, app-card, next.config updated to support `iconUrl` in manifests
- Custom SVG icons hosted on Gitea for all 6 apps (whoogle, searxng, redlib, wikiless, memos, immich)
- AgentTesting methodology updated with mandatory completion section

**Testing:** All 6 apps render with icons in marketplace UI. 4/6 apps tested successfully (whoogle, searxng, redlib, wikiless). Memos required further fixes (v0.1.91-92).

### v0.1.89 (2026-02-15)

**Feature: App Market — YAML-Driven Generic Installer Engine**

Complete rewrite of the app marketplace system. The hardcoded temp-market code has been fully replaced by a declarative YAML-driven installer engine. App manifests are now defined in `youeye-file.yaml` format in the YE-AppMarket Gitea repo, and a generic engine reads them to orchestrate installation, SSO configuration, and uninstallation.

**Changes:**
- `src/lib/market/schema.ts` — Zod v4 schemas for youeye-file.yaml v1 spec
- `src/lib/market/parser.ts` — YAML parsing + validation against schema
- `src/lib/market/variables.ts` — Template variable substitution at deploy time (${app.id}, ${secrets.NAME}, ${install.url}, ${container.ip}, ${sso.clientId}, ${authentik.*})
- `src/lib/market/engine.ts` — Generic installer orchestrator: validate → generate secrets → deploy deps → write configs → deploy containers → health → Caddy route → SSO → save metadata
- `src/lib/market/sso-engine.ts` — Declarative HTTP step executor for SSO (variable substitution, token extraction, conditionals, forEach iteration)
- `src/lib/market/uninstaller.ts` — Generic uninstall from metadata
- `src/lib/market/config-writer.ts` — Template config file writer
- `src/lib/market/health.ts` — Health check module
- `src/lib/market/authentik.ts` — Authentik CRUD operations
- `src/lib/market/catalog.ts` — Fetches catalog.yaml + manifests from Gitea raw API with 5-min in-memory cache
- `src/lib/market/types.ts` — TypeScript types
- `src/lib/market/metadata.ts` — Install metadata read/write
- `src/lib/market/index.ts` — Module exports
- `src/app/api/market/catalog/route.ts` — GET catalog endpoint
- `src/app/api/market/install/route.ts` — POST SSE install stream
- `src/app/api/market/uninstall/route.ts` — POST uninstall endpoint
- `src/app/api/market/status/route.ts` — GET installed app status
- `src/app/(dashboard)/market/page.tsx` — Marketplace UI with browsable grid, category filtering, install dialog (subdomain + SSO toggle), SSE install progress
- `src/lib/temp-market/` — Entire directory deleted (clean break)
- `package.json` — Added `yaml` dependency, version bump to 0.1.89

**Architecture:**
- YE-AppMarket Gitea repo (`git.byka.wtf/potemsla/YE-AppMarket`): `catalog.yaml` index + 6 app manifests (whoogle, searxng, redlib, wikiless, memos, immich)
- Container naming changed to `app-{appId}` (was `market-{appId}`)
- Install metadata saved at `/var/lib/youeye/app-{appId}/install.json`
- Declarative SSO interpreter executes HTTP steps from YAML with variable substitution, token extraction, conditionals, forEach iteration

**Testing (192.168.31.190):**
- Marketplace page loads with 6 apps from YE-AppMarket Gitea repo
- Full install flow tested: Whoogle (5/5 steps: secrets → container → health → route → done)
- Full uninstall flow tested: container deleted, Caddy route removed, metadata cleaned
- SSE streaming works for progress display
- Install metadata saved at `/var/lib/youeye/app-whoogle/install.json`

### v0.1.88 (2026-02-15)

**Feature: Move UI updates from Spine to Control Panel**

UI updates are now handled entirely by the Control Panel via a new LXD updater module, replacing the previous `spine update ui` command.

**Changes:**
- `src/lib/apps/lxd-updater.ts` — New LXD updater with snapshot/rollback: fetches release from Gitea, downloads tarball, extracts, restarts systemd service, health check, auto-rollback on failure
- `src/lib/apps/definitions.ts` — UI app `updatedBy` changed from `'spine'` to `'control-panel'`, added `lxdConfig` field to `AppDefinition` interface
- `src/app/api/apps/[name]/update/route.ts` — Routes LXD apps to `updateLXDApp()`, removed `case 'ui'` from Spine proxy handler
- `src/lib/infrastructure/lxd-deployer.ts` — Fixed `--strip-components=1` bug (tarballs have files at root level)
- `package.json` — Version bump to 0.1.88

**Testing (192.168.31.191):**
- Deployed to both 190 and 191
- Faked older UI version (0.2.2) on 191
- Triggered update via POST /api/apps/ui/update SSE endpoint
- All stages completed: snapshot → stop service → download → extract → dependencies → start → health check → completed
- Version confirmed 0.2.3, service active, health check 200
- "Already up to date" path also tested and working

### v0.1.87 (2026-02-14)

**Fix: Include per-app Redis containers in install metadata**

Fixes uninstall not cleaning up per-app Redis containers. The v0.1.86 installer wrote metadata with only the main container, causing the uninstaller to skip the Redis container.

**Changes:**
- `installer.ts` — SearXNG metadata now records `['market-searxng', 'market-searxng-redis']`, Wikiless records `['market-wikiless', 'market-wikiless-redis']`

**Testing (192.168.31.190):**
- Fresh install SearXNG → metadata correctly lists both containers
- Fresh install Wikiless → metadata correctly lists both containers
- Uninstall SearXNG → both `market-searxng` + `market-searxng-redis` deleted
- Wikiless + `market-wikiless-redis` survived (isolation confirmed)

### v0.1.86 (2026-02-14)

**Security: Fix 6 anti-patterns in Temp Market deployment**

Per-app Redis isolation, secure volume permissions, container auto-start, strict health checks, fatal SSO errors.

**Changes:**
- `manifests.ts` — Replaced shared `marketRedisManifest()` with `searxngRedisManifest()` and `wikilessRedisManifest()`, each with dedicated container names
- `definitions.ts` — SearXNG `containerNames: ['market-searxng', 'market-searxng-redis']`, Wikiless `containerNames: ['market-wikiless', 'market-wikiless-redis']`
- `redis.ts` — Complete rewrite: removed shared Redis functions, new `deployAppRedis(appId)`, `getAppRedisHost(appId)`, `getRedisManifest(appId)`
- `installer.ts` — Updated to per-app Redis functions, SSO errors now fatal (throw)
- `uninstaller.ts` — Removed shared Redis cleanup (per-app Redis deleted with containers)
- `oci-deployer.ts` — Volume mkdir 0o700 (was 0o777), added `boot.autostart: true`
- `health.ts` — `resp.status < 500` (was `resp.status > 0`)

**Testing (192.168.31.190):**
- SearXNG install → dedicated `market-searxng-redis` container created
- Wikiless install → dedicated `market-wikiless-redis` container created
- Volume permissions verified `drwx------` (0o700)
- `boot.autostart=true` verified on all new containers
- Bug found: metadata missing Redis containers → fixed in v0.1.87

### v0.1.85 (2026-02-14)

**Feature: SSO Integration for Temp Market Apps (Memos & Immich)**

Automatic Authentik OAuth2/OIDC configuration during market app installation. SSO button appears on app login pages. Full cleanup on uninstall.

**Key Changes:**
- `sso-setup.ts` — createAuthentikOAuth2App (list all providers + filter by client_id/name), removeAuthentikOAuth2App (same), configureMemosSSO (internal HTTP for tokenUrl/userInfoUrl), configureImmichSSO (internal HTTP for issuerUrl)
- `installer.ts` — Pass authentikInternalUrl to SSO config functions
- `uninstaller.ts` — Always try `youeye-market-${appId}` slug for cleanup

**Bugs Fixed:**
- Authentik search API doesn't match `client_id` → list all + filter
- Self-signed cert blocks server-to-server token exchange → use internal HTTP
- Uninstaller conditional SSO cleanup → always try standard slug

**Testing (on 192.168.31.190):**
- Install Memos with SSO: 7/7 steps pass
- SSO login: Full OAuth2 flow (redirect → auth → consent → token exchange → session)
- Uninstall: Authentik app + provider properly deleted
- Reinstall: No duplicate errors

### v0.1.81 (2026-02-13)

**Feature: Temp Market — One-Click App Marketplace**

Complete marketplace system for installing/uninstalling 6 third-party self-hosted apps. Each app deploys as OCI containers in Incus with automatic Caddy reverse proxy configuration and health checks.

**6 Supported Apps:**
- **Whoogle** — Privacy-focused Google search proxy (docker.io, port 5000)
- **SearXNG** — Privacy metasearch engine with shared Redis (docker.io, port 8080)
- **Redlib** — Reddit privacy frontend (quay.io, port 8080)
- **Wikiless** — Wikipedia privacy frontend with shared Redis (ghcr.io, port 8080)
- **Memos** — Note-taking app with shared PostgreSQL (docker.io, port 5230)
- **Immich** — Photo/video management with 4-container stack (ghcr.io, port 2283)

**New Files (18):**
- `src/lib/temp-market/definitions.ts` — App catalog (6 apps with metadata)
- `src/lib/temp-market/types.ts` — TypeScript interfaces
- `src/lib/temp-market/manifests.ts` — OCI manifest factories for all containers
- `src/lib/temp-market/installer.ts` — Install orchestrator with SSE progress
- `src/lib/temp-market/uninstaller.ts` — Uninstall (containers, routes, metadata)
- `src/lib/temp-market/status.ts` — Check installed/running status per app
- `src/lib/temp-market/health.ts` — HTTP and PostgreSQL health checks
- `src/lib/temp-market/metadata.ts` — Read/write install.json files
- `src/lib/temp-market/redis.ts` — Shared Redis lifecycle management
- `src/lib/temp-market/postgres-setup.ts` — Create/drop Memos database
- `src/lib/temp-market/searxng-config.ts` — Write SearXNG settings.yml
- `src/app/(dashboard)/temp-market/page.tsx` — Marketplace UI page
- `src/app/api/temp-market/install/route.ts` — POST SSE install stream
- `src/app/api/temp-market/uninstall/route.ts` — POST uninstall app
- `src/app/api/temp-market/status/route.ts` — GET app statuses
- `src/components/temp-market/app-card.tsx` — App card component
- `src/components/temp-market/install-dialog.tsx` — Install configuration dialog
- `src/components/temp-market/install-progress.tsx` — SSE progress display

**Modified Files:**
- `src/components/layout/sidebar.tsx` — Added Temp Market nav item
- `src/lib/apps/registry.ts` — Minor import adjustments
- `package.json` — Version 0.1.81

**Deployment Patterns Demonstrated:**
1. Simple standalone (Whoogle, Redlib) — 4 steps
2. Shared Redis dependency (SearXNG, Wikiless) — 5-6 steps
3. Shared PostgreSQL (Memos) — 5 steps
4. Multi-container with dedicated DB (Immich) — 8 steps

**Key Technical Decisions:**
- `ensureRoute()` wrapper for idempotent Caddy route creation (handles partial install retries)
- Immich PostgreSQL needs 2 GiB memory (pgvecto.rs loads ~400MB geocoding data)
- Immich server requires `IMMICH_HOST=0.0.0.0` (otherwise IPv6-only binding)
- 660s fetch timeout / 600s operation timeout for large OCI images (~1.5GB Immich ML)
- Shared Redis uses DB number isolation (SearXNG=DB0, Wikiless=DB1)
- Container naming: `market-{appId}` for single-container, `market-{appId}-{role}` for multi

**Bug fixes during development (v0.1.77→v0.1.81):**
- v0.1.78: Fixed CPU limits (`'0.5'`→`'1'` — Incus rejects fractional)
- v0.1.79: Fixed Redlib image (quay.io/redlib/redlib, added quay remote)
- v0.1.80: Fixed Immich PG OOM (512MiB→2GiB), fixed IPv6 binding (IMMICH_HOST=0.0.0.0)
- v0.1.81: Added ensureRoute() for idempotent route creation

**Testing (192.168.31.190):**
- All 6 apps: install + uninstall confirmed working
- Whoogle: Install 4/4 steps ✓, Uninstall ✓
- SearXNG: Install 6/6 steps ✓, Uninstall ✓ (shared Redis created/cleaned)
- Redlib: Install 4/4 steps ✓, Uninstall ✓
- Wikiless: Install 5/5 steps ✓, Uninstall ✓ (shared Redis reused/cleaned)
- Memos: Install 5/5 steps ✓, Uninstall ✓ (DB created/dropped in shared PG)
- Immich: Install 8/8 steps ✓, Uninstall ✓ (4 containers, ~7GB memory, 8+ min deploy)
- Health checks pass for all apps
- Caddy routes created and removed correctly
- Metadata files saved and cleaned up

---

### v0.1.76 (2026-02-12)

**Fix: Deployer continues past Authentik timeout**

The infrastructure deployer previously bailed out entirely when Authentik's health check timed out (step 3), skipping Caddy, Pi-Hole, and UI deployment. Authentik is slow to start (~3-5 min) and downstream steps don't depend on it being immediately healthy.

**Changes:**
- `src/lib/infrastructure/deployer.ts` — Removed `if (!healthy) return;` after Authentik health check. Deployment now continues through all 8 steps regardless of Authentik startup time.

**Testing:**
- Full deploy on dev server (192.168.31.190): Steps 1-8 all execute. Caddy deployed successfully even with Authentik still warming up.

---

### v0.1.75 (2026-02-12)

**Fix: Caddy config persistence across restarts**

After a VM restart, Caddy lost all routes pushed via Admin API because config was only held in memory. Implemented `--resume` flag approach which makes Caddy automatically save API-pushed config to `/config/caddy/autosave.json` and reload it on restart.

**Root Cause Analysis:**
- Caddy Admin API config is in-memory by default
- Previous attempts to write config files before container start failed (chicken-and-egg: container needed the file that needed the container to create it)
- Mounting a disk device at `/config` conflicted with Caddy's internal `XDG_CONFIG_HOME` directory

**Solution: `--resume` flag**
- Caddy's `--resume` flag auto-saves config pushed via `/load` endpoint to `/config/caddy/autosave.json`
- On restart, it loads autosave first, falling back to Caddyfile
- No external volume needed for `/config` — Caddy writes to its own container filesystem
- Eliminates ALL manual persistence code

**Changes:**
- `src/lib/infrastructure/manifests.ts` — Changed Caddy command to `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume`. Removed `/config` volume mount (kept `/data` for TLS certs only).
- `src/lib/infrastructure/deployer.ts` — Removed `initializeCaddyConfig` import and call from Step 6
- `src/lib/infrastructure/authentik-setup.ts` — Removed `initializeCaddyConfig()` function and unused imports
- `src/lib/caddy/client.ts` — Removed `persistConfigToDisk()` function, simplified `setConfig()` to just POST to Admin API

**Testing:**
- Deployed Caddy with `--resume` on dev server
- Pushed Authentik route via Admin API
- Restarted container — config persisted with both default and Authentik routes intact
- Port 80 proxy verified working from host

---

### v0.1.72 (2026-02-12)

**Feature: Unified Apps Tab with OCI Update Detection**

Complete overhaul of the Apps section. Consolidates all YouEye services (system components + OCI containers) into a single unified view with update detection, container controls, and SSE-powered update streaming.

**New Files:**
- `src/lib/apps/definitions.ts` — Single source of truth for 9 app definitions (host-system, incus, spine, control-panel, postgres, authentik, caddy, pihole, ui)
- `src/lib/apps/update-cache.ts` — Background 3-hour periodic update checking with in-memory cache
- `src/lib/apps/updater.ts` — OCI container rebuild via Incus API with snapshot-based rollback
- `src/app/api/apps/unified/route.ts` — GET /api/apps/unified combines definitions + Incus status + Spine status + digest cache
- `src/app/api/apps/[name]/update/route.ts` — POST SSE stream for app updates (OCI or Spine)
- `src/app/api/apps/[name]/check-update/route.ts` — POST per-app digest check
- `src/app/api/apps/check-updates/route.ts` — POST bulk check all OCI apps
- `src/app/(dashboard)/apps/[id]/page.tsx` — App detail page with container controls, update streaming, management links
- `src/app/(dashboard)/apps-legacy/page.tsx` — Copy of old apps page

**Modified Files:**
- `src/app/(dashboard)/apps/page.tsx` — Rewritten: unified list view with "Updates Available" section
- `src/lib/apps/registry.ts` — Rewritten: added digest checking functions (fetchRemoteDigest, checkAppUpdate, etc.)
- `src/lib/spine/client.ts` — Added getRegistryDigest method
- `src/components/layout/sidebar.tsx` — Removed "Updates" nav item, added "Apps (Legacy)"

**Architecture:**
- CP container now has internet access (firewall removed). Digest checks still go through Spine's `/api/registry/digest` endpoint for consistency
- OCI updates: CP creates snapshots → stops containers → rebuilds via Incus → starts → verifies → rollback on failure
- Spine-managed updates: proxied to Spine API (update self, control, incus, system, ui)

**Bug Fix (v0.1.71 → v0.1.72):**
- Fixed Next.js routing conflict: `[id]` vs `[name]` dynamic segments at `/api/apps/` level
- Moved new API routes from `[id]` to `[name]` to match existing convention

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.72
- Clean startup, no routing errors
- Spine registry digest endpoint verified for Docker Hub, GHCR images

---

### v0.1.70 (2026-02-12)

**Fix: UI SSO Environment Variables Not Loaded**

After running the setup wizard, the UI showed "SSO is not configured" because the LXD deployer's systemd service template did not include `EnvironmentFile` directive. The env file existed (written by Spine) but the service never loaded it.

**Root Cause:**
- `lxd-deployer.ts` created the UI systemd service without `EnvironmentFile=-/etc/youeye-ui.env`
- Spine's `handleUISSO` wrote the env file but only called `systemctl start` (no-op if already running)
- Result: UI process ran without AUTHENTIK_URL, AUTHENTIK_CLIENT_SECRET, etc.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Added `EnvironmentFile=-/etc/${spec.containerName}.env` to service template

**Testing:**
- Verified on dev server (192.168.31.190): UI login page shows `ssoConfigured: true` and "Sign in with Authentik" button
- All services healthy: UI 307, CP 307, Authentik 302

---

### v0.1.69 (2026-02-12)

**Fix: Authentik HTTP 400 Error via Caddy**

Caddy proxy returned HTTP 400 when accessing Authentik because the setup wizard configured the upstream port as 9443 (HTTPS) while Caddy sends plain HTTP.

**Changes:**
- `src/app/api/setup/run/route.ts` — Changed Authentik route port from 9443 to 9000

**Testing:**
- Verified on dev server: Authentik returns 302 via Caddy proxy

---

### v0.1.68 (2026-02-12)

**Feature: Infrastructure Deployment Moved from Spine to Control Panel**

All infrastructure app deployment logic previously in Spine (Go) has been moved to the Control Panel (TypeScript). Spine now only: (1) installs Incus, (2) starts its API, (3) deploys the CP container, (4) calls the CP's SSE endpoint to deploy everything else.

**Architecture:**
- SSE endpoint at `/api/deploy/infrastructure` deploys 8 steps: PostgreSQL, Authentik DB setup, Authentik server, Authentik worker, API token, Caddy, Pi-Hole, YouEye UI
- OCI containers deployed via Incus REST API (Unix socket)
- LXD containers (YouEye UI) deployed as Debian + Node.js with systemd service
- Secrets stored in `/var/lib/youeye/` per-service with auto-generation
- Keepalive SSE comments every 10s prevent idle timeout during long operations

**New Files (10):**
- `src/lib/infrastructure/types.ts` — OCIManifest, LXDContainerSpec, DeploymentEvent types
- `src/lib/infrastructure/manifests.ts` — All 7 app manifests (postgres, authentik, caddy, pihole, ui)
- `src/lib/infrastructure/secrets.ts` — Secret generation and persistence
- `src/lib/infrastructure/oci-deployer.ts` — OCI container lifecycle via Incus API
- `src/lib/infrastructure/lxd-deployer.ts` — LXD container deploy with Node.js + systemd
- `src/lib/infrastructure/health-checks.ts` — Service health checks (postgres, authentik, caddy, pihole)
- `src/lib/infrastructure/postgres-setup.ts` — Authentik database/user creation via psql
- `src/lib/infrastructure/authentik-setup.ts` — API token creation, Caddy route setup
- `src/lib/infrastructure/deployer.ts` — Main orchestrator (8-step sequential deployment)
- `src/app/api/deploy/infrastructure/route.ts` — SSE endpoint with auth and keepalive

**Modified Files:**
- `src/lib/incus/server.ts` — Added `execCommand`/`execShell` with chunked `/wait?timeout=30` polling, `incusRawGet` for log files
- `src/middleware.ts` — Added `/api/deploy/infrastructure` to API routes

**Key Bugs Fixed:**
- SSE idle timeout: Added keepalive comments every 10s
- Port 3000 conflict: Made port proxy errors non-fatal (UI port 3000 vs CP port 3000)
- Missing systemd service: LXD deployer now creates and starts `.service` file
- Socket timeout in execCommand: Changed from bare `/wait` to chunked `/wait?timeout=30` with retry
- npm install styled-jsx: Replaced with direct curl from npm registry (avoids 3min+ pnpm node_modules scanning)
- Service file creation: Uses base64 encode/decode instead of heredoc for reliability over exec API

**Testing:**
- 5 iterative deploy cycles on dev server (192.168.31.190)
- All 7 containers deploy and run: postgres, authentik (server+worker), caddy, pihole, control, ui
- CP returns 200, Authentik healthy, Pi-Hole DNS resolving, UI service active
- `spine deploy` exits 0 with full SSE stream

---

### v0.1.62 (2026-02-11)

**Feature: Auto Pi-Hole DNS Rewrite on Domain Change**

When a user configures a domain name (via setup wizard or proxy page), Pi-Hole automatically gets a wildcard DNS entry so `domain.com` and `*.domain.com` resolve to the server's LAN IP.

**How it works:**
- Uses Pi-Hole FTL v6 `misc.dnsmasq_lines` config API
- Single `address=/domain.com/IP` directive handles base domain + all subdomains
- Old domain entries are automatically cleaned up on domain change
- Runs silently — no UI changes needed, errors are non-critical

**Changes:**
- `src/lib/apps/pihole-api.ts` — Added `getDnsmasqLines()`, `setDnsmasqLines()`, `setDomainDNS()`, `removeDomainDNS()` functions
- `src/app/api/setup/run/route.ts` — Added DNS step after Caddy routes in setup wizard
- `src/app/api/domain/route.ts` — Added Pi-Hole DNS rewrite + Spine config sync on domain POST

**Bug Fix:**
- Proxy page domain POST was not syncing to Spine config. Added `spineClient.patchConfig({ domain })` call.

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.62
- Set domain to `mytest.local` → Pi-Hole entry added, DNS resolves correctly
- Changed to `newdomain.example` → old entry removed, new entry added
- Wildcard works: `app.newdomain.example` resolves to `192.168.31.190`
- Old domain `mytest.local` returns NXDOMAIN after change
- Spine config synced correctly

---

### v0.1.60 (2026-02-10)

**Feature: Setup Wizard + White-Labeling**

Initial setup wizard for first-time configuration, plus white-labeling support using dynamic `site_name` from Spine config.

**Setup Wizard:**
- `src/app/setup/layout.tsx` — Minimal centered layout (no sidebar)
- `src/app/setup/page.tsx` — 3-step client wizard: server config, admin account, SSE installation progress
- `src/app/api/setup/config/route.ts` — Public GET for config check, admin PUT for updates
- `src/app/api/setup/run/route.ts` — Full SSE-streamed setup: save config, create Caddy routes, create admin user, configure SSO for CP + UI, write site_name to UI DB, mark setup complete
- `src/lib/spine/client.ts` — Added `getConfig()`, `setConfig()`, `patchConfig()` methods
- `src/middleware.ts` — Added `/api/setup/config` to PUBLIC_ROUTES

**White-Labeling:**
- `src/lib/site-config.ts` — Server-side `getSiteConfig()` reads from Spine
- `src/hooks/use-site-config.ts` — Client-side `useSiteConfig()` hook
- `src/app/layout.tsx` — Dynamic `generateMetadata()` using site_name
- `src/app/login/page.tsx` — Login heading uses site_name
- `src/app/(dashboard)/settings/page.tsx` — UI section uses site_name

**Bug Fix:**
- GET `/api/setup/config` was returning 401 because the route handler had its own `getSession()` check. Removed session check from GET (public endpoint for setup-check). PUT still requires admin auth.

**Testing:**
- Deployed to dev server (192.168.31.190)
- `/api/setup/config` returns 200 with config (verified public access)
- Login page renders with dynamic title ("YouEye Control Panel")
- Setup page requires authentication (redirects to login)

---

### v0.1.59 (2026-02-10)

**Fix: Spine client timeout race**

Increased Spine Unix socket client timeout from 30s to 60s. The old timeout raced with Spine's health check loop (30s max), causing "Request timeout" when enabling UI.

**Changes:**
- `src/lib/spine/client.ts` — `req.setTimeout(60000)` (was 30000)

**Testing:**
- Deployed to dev server, full deploy passes, 7 containers running

---

### v0.1.56 (2026-02-09)

**Feature: YouEye UI Management (Phase 2)**

Automated UI container lifecycle management from the Settings page.

**Changes:**
- Settings page: Added YouEye UI section (visible when SSO configured + UI installed)
  - Domain input with auto-suggestion (ui.{domain})
  - Enable UI button: creates Authentik OAuth2, Caddy route, DB, starts service
  - Disable UI button: removes Authentik resources, Caddy route, stops service
  - Live status indicator (not-installed/installed/running)
- New API route: `/api/ui` (GET status, POST enable, DELETE disable)
- New library: `src/lib/ui/manager.ts` — full UI lifecycle management
- Spine client: added getUISSO(), setUISSO(), deleteUISSO(), updateUI() methods
- SpineStatusResponse: added `ui` field with status/installed/enabled/version/ip

**Testing:**
- Deployed to dev VM (192.168.31.190)
- Spine API returns correct UI status (installed, enabled, version, IP)
- CP Settings page bundle includes full UI management code
- API route `/api/ui` responds correctly

### v0.1.55 (2026-02-09)

**Fix: SSO Callback Redirect — All Redirects Now Use CONTROL_EXTERNAL_URL**

**Problem:**
After SSO login with Authentik, the browser was redirected to `http://0.0.0.0:3000/` instead of `https://control.skibidi.wtf/`. The v0.1.54 fix only applied `CONTROL_EXTERNAL_URL` to the OAuth2 token exchange `redirect_uri`, but the `NextResponse.redirect()` calls for navigation (success → `/`, errors → `/login?error=...`) still used `request.url` as the base URL. Inside the container, `request.url` resolves to `http://0.0.0.0:3000/...`.

**Root Cause:**
`NextResponse.redirect(new URL('/', request.url))` uses `request.url` which is `http://0.0.0.0:3000/api/auth/callback?code=...` inside the container.

**Solution:**
Compute `baseUrl` once at the top of the GET handler from `CONTROL_EXTERNAL_URL` (with forwarded-header fallback), then use it for ALL redirects — not just the token exchange redirect_uri.

**Deployment Note:**
Previous deployment used `rm -rf /opt/app/*` which doesn't remove dotfiles (`.next` directory). The old `.next` survived, causing stale compiled chunks to be served. Fixed by using `rm -rf /opt/app && mkdir -p /opt/app` to fully remove the directory including dotfiles.

**Modified Files:**
- `src/app/api/auth/callback/route.ts` — Moved `baseUrl` computation above all early returns, all `NextResponse.redirect(new URL(..., request.url))` changed to `new URL(..., baseUrl)`
- `package.json` — Version 0.1.55

**Testing (192.168.31.190):**
- `curl -sI http://10.117.96.245:3000/api/auth/callback` → `location: https://control.skibidi.wtf/login?error=Missing+code+or+state` (was `http://0.0.0.0:3000/...`)
- `spine status` → Control Panel: Running (v0.1.55)
- Process env verified: `CONTROL_EXTERNAL_URL=https://control.skibidi.wtf` present in node process

---

### v0.1.54 (2026-02-09)

**Fix: SSO Redirect URL & Authentik 2025.12 Compatibility**

**Summary:**
Fixed SSO redirect_uri going to `0.0.0.0:3000` instead of the proper subdomain. Added `CONTROL_EXTERNAL_URL` env var for explicit redirect URI control. Updated SSO setup to pass `control_url` to Spine for env injection.

**Problem:**
When the Control Panel runs inside an Incus container with `listen: 0.0.0.0:3000`, the `request.headers.get('host')` returns `0.0.0.0:3000` instead of the actual subdomain. This caused OAuth2 redirect_uri to be set incorrectly, breaking SSO login flow.

**Solution:**
Use `process.env.CONTROL_EXTERNAL_URL` (injected by Spine via systemd EnvironmentFile) as the authoritative source for the redirect URI. Falls back to request headers if env var not set.

**Modified Files:**
- `src/app/api/auth/sso/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI, fixed `secure` cookie flag to use `redirectUri.startsWith('https://')` instead of out-of-scope `proto` variable
- `src/app/api/auth/callback/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI
- `src/lib/auth/sso-setup.ts` - Pass `control_url: params.controlExternalUrl` to `spineClient.setControlSSO()`
- `src/lib/spine/client.ts` - Added `control_url: string` to `setControlSSO` params type
- `package.json` - Version 0.1.54

**Testing (192.168.31.190):**
- SSO setup successful with Authentik 2025.12
- Redirect URI: `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in SSO env file
- Auth mode correctly reports `ssoConfigured: true`

---

### v0.1.53 (2026-02-08)

**Feature: Self-Service SSO Setup via Settings Page**

**Summary:**
Complete SSO implementation allowing the Control Panel to configure its own Authentik SSO through a new Settings page UI. When accessed via IP address, login uses PAM. When accessed via subdomain, login uses Authentik SSO (no PAM option).

**How it works:**
1. Settings page checks prerequisites (domain configured, Authentik + CP subdomains in Caddy, Authentik healthy)
2. "Setup SSO" button creates OAuth2 Provider + Application in Authentik via API
3. Creates groups scope mapping for admin detection via OIDC
4. Spine stores env vars (`AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_INTERNAL_URL`) via systemd drop-in
5. CP restarts with SSO env vars loaded
6. Auth mode detection: PAM on IP access, SSO on subdomain access

**Key Design Decisions:**
- Uses Authentik 2024.12 API paths (`/propertymappings/provider/scope/`, dict-format `redirect_uris`)
- `AUTHENTIK_INTERNAL_URL` (Incus DNS `http://youeye-authentik.incus:9000`) for server-side token exchange to avoid self-signed TLS issues
- `AUTHENTIK_URL` (external URL like `https://id.skibidi.wtf`) for browser redirects
- Systemd EnvironmentFile drop-in (`sso.conf`) for clean env injection that survives CP updates

**New Files:**
- `src/lib/auth/sso-setup.ts` - Core SSO setup/teardown logic (Authentik API calls)
- `src/app/api/auth/sso/status/route.ts` - GET endpoint: SSO prerequisites and configuration status
- `src/app/api/auth/sso/setup/route.ts` - POST endpoint: Execute SSO setup
- `src/app/api/auth/sso/disable/route.ts` - POST endpoint: Disable SSO
- `src/app/(dashboard)/settings/page.tsx` - Settings page with SSO prerequisites checklist and setup/disable buttons

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added Settings nav item
- `src/lib/spine/client.ts` - Added `getControlSSO()`, `setControlSSO()`, `deleteControlSSO()` methods
- `src/lib/auth/authentik.ts` - Added `AUTHENTIK_INTERNAL_URL` for server-side calls, `groups` scope
- `src/middleware.ts` - Block PAM login on subdomain access (403), exact-match SSO public route

**Testing (192.168.31.190):**
- SSO prerequisites all met (domain, subdomains, Authentik health)
- Setup creates OAuth2 provider/app in Authentik, configures env vars
- Auth mode: `pam` on IP, `sso` on subdomain
- SSO redirect to `https://id.skibidi.wtf/application/o/authorize/` with correct params
- PAM login blocked on subdomain with 403 error
- Disable/re-enable cycle works
- Version 0.1.53 deployed and verified

---

### v0.1.51 (2026-02-08)

**Bug Fixes: Updates Page Crash, LAN Port Untick, People Create 500**

**Summary:**
Three bugs found during manual testing on user's test server, plus a backend fix discovered during verification:

1. **Bug 1 - Updates page crash**: `Cannot read properties of undefined (reading 'split')`. The TypeScript `AppInfo` interface used `container` and `image` fields, but Spine API returns `container_name` and `image_tag`. The line `app.image.split(':').pop()` crashed on undefined.
2. **Bug 2 - LAN port checkbox snap-back**: After enabling LAN port, unticking the checkbox and pressing save would visually revert to ticked. The checkbox was controlled by `state.lanEnabled` which only updated after API response, not optimistically.
3. **Bug 2b - LAN port device not removed**: Even with the frontend fix, the Incus PATCH method merges device maps and cannot delete keys. Changed to PUT with full config to properly remove the `lan-web` device.
4. **Bug 3 - People API 500 on create**: `createUser()` succeeded but `setUserPassword()` failed (Authentik password policy), causing 500 that masked successful user creation.

**Modified Files:**
- `src/lib/spine/client.ts` - Fixed `SpineUpdatesCheckResponse.apps` type: `container`→`container_name`, `image`→`image_tag`, added `available: boolean`
- `src/app/(dashboard)/updates/page.tsx` - Fixed `AppInfo` interface, replaced crash-prone `app.image.split(':').pop()` with safe `app.image_tag || 'latest'`
- `src/components/proxy/container-routing-table.tsx` - Optimistic `lanEnabled` state update on checkbox click, revert on API failure
- `src/app/api/containers/[name]/lan-port/route.ts` - Changed PATCH to PUT with full instance config (architecture, config, devices, profiles) so device removal actually works
- `src/app/api/people/route.ts` - Wrapped `setUserPassword()` in separate try/catch, returns `{ success: true, passwordWarning }` instead of 500

**Testing (192.168.31.190):**
- Updates page: returns 200, API returns correct `container_name`/`image_tag` fields
- LAN port: enable (port 8888) adds `lan-web` device, disable removes it completely
- People create: returns `{ success: true, passwordWarning }` instead of 500
- No errors in control panel logs after deployment
- v0.1.51 deployed and verified

---

### v0.1.49 (2026-02-08)

**Multi-Feature: People Tab, Proxy Simplification, Updates Apps, SSO Dual-Auth**

**Summary:**
Four major features implemented in a single release:
1. **CP1 - People Management Tab**: Full user CRUD via Authentik API. List/create/delete users, toggle admin (via "authentik Admins" group), set passwords, show/hide hidden system users.
2. **CP2 - Proxy Simplification**: Rewrote routing table to subdomain-only (removed path routing). Added LAN Port column with checkbox + port input to expose containers directly on host.
3. **CP3 - Updates Page Apps**: Extended updates page with Incus version, system packages count, and app container cards with rebuild button.
4. **CP4 - SSO Dual-Auth**: OAuth2 login via Authentik when accessed through subdomain. IP-based access uses PAM. Auto-detects mode at login.

**New Files:**
- `src/app/(dashboard)/people/page.tsx` - People management page with user table, create form, password dialog
- `src/app/api/people/route.ts` - GET (list users) and POST (create user) with admin group detection
- `src/app/api/people/[id]/route.ts` - PATCH (update user, toggle admin) and DELETE
- `src/app/api/people/[id]/password/route.ts` - POST to set user password
- `src/app/api/containers/[name]/lan-port/route.ts` - POST to add/remove Incus proxy device for LAN port
- `src/lib/auth/authentik.ts` - OAuth2 helper (buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, isSSOConfigured)
- `src/app/api/auth/sso/route.ts` - GET: initiates OAuth2 flow, redirects to Authentik
- `src/app/api/auth/callback/route.ts` - GET: OAuth2 callback, exchanges code, creates JWT session
- `src/app/api/auth/mode/route.ts` - GET: returns 'pam' or 'sso' based on Host header

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added People nav item between DNS and Updates
- `src/components/proxy/container-routing-table.tsx` - Complete rewrite: subdomain-only + LAN port column
- `src/app/(dashboard)/proxy/page.tsx` - Updated description text
- `src/app/api/containers/route.ts` - Added lanPort field with getLanPort() helper
- `src/lib/spine/client.ts` - Extended SpineUpdatesCheckResponse with incus/system/apps, added updateApp()
- `src/app/(dashboard)/updates/page.tsx` - Complete rewrite: Incus/System/App cards, rebuild button
- `src/app/api/updates/[component]/route.ts` - Unknown components now route to updateApp()
- `src/middleware.ts` - Added SSO/callback/mode to PUBLIC_ROUTES
- `src/app/login/page.tsx` - Split into Suspense wrapper + LoginContent, auth mode detection, SSO redirect

**Bug Fix (v0.1.49):**
- LAN port API now checks Incus response for errors (previously returned success even on failure)

**Testing (192.168.31.190):**
- Spine v0.1.27 + CP v0.1.49 deployed, all 7 containers running
- Auth mode API: returns `pam` for IP access, `sso` when configured
- People API: lists Authentik users with admin group detection
- LAN port: successfully adds/removes Incus proxy devices (tested on Pi-Hole port 9999)
- Updates API: returns incus v6.21, system 70 packages, 5 app containers
- Login page loads correctly (200)
- All pages accessible: /updates, /people, /proxy (200)

---

### v0.1.47 (2026-02-08)

**Authentik in Reverse Proxy Routing Table**

**Summary:**
Set `webPort: 9000` in Authentik manifest so it appears in the reverse proxy routing table on the proxy page. Also includes Authentik management page scaffolding (users, groups, stats API routes).

**Code Changes:**
- `src/lib/apps/manifest.ts` - Changed Authentik `webPort: undefined` to `webPort: 9000`
- `src/app/(dashboard)/apps/authentik/page.tsx` - NEW: Authentik management page
- `src/app/api/apps/authentik/stats/route.ts` - NEW: Authentik stats API
- `src/app/api/apps/authentik/users/route.ts` - NEW: Users API
- `src/app/api/apps/authentik/groups/route.ts` - NEW: Groups API
- `src/lib/authentik/client.ts` - NEW: Authentik API client library

**Testing (192.168.31.190):**
- CP v0.1.47 deployed, `spine update control` successful
- Containers API returns Authentik with `webPort: 9000` and `status: running`
- Three containers in proxy routing table: Control Panel (3000), Pi-Hole (80), Authentik (9000)

---

### v0.1.45 (2026-02-08)

**Security: Fetch Pi-Hole Password from Spine API**

**Summary:**
Removed hardcoded `DEFAULT_PIHOLE_PASSWORD` constant. Pi-Hole password is now fetched from Spine's `/api/pihole/credentials` API endpoint. Password changes are synced back to the host file via Spine API.

**Code Changes:**
- `src/lib/spine/client.ts` - Added `SpinePiholeCredentials` interface, `getPiholeCredentials()` (GET), `updatePiholePassword(password)` (POST)
- `src/lib/apps/secrets.ts` - Removed `DEFAULT_PIHOLE_PASSWORD = 'youeye_admin'`; `getPiholePassword()` now fetches from Spine API with systemd env fallback; `setPiholePassword()` syncs to host file via Spine API; `initializePiholePassword()` fetches from Spine if no explicit password; `hasCustomPiholePassword()` checks for empty string instead of comparing to hardcoded default

**Testing (192.168.31.190):**
- CP v0.1.45 deployed and healthy
- Spine Pi-Hole credentials API returns password
- Health check passes

---

### v0.1.44 (2026-02-09)

**PostgreSQL Management UI & SQL Console**

**Summary:**
Added full PostgreSQL management page with 4 tabs (Overview, Databases, SQL Console, Connection Info). Queries PostgreSQL via `incus exec` + psql (no npm pg dependency needed). Includes read-only SQL console for safe query execution.

**Code Changes:**
- `src/lib/postgres/client.ts` - NEW: PostgreSQL client using execShell + psql --csv. Functions: psqlQuery(), parseCSVLine(), queryReadOnly() (wraps in READ ONLY transaction), listDatabases(), getStats()
- `src/lib/incus/server.ts` - Added `incusRawGet()` for fetching exec log file content. Fixed `execCommand()` to fetch stdout/stderr from Incus log file paths instead of returning paths as content.
- `src/lib/apps/manifest.ts` - Added POSTGRES_MANIFEST (postgres:17-alpine)
- `src/lib/spine/client.ts` - Added getPostgresCredentials()
- `src/app/api/apps/postgres/stats/route.ts` - NEW: GET endpoint returning version, uptime, connections, database sizes
- `src/app/api/apps/postgres/databases/route.ts` - NEW: GET endpoint returning database list with owner, encoding, size
- `src/app/api/apps/postgres/query/route.ts` - NEW: POST endpoint for read-only SQL execution with CSRF protection
- `src/app/(dashboard)/apps/postgres/page.tsx` - NEW: 4-tab management page (Overview, Databases, SQL Console, Connection Info)
- `src/app/(dashboard)/apps/page.tsx` - Added PostgreSQL card with database icon and Manage link

**Key Decisions:**
- Used execShell + psql instead of `pg` npm package (Turbopack bundling breaks pg module resolution)
- Added incusRawGet for raw HTTP requests to Incus log endpoints (exec output stored in files, not returned inline)
- Filtered psql command tags (BEGIN, COMMIT, SET) from CSV output to prevent parser confusion
- Connected as `-U youeye` role (not default `postgres` role, since POSTGRES_USER=youeye)

**Bug Fixes (iterations v0.1.38 → v0.1.44):**
- v0.1.38: Initial implementation with `pg` npm package
- v0.1.39: Added serverExternalPackages for pg (didn't fix Turbopack issue)
- v0.1.40: Rewrote to use execShell + psql (removed pg dependency entirely)
- v0.1.41: Fixed execCommand returning log file paths instead of content (added incusRawGet)
- v0.1.42: Fixed psql connecting as wrong role (added `-U youeye`)
- v0.1.43: Fixed uptime query single-quote escaping
- v0.1.44: Filtered psql command tags from CSV output

**Testing (192.168.31.190):**
- 33/33 Playwright e2e tests passing (9 new PostgreSQL tests)
- Stats endpoint: version, uptime, connections, database sizes
- Databases endpoint: youeye + postgres databases with correct owner/encoding
- SQL Console: SELECT queries execute correctly with proper column/row parsing
- Write protection: CREATE TABLE rejected in READ ONLY transaction
- All existing Caddy/Pi-Hole/auth tests still passing

---

### v0.1.37 (2026-02-08)

**Remove install infrastructure, simplify to Spine-deployed apps**

**Summary:**
Removed all container install/deploy functionality from the Control Panel. Apps (Caddy, Pi-Hole, Postgres, Redis, Authentik) are now deployed exclusively by Spine. CP only manages already-deployed containers. Removed ~3000 lines of install code. Container firewall was later removed to allow internet access.

**Code Changes:**
- Deleted: `src/app/api/apps/install/route.ts` (315 lines) - Install API
- Deleted: `src/app/api/test/install-app/route.ts` (405 lines) - Test install API
- Deleted: `src/app/(dashboard)/apps/postgres/page.tsx` (647 lines) - Postgres management UI
- Deleted: `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik page
- Deleted: `src/app/api/apps/postgres/*` (databases, stats, users routes)
- Deleted: `src/app/api/apps/authentik/stats/route.ts`
- `src/lib/apps/manifest.ts` - Simplified from 362 to 53 lines. Only Caddy + Pi-Hole manifests. Removed OCI config generation, parseOCIImage, manifestToIncusConfig.
- `src/lib/apps/registry.ts` - Removed getRegistry, getAppInstance, isBuiltInApp, fetchRemoteRegistry
- `src/types/apps.ts` - Removed 'installing' status, PortMapping, HealthCheck, AppRegistry, InstallAppRequest
- `src/app/(dashboard)/apps/page.tsx` - Rewritten: simple 2-column card grid, no install buttons, Manage links
- `src/app/(dashboard)/proxy/page.tsx` - Removed installCaddy, shows "spine deploy" message when not deployed
- `src/app/(dashboard)/dns/page.tsx` - Removed installPihole, shows "spine deploy" message when not deployed
- `src/middleware.ts` - Removed /api/test/install-app from PUBLIC_ROUTES
- `src/components/proxy/proxy-status-card.tsx` - Removed manifest.version reference
- Removed `@playwright/test` from devDependencies (was added in error)

**Testing (192.168.31.190):**
- 24/24 Playwright e2e tests passing (standalone test suite in YouEye-Agents)
- Verified no install buttons on apps/proxy/dns pages
- Verified no postgres/authentik/redis cards on apps page
- Verified API returns exactly 2 apps (Caddy + Pi-Hole)
- Verified removed API routes return 401/404
- Container has internet access (firewall was later removed)

---

### v0.1.36 (2026-02-07)

**Fix: Pi-Hole password change, auth race condition, wildcard TLS, HTTP redirect**

**Summary:**
Fixed three Pi-Hole bugs and two Caddy HTTPS issues. Password change returned 400 due to field name mismatch. Multiple simultaneous API calls caused 429 rate-limit errors from Pi-Hole FTL. Caddy accumulated redundant per-subdomain TLS certs instead of using wildcard. HTTP did not redirect to HTTPS.

**Root Causes:**
1. `dns/page.tsx` sent `{ password: newPassword }` but backend expected `{ newPassword }`
2. `pihole-api.ts` `getSession()` had no lock - parallel requests all called `authenticate()` simultaneously, triggering Pi-Hole FTL 429 rate-limit
3. `caddy/client.ts` `ensureTLSSubject()` added individual subdomain certs even when `*.domain` wildcard existed
4. `caddy/client.ts` `ensureHTTPSConfig()` added `:80` to server listen array, causing routes to be served on both ports instead of redirecting

**Code Changes:**
- `src/app/(dashboard)/dns/page.tsx` - Fixed field name: `{ password: newPassword }` → `{ newPassword }`
- `src/lib/apps/pihole-api.ts` - Added Promise-based mutex lock to `getSession()` so only first request authenticates, others wait
- `src/lib/caddy/client.ts` - `ensureTLSSubject()`: skip adding subdomain if covered by wildcard
- `src/lib/caddy/client.ts` - `setDomain()`: clean up stale per-subdomain subjects, keep only `domain` + `*.domain`
- `src/lib/caddy/client.ts` - `ensureHTTPSConfig()`: remove `:80` from listen array, let Caddy auto-create redirect server
- `src/lib/caddy/client.ts` - Initial server creation: only listen on `:443`

**Testing (192.168.31.190):**
- Password change: 200 OK (was 400)
- 4 parallel Pi-Hole API calls: all succeeded, no 429 errors (was getting 429)
- TLS subjects cleaned to only `skibidi.wtf` + `*.skibidi.wtf` (was accumulating stale per-subdomain certs)
- Wildcard skip log: `Skipping TLS subject pihole.skibidi.wtf - covered by wildcard *.skibidi.wtf`
- HTTP redirect: 308 Permanent Redirect to HTTPS (was serving routes on port 80)
- HTTPS access: 302 from Pi-Hole (working)
- Server listeners: only `:443` (was `:443` + `:80`)

**IMPORTANT - TLS is self-signed:**
Caddy uses `module: internal` (self-signed via Caddy's internal CA), NOT Let's Encrypt. This is for local LAN only.

---

### v0.1.35 (2026-02-05)

**Fix: Pi-Hole FTL v6 API Authentication**

**Summary:** 
Fixed Pi-Hole integration to use SID URL parameter instead of Cookie header.

**Root Cause:**
Pi-Hole FTL v6+ requires the session ID (`sid`) to be passed as a URL query parameter (`?sid=xxx`), NOT as a Cookie header (`Cookie: sid=xxx`). The previous implementation used Cookie authentication which returned "Unauthorized" errors.

**Code Changes:**
- `src/lib/apps/pihole-api.ts`: NEW FILE - Complete Pi-Hole FTL v6 API client with session management
- Changed `piholeRequest()` to append `?sid=xxx` to URL instead of using Cookie header
- Updated all Pi-Hole route handlers to use new `pihole-api.ts` library

**Endpoints Updated:**
- `/api/apps/pihole/stats` - Uses `getStats()`
- `/api/apps/pihole/queries` - Uses `getQueryLog()`
- `/api/apps/pihole/dns-records` - Uses `getDNSRecords()`, `addDNSRecord()`, `removeDNSRecord()`
- `/api/apps/pihole/cname-records` - Uses `getCNAMERecords()`, `addCNAMERecord()`, `removeCNAMERecord()`
- `/api/apps/pihole/domains` - Uses `getDomainLists()`, `addDomain()`, `removeDomain()`
- `/api/apps/pihole/control` - Uses `setBlocking()`
- `/api/apps/pihole/password` - Added `clearPiholeSession()` call

**Testing:**
- Tested from dev server (192.168.31.190)
- Auth: `POST /api/auth` returns valid session with SID
- Stats with ?sid= parameter returns full summary data
- Cookie authentication confirmed NOT working (returns unauthorized)

---

### v0.1.32 (2026-02-05)

**Bug Fixes: Volume Permissions, Pi-Hole Web Server, Test API Middleware**

**Summary:** 
- Fixed Caddy volume permission issues with `shift: true`
- Fixed Pi-Hole FTL v6+ web server with `FTLCONF_webserver_port`
- Added test endpoint to PUBLIC_ROUTES to bypass JWT auth

**Root Causes:**
1. **Caddy Permission Denied:** Incus UID mapping caused `/data` to be owned by `nobody:nobody` inside container.
   Volume devices need `shift: 'true'` to enable Incus ID shifting.
2. **Pi-Hole Web Interface Down:** FTL v6+ has built-in web server but requires explicit `FTLCONF_webserver_port` env var.
3. **Test API Unauthorized:** Middleware required JWT for all routes - test endpoint uses X-Test-Secret header instead.

**Code Changes:**
- `src/lib/apps/manifest.ts`: Added `shift: 'true'` to disk device config in `manifestToIncusConfig()`
- `src/lib/apps/manifest.ts`: Added `FTLCONF_webserver_port: '80'` to Pi-Hole environment
- `src/middleware.ts`: Added `/api/test/install-app` to PUBLIC_ROUTES

**Testing:**
- Verified Caddy `/data/caddy` owned by `root:root` (not `nobody:nobody`)
- Verified Pi-Hole web interface responds on port 8080 (HTTP 302)
- Test API returns app list successfully

---

### v0.1.31 (2026-02-05)

**Feature: Test Install API Endpoint**

**Summary:** Added `/api/test/install-app` endpoint for automated app installation testing.

**Purpose:**
Provides a secure way for Iris (AI agent) to install/uninstall apps for testing without browser login.

**Security:**
- Requires `TEST_ADMIN_SECRET` environment variable (generated by Spine)
- Validates `X-Test-Secret` header against env var
- Rate limited (5 seconds between requests)
- Logged for audit trail

**API:**
```
GET /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Returns: List of available apps with status

POST /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Body: { "appName": "pihole", "action": "install" | "uninstall" }
  Returns: Success/failure status
```

**Code Changes:**
- `src/app/api/test/install-app/route.ts`: NEW FILE - Secure test endpoint

---

### v0.1.30 (2026-02-05)

**Bug Fix: Pi-Hole Password Change Using Incus REST API**

**Summary:** Rewrote Pi-Hole password change to use Incus REST API instead of shell commands.

**Root Cause:**
The `setPiholePassword()` function in `secrets.ts` was using `exec('incus config set ...')` to store the password.
This fails inside the Control Panel container because there is no `incus` binary installed - the container 
only has access to the Incus Unix socket, not the CLI tools.

**Solution:**
Changed `setPiholePassword()` to use `incusRequest()` to call the Incus REST API via Unix socket:
- Uses `PATCH /1.0/instances/youeye-pihole` to update container config.user.password
- Uses `updateInstanceState()` to restart the container after password change
- Changed `execInControl` to `execLocal` for local command execution

**Code Changes:**
- `src/lib/apps/secrets.ts`:
  - Added imports: `incusRequest`, `updateInstanceState` from `@/lib/incus/server`
  - Rewrote `setPiholePassword()` to use Incus REST API
  - Changed `execInControl` to `execLocal` for retrieving Incus configuration

**Testing:**
- Fresh `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.15 + Control Panel v0.1.30 running
- CSRF endpoint accessible
- Login page loads correctly

---

### v0.1.29 (2026-02-05)

**Bug Fix: CSRF Endpoint Blocked by Middleware**

**Summary:** Added `/api/auth/csrf` to PUBLIC_ROUTES so it can be accessed without authentication.

**Root Cause:**
The CSRF endpoint was returning 401 Unauthorized because middleware blocked unauthenticated access.

**Fix:**
Added `/api/auth/csrf` to PUBLIC_ROUTES array in middleware.ts.

**Code Changes:**
- `src/middleware.ts` - Added `/api/auth/csrf` to PUBLIC_ROUTES

**Testing:**
- CSRF endpoint returns 200 with `{"csrfToken":null}` when no cookie present
- Accessible both internally and externally

---

### v0.1.28 (2026-02-05)

**Bug Fixes: CSRF Endpoint & Pi-Hole DNS Port Binding**

**Summary:** 
1. Created missing CSRF token endpoint
2. Fixed Pi-Hole DNS port 53 conflict with Incus dnsmasq

**Issue 1: CSRF 404**
Pages were fetching `/api/auth/csrf` which didn't exist.

**Fix 1:**
Created CSRF endpoint that reads `ye-csrf` cookie and returns the token.

**Issue 2: Pi-Hole Port 53 Conflict**
Incus dnsmasq binds to bridge IP (10.x.x.x:53). Pi-Hole tried to bind to 0.0.0.0:53 which conflicted.

**Fix 2:**
- Added `getHostExternalIP()` function that reads from `HOST_IP` env var
- Added `fixPiHoleDNSBinding()` that modifies DNS proxy devices to use host external IP instead of 0.0.0.0
- Special handling for `manifest.name === 'pihole'`

**New Files:**
- `src/app/api/auth/csrf/route.ts` - Returns CSRF token from ye-csrf cookie

**Modified Files:**
- `src/app/api/apps/install/route.ts` - Added Pi-Hole DNS binding fix

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- CSRF endpoint returns 200
- Pi-Hole DNS devices will bind to HOST_IP (192.168.31.190)

---

### v0.1.27 (2026-02-05)

**Bug Fix: Pi-Hole Restart Button Not Working**

**Summary:** Added container actions (start/stop/restart) to Pi-Hole control API.

**Root Cause:**
The Pi-Hole control API only accepted `enable` and `disable` actions. When the UI sent a `restart` action, it was rejected as invalid.

**Fix:**
Added container lifecycle actions using Incus REST API:
- `start` - Start the container
- `stop` - Stop the container  
- `restart` - Restart the container (force + stateful)

**Code Changes:**
- `src/app/api/apps/pihole/control/route.ts`:
  - Added `containerAction()` helper function using `incusRequest('PUT', '/1.0/instances/.../state', {...})`
  - Added start/stop/restart to allowed actions array
  - Fixed import: now imports from `@/lib/incus/server` instead of `@/lib/incus/client`

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.27 running (Next.js 16.1.4)
- All services operational

---

### v0.1.26 (2026-02-05)

**Major Feature: Pi-Hole Enhanced Authentication & Local DNS Management**

**Summary:** Added secure password management for Pi-Hole API, persistent storage support, and Local DNS record management (A/CNAME records).

**New Features:**

1. **Secure Password Management**
   - Passwords stored in systemd environment variables (same pattern as JWT_SECRET)
   - Never exposed in logs, URLs, or container configuration
   - Admin can change password from DNS Settings tab

2. **Local DNS Records**
   - Manage A/AAAA records (domain → IP)
   - Manage CNAME records (alias → target)
   - Full CRUD from Control Panel UI

3. **Persistent Storage**
   - Pi-Hole data persists across container restarts
   - Gravity database, custom DNS records, and settings are preserved

4. **Enhanced DNS Page**
   - New "Local DNS" tab for A/AAAA and CNAME record management
   - New "Settings" tab with password management and direct Pi-Hole access link

**New Files:**
- `src/lib/apps/secrets.ts` - Secure password storage using systemd env vars
- `src/app/api/apps/pihole/password/route.ts` - GET/POST password management
- `src/app/api/apps/pihole/dns-records/route.ts` - GET/POST/DELETE A records
- `src/app/api/apps/pihole/cname-records/route.ts` - GET/POST/DELETE CNAME records

**Modified Files:**
- `src/lib/apps/manifest.ts` - Updated PIHOLE_MANIFEST with port 53 and volumes
- `src/app/api/apps/pihole/stats/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/domains/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/queries/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/control/route.ts` - Use dynamic password from secrets
- `src/app/(dashboard)/dns/page.tsx` - Added Settings and Local DNS tabs
- `scripts/postbuild.js` - Resolve symlinks to fix Windows→Linux deployment

**Build Fix:**
The postbuild script now resolves all symlinks in node_modules/ to real files. This fixes the "Cannot find module 'next'" error when deploying from Windows builds.

**Testing:**
- Deployed to dev server 192.168.31.190
- Spine v0.1.12, Control Panel v0.1.26
- Pi-Hole running and accessible

---

### v0.1.25 (2026-02-05)

**Feature: DNS Tab with Pi-Hole UI**

**Summary:** Added dedicated DNS tab to sidebar for Pi-Hole management with quick install and full management UI.

**Changes:**
- Added DNS tab to sidebar navigation
- Added DNS page at `/dns` with Pi-Hole install/management
- Overview, Query Log, and Block Lists tabs

---

### v0.1.22 (2026-02-04)

**Major Feature: Multi-App Management Pages**

**Summary:** Added management UI for core infrastructure apps: PostgreSQL, Authentik, and Pi-Hole. Also fixed critical build issue with pnpm symlinks on Windows.

**New App Pages:**
- `/apps` - Overview page with container status cards for each app
- `/apps/postgres` - PostgreSQL management: stats, databases, users
- `/apps/authentik` - Authentik management: stats, user count
- `/apps/pihole` - Pi-Hole management: stats, queries, domains, enable/disable

**New API Routes:**
- `GET /api/apps/postgres/stats` - PostgreSQL server stats
- `GET /api/apps/postgres/databases` - List databases with sizes
- `GET /api/apps/postgres/users` - List database users
- `GET /api/apps/authentik/stats` - Authentik service stats
- `GET /api/apps/pihole/stats` - Pi-Hole DNS query stats
- `GET /api/apps/pihole/queries` - Recent DNS queries
- `GET /api/apps/pihole/domains` - Whitelisted/blacklisted domains
- `POST /api/apps/pihole/control` - Enable/disable Pi-Hole

**Build Fix: pnpm Symlinks on Windows**

**Root Cause:** Windows tar creates broken symlinks when building pnpm-managed projects. The pnpm `.pnpm/node_modules/` structure uses symlinks that point to Windows paths like `//?/C:/Users/...`. When extracted on Linux, these symlinks are broken and packages like `styled-jsx`, `sharp`, etc. are missing.

**Fix:** Added `scripts/postbuild.js` that:
1. Copies `.next/static/` and `public/` to standalone (existing behavior)
2. Copies all packages from `.pnpm/node_modules/` to top-level `node_modules/`
3. This ensures all dependencies are available as real files, not broken symlinks

**Code Changes:**

*New Files:*
- `src/app/(dashboard)/apps/page.tsx` - Apps overview
- `src/app/(dashboard)/apps/postgres/page.tsx` - PostgreSQL management
- `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik management
- `src/app/(dashboard)/apps/pihole/page.tsx` - Pi-Hole management
- `src/app/api/apps/postgres/stats/route.ts` - PostgreSQL stats API
- `src/app/api/apps/postgres/databases/route.ts` - PostgreSQL databases API
- `src/app/api/apps/postgres/users/route.ts` - PostgreSQL users API
- `src/app/api/apps/authentik/stats/route.ts` - Authentik stats API
- `src/app/api/apps/pihole/stats/route.ts` - Pi-Hole stats API
- `src/app/api/apps/pihole/queries/route.ts` - Pi-Hole queries API
- `src/app/api/apps/pihole/domains/route.ts` - Pi-Hole domains API
- `src/app/api/apps/pihole/control/route.ts` - Pi-Hole control API
- `src/lib/incus/container-ip.ts` - Container IP discovery utility
- `scripts/postbuild.js` - Build fix for pnpm symlinks

*Modified Files:*
- `package.json` - Updated postbuild script to use `node scripts/postbuild.js`
- `src/components/layout/sidebar.tsx` - Added "Apps" navigation link

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Login page loads correctly
- All services running: Spine v0.1.10, Control Panel v0.1.22

**Note:** This version deployed successfully after fixing TWO bugs in Spine v0.1.10:
1. Tar extraction path (--strip-components=1)
2. Health check network isolation (incus exec curl)

---

### v0.1.21 (2026-02-04)

**Bug Fix: Route Detection for Container Routing Table**

**Summary:** Fixed a bug where the Container Routing Table displayed incorrect route information after page refresh. The UI was showing auxiliary routes (like `/favicon.ico`) instead of the main configured route.

**Root Cause:**
When detecting the current route for a container, the API used `.find()` which returns the first matching route. Path routing creates multiple routes: main route, `/_next/*`, and `/favicon.ico`. Since auxiliary routes were added with `unshift()`, they appeared first in the array and were incorrectly displayed.

**Fix:**
- Added `AUXILIARY_ROUTE_PATHS` constant to filter out `/_next/*`, `/_next`, and `/favicon.ico`
- Updated route detection logic to skip auxiliary routes when finding the "main" route

**Code Changes:**
- `src/app/api/containers/route.ts`:
  - Added `AUXILIARY_ROUTE_PATHS` constant
  - Updated route detection to filter auxiliary routes for both system containers and app manifest containers

**Testing:**
- Deployed to dev server (192.168.31.190)
- Verified subdomain route `controlpanel.skibidi.wtf` is configured correctly
- Service running successfully

---

### v0.1.20 (2026-02-04)

**Feature: Path Routing Support for Next.js Apps**

**Summary:** Added support for path-based routing with Next.js apps by creating auxiliary routes for static assets.

**Note:** Path routing still has limitations with Next.js - redirects use absolute paths. Subdomain routing is recommended.

---

### v0.1.19 (2026-02-04)

**Major Feature: Unified Proxy Configuration UI**

**Summary:** Complete redesign of the Proxy page with a unified domain configuration and container routing table. Fixes path-based routing and adds volume mounts for Caddy config persistence.

**New Features:**
1. **Domain Configuration Card** - Single input for base domain with auto-TLS
2. **Container Routing Table** - Shows all YouEye containers with web UIs
3. **Route Type Selection** - Subdomain, path, or none options per container
4. **Path Pattern Normalization** - Automatically fixes `/control` → `/control/*`

**Bug Fixes:**
1. **Path Routes Not Working** - Caddy's `*` wildcard doesn't cross path separators. Fixed by normalizing path patterns to include trailing `/*`
2. **Config Not Persisting** - Added Incus volume mounts for Caddy's `/config` and `/data` directories (requires Caddy reinstall to activate)

**New API Endpoints:**
- `GET /api/containers` - Lists containers with web UIs available for routing
- `GET/POST /api/domain` - Get/set the base domain for routing
- `POST /api/containers/[name]/route` - Set container routing (subdomain/path/none)

**Code Changes:**

*New Files:*
- `src/app/api/containers/route.ts` - Container listing endpoint
- `src/app/api/containers/[name]/route/route.ts` - Route assignment endpoint
- `src/app/api/domain/route.ts` - Domain configuration endpoint
- `src/components/proxy/container-routing-table.tsx` - New routing table component
- `src/components/ui/select.tsx` - Radix Select component

*Modified Files:*
- `src/lib/caddy/client.ts`:
  - Added `normalizePathPattern()` - Ensures `/path/*` format
  - Updated `formDataToRoute()` and `addRoute()` to return warnings
  - Added `setContainerRoute()`, `getConfiguredDomain()`, `setDomain()`
- `src/lib/apps/manifest.ts`:
  - Added `volumes` to CADDY_MANIFEST for `/config` and `/data`
  - Added `webPort` field to all manifests
  - Updated `manifestToIncusConfig()` to handle volumes
- `src/types/apps.ts`:
  - Added `volumes` and `webPort` to AppManifest interface
- `src/app/api/apps/install/route.ts`:
  - Added `ensureHostDirectories()` for volume mount directories
- `src/app/(dashboard)/proxy/page.tsx`:
  - Removed old TLSCard/RouteList/RouteFormDialog
  - Added domain input card and ContainerRoutingTable
- `package.json`:
  - Added `@radix-ui/react-select` dependency
  - Version: 0.1.18 → 0.1.19

**Technical Details:**

*Path Pattern Normalization:*
```typescript
// Input: /control → Output: /control/*
function normalizePathPattern(pattern: string): { pattern: string; modified: boolean }
```
Caddy's `*` wildcard matches any characters BUT doesn't cross `/` separators.
- `/control*` matches `/controlABC` but NOT `/control/dashboard`
- `/control/*` matches `/control/dashboard`

*Container Route Assignment:*
```typescript
setContainerRoute(domain, containerName, port, routeType, routeValue)
// routeType: 'subdomain' | 'path' | 'none'
// Example path: domain=skibidi.wtf, routeValue=/control → skibidi.wtf/control/*
```

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- `/api/containers` returns containers with webPort correctly
- `/api/domain` returns configured domain (skibidi.wtf)
- Path route `/control` normalized to `/control/*` in Caddy config
- Route works: `curl -k https://skibidi.wtf/control/` returns 307 redirect
- Caddy includes rewrite handler to strip path prefix before forwarding

**Notes:**
- Volume mounts require Caddy reinstall to activate (existing Caddy won't have them)
- Host authentication uses Spine API's `/api/auth/verify` (PAM on host, not container)
- Default host root password: set via `chpasswd` on host

---

### v0.1.18 (2026-02-04)

**Bug Fix: Admin groups not passed to isAdmin check during login**

**Root Cause:** The login route was calling `getUserGroups(username)` which always returned `[]`, then calling `isAdmin(username)` without the groups. This meant only `root` users were recognized as admin, even though users like `youeye` are in the `sudo` group.

**Fix:** Use `authResult.groups` from PAM authentication result and pass to `isAdmin(username, groups)`.

**Code Changes:**
- `src/app/api/auth/login/route.ts` - Use groups from auth result, remove unused getUserGroups import

**Testing:**
- Deployed to dev server 192.168.31.190
- User `youeye` (in sudo group) should now be recognized as admin after re-login

**Note:** Users must log out and log back in to get a new session with the correct admin status.

---

### v0.1.17 (2026-02-04)

**Bug Fix: Static Files Missing in Standalone Build**

**Root Cause:** Next.js standalone output doesn't automatically copy `.next/static/` and `public/` folders. CSS/JS files were returning 404 or being served with `text/plain` MIME type, causing browsers to refuse loading them with strict MIME checking.

**Fix:** Added `postbuild` script to copy static files into standalone folder.

**Code Changes:**
- `package.json` - Added postbuild script: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`
- `package.json` - Build script now explicitly runs postbuild: `next build && pnpm run postbuild`
- Version bump: 0.1.16 → 0.1.17

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Verified CSS returns `Content-Type: text/css; charset=UTF-8`
- Verified JS returns `Content-Type: application/javascript; charset=UTF-8`  
- Verified fonts return `Content-Type: font/woff2`
- No MIME type errors in browser console

**Note for Windows builds:** The `cp` command doesn't work on Windows. Use PowerShell:
```powershell
Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static"
Copy-Item -Recurse -Force "public" ".next\standalone\public"
```

---

### v0.1.16 (2026-02-04)

**Changes:**
- Secured Caddy Admin API: removed external port 2019 exposure
- Added route ordering by specificity (sortRoutes function)
- Enhanced TLS automation for hostname handling
- Added request timeout (10s) and retry logic with exponential backoff
- Added route verification after config application
- Improved initial Caddy config generation
- Added comprehensive logging for Caddy operations

**Code Changes:**
- `src/lib/apps/manifest.ts` - Removed adminPort from CADDY_MANIFEST
- `src/lib/caddy/client.ts` - Major refactoring with timeout/retry, sorting, verification
- `package.json` - Version bump

**Testing:**
- Deployed to dev server 192.168.31.190
- Verified port 2019 NOT exposed externally (SECURE)
- Verified internal Caddy API access works
- HTTP/HTTPS ports working

---

## Architecture Notes

### Caddy Integration
- Control Panel communicates with Caddy via Incus DNS: `http://youeye-caddy.incus:2019`
- Admin API NOT exposed to host network (security requirement)
- Caddy configured to bind admin API to `0.0.0.0:2019` inside container
- Config persistence via `--resume` flag: auto-saves to `/config/caddy/autosave.json`, reloads on restart
- No `/config` volume mount — Caddy uses its internal container filesystem for XDG_CONFIG_HOME
- `/data` volume mounted for TLS certificate persistence across container recreation

### Key Files
- `src/lib/caddy/client.ts` - Caddy Admin API client
- `src/lib/caddy/types.ts` - TypeScript types for Caddy config
- `src/lib/apps/manifest.ts` - App manifests including Caddy
- `src/app/api/caddy/*` - API routes for Caddy management

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Playwright Testing](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Playwright-Testing)** — **MANDATORY** browser testing for all Control Panel changes
- **[Control Panel](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Control-Panel)** — Complete Control Panel documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning
## v0.2.13.4 — lisa — 2026-04-01
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Revision 2 — BUG-LISA-001 correct IPv6 fix: per-interface sysctl + platform-wide deployLXDContainer fix

### Changes
- `src/lib/native-apps/installer.ts` — installWeather(): removed ineffective NODE_OPTIONS=--dns-result-order=ipv4first (does NOT affect undici/fetch in Node.js v22); replaced sysctl block with per-interface disable for all, default, eth0, lo (the 'all' sysctl does NOT override per-interface=0); persisted to /etc/sysctl.d/99-disable-ipv6.conf instead of /etc/sysctl.conf
- `src/lib/infrastructure/lxd-deployer.ts` — deployLXDContainer(): added same IPv6 disable block after waitForContainerReady(), before addSocketProxies(). Platform-wide fix so ALL app containers (Weather, Wiki, Search, Notes, Cinema, Translate) automatically get IPv6 disabled on fresh installs
- `package.json` — version bumped 0.2.13.3 → 0.2.13.4

### Test Results
- Live container fix verified: `ip addr show eth0` → no inet6 address
- Node.js fetch (undici) geocode test: SUCCESS in 1391ms (pre-deploy), SUCCESS in 1559ms (post-deploy)
- `curl https://geocoding-api.open-meteo.com/v1/search?name=London` → 200 OK with results
- Spine status: 8 running, 0 stopped after update

### Notes for Iris
- NODE_OPTIONS=--dns-result-order=ipv4first was intentionally removed from the weather app env file — it has no effect on undici/fetch (Node.js v22 global fetch uses its own DNS resolver)
- The platform-wide lxd-deployer.ts fix means future app installs will not need per-app IPv6 workarounds
- BUG-LISA-001 is confirmed resolved by direct Node.js fetch test inside the container

## v0.2.13.3 — lisa — 2026-04-01
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix BUG-LISA-001 — Weather geocode API ETIMEDOUT (Node.js v22 happy-eyeballs IPv6)

### Changes
- `src/lib/native-apps/installer.ts` — installWeather() Step 5: added NODE_OPTIONS=--dns-result-order=ipv4first to env file (belt-and-suspenders); added sysctl commands to disable IPv6 on all interfaces in the container (/etc/sysctl.conf), making the fix persistent across container reboots
- `package.json` — version bumped 0.2.13.1 → 0.2.13.3 (revision cycle: .1 = initial, .2 = interim NODE_OPTIONS only, .3 = full sysctl + NODE_OPTIONS fix)

### Root Cause
Node.js v22 "happy eyeballs" (RFC 8305) opens IPv6 and IPv4 connections simultaneously. The Incus container has only a link-local IPv6 address (fe80::/64) with no global route. IPv6 TCP connections to external hosts time out (~30s) before failing. curl works because it falls back immediately when IPv6 gives ENETUNREACH; Node.js fetch() waits for the full TCP timeout. Disabling IPv6 via sysctl on the container's network interfaces forces IPv4-only, resolving the ETIMEDOUT.

### Test Results
- Playwright: 9 screenshots, all verified
- Location search for "London" returns results (geocode API returns 200, not 500 ETIMEDOUT)
- Location added successfully, showing 9°C weather data
- Screenshots: Tests/Lisa/20260401_2/

### Notes for Iris
- No schema migrations, no new deps
- The sysctl change is applied inside the Incus container only, not the host
- sysctl application is wrapped in try/catch — non-fatal if restricted (NODE_OPTIONS fallback still applies)

---

## v0.2.13.1 — lisa — 2026-04-01
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add YE-App-Weather installer support

### Changes
- `src/lib/native-apps/catalog.ts` — added ye-weather → ye-app-weather container mapping and YE-App-Weather repo mapping
- `src/lib/native-apps/installer.ts` — added full installWeather() function (8 steps: secrets, postgres, SSO, LXD deploy, env file, health check, Caddy route, metadata); added ye-weather to ssoSlugMap and PostgreSQL DROP for uninstaller
- `package.json` — version bumped 0.2.12 → 0.2.13.1

### Test Results
- Build: pnpm build succeeded
- Deploy: spine update control from lisa-v0.2.13.1 release succeeded
- Weather install: container deployed, health check passed, app running at weather.lisavm.test

### Notes for Iris
- Version bump 0.2.12 → 0.2.13.1 (lisa cycle increment)

---

## v0.2.9.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 5 QA bugs from v0.2.9 (BUG-021 through BUG-025)

### Changes
- `src/app/setup/page.tsx` — BUG-021: Detect ye-setup-language cookie on page load to skip past language selection after reload; avoids infinite language step loop
- `src/app/api/setup/language/route.ts` — BUG-021: Set cookie httpOnly=false so client JS can detect it
- `src/lib/caddy/client.ts` — BUG-022: New ensurePingRoute() adds /api/ping at route position 0 (before host-matched routes) so Spine health checks work on any domain
- `src/app/api/setup/run/route.ts` — BUG-022: Call ensurePingRoute during setup wizard Caddy step
- `src/lib/infrastructure/deployer.ts` — BUG-022: Call ensurePingRoute in both deploy and reconcile paths (including when Caddy is already running)
- `src/lib/native-apps/installer.ts` — BUG-023: Add trailing newline to all env file writes (wiki, search, notes) to prevent line concatenation
- `src/lib/health/service.ts` — BUG-024: Add 1-retry with 1s delay to Authentik, Caddy, and Spine health checks to reduce transient false positives
- `src/lib/market/installed-apps.ts` — BUG-025: Replace 'su - postgres -c "psql..."' with 'psql -U youeye' directly (BusyBox su incompatibility)
- `package.json` — version bump to 0.2.9.1

### Test Results
- Build: successful standalone tarball (242MB)
- BUG-022: curl -sk https://johnvm.test/api/ping returns {"status":"ok"}
- BUG-025: installed_apps table exists (verified via psql -U youeye)
- All 7 containers RUNNING

### Notes for Iris
- BUG-022 fix adds a Caddy route at position 0 without host matcher; this is intentional to override host-matched routes for /api/ping
- BUG-025 fix uses psql -U youeye instead of su postgres; all future psql calls should use this pattern for BusyBox compatibility
- BUG-023 fix adds trailing newline to ALL native app env writes; existing malformed env files will be fixed on next app reinstall

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Search engine detection in installer + catalog cache resilience + dynamic native app discovery

### Changes
- `src/lib/native-apps/installer.ts` — detectSearchEngine() checks installed_apps DB + install.json metadata; installSearch() writes SEARCH_ENGINE_TYPE + SEARCH_ENGINE_URL env vars; step count increased from 7 to 8
- `src/lib/market/catalog.ts` — catalog cache persistence at /var/lib/youeye/catalog-cache.json; fetchCatalog() saves to disk on success, loads from cache on failure; getNativeApps() filters catalog by type: native; getCatalogCacheAge() for UI display; refreshCatalog() for manual refresh
- `src/lib/market/schema.ts` — CatalogEntrySchema extended with optional type field (native | marketplace)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- catalog.yaml now has type: native entries for wiki and search — CatalogEntrySchema accepts optional type with default 'marketplace'
- /var/lib/youeye/catalog-cache.json is created at runtime — no migration needed

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Improved setup wizard + language propagation + install from URL

### Changes
- `src/app/setup/page.tsx` — Complete rewrite: language selection as Step 0 (5 languages with flags), step progress indicator ("Step N of M" with stepper), smooth fade/slide transitions (200ms), contextual help expandable per step, mobile-friendly layout
- `src/app/setup-complete/page.tsx` — Confetti animation on completion, personalized welcome message, quick start links (dashboard, marketplace, docs)
- `src/app/api/setup/language/route.ts` — New endpoint: stores setup language in cookie for pre-setup i18n resolution
- `src/i18n/request.ts` — Added ye-setup-language cookie resolution before system/user language
- `src/lib/language/service.ts` — New LanguageService: propagateLanguageToAll() cascades to Authentik locale, app container env vars via Incus API
- `src/app/api/ui-bridge/user/language/route.ts` — New bridge endpoint: PATCH triggers full language propagation pipeline
- `src/app/api/market/validate-url/route.ts` — New endpoint: SSRF-safe manifest URL validation (HTTPS only, blocks RFC1918 IPs)
- `src/app/api/market/install-url/route.ts` — New endpoint: SSE install from URL with audit logging
- `src/components/market/install-from-url-dialog.tsx` — New dialog: URL input, manifest preview with capabilities, subdomain config, SSE install progress
- `src/app/(dashboard)/market/page.tsx` — Added "Install from URL" button in marketplace header
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSource() for URL source tracking (source + source_url columns)
- `messages/*.json` — New i18n keys for setup wizard (stepOf, help texts) and setup-complete (welcomeUser, quickStart) in all 5 locales

### Test Results
- Build: Both YE-ControlPanel and YE-UI build successfully
- Deploy: lisavm running v0.2.8.1, 7 containers running, 0 stopped

### Notes for Iris
- New DB columns: installed_apps.source (TEXT) and installed_apps.source_url (TEXT) — added via ALTER TABLE IF NOT EXISTS, safe for existing data
- New i18n keys in all 5 locale files — merge carefully if other agents added keys in the same section
- YE-UI has a new PATCH handler in admin proxy catch-all — needed for language propagation bridge calls
## v0.2.7.1 — john — 2026-03-30 (bugfix update)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 4 bugs from Cycle 2 testing (BUG-016, BUG-017, BUG-018, BUG-019)

### Changes
- `src/middleware.ts` — BUG-016: When setup is complete and accessed via IP+Caddy, let request through instead of redirecting to /setup-complete interstitial. BUG-017: Added /api/ping to PUBLIC_ROUTES.
- `src/app/api/ping/route.ts` — BUG-017: New unauthenticated health-check endpoint for Spine post-update verification. Returns `{"status":"ok"}`.
- `messages/en.json`, `ru.json`, `de.json`, `es.json`, `fr.json` — BUG-018: Added missing i18n keys `market.builtForYouEye` and `market.orphanScanPrompt` to all 5 locale files.
- `src/lib/health/service.ts` — BUG-019: Pi-Hole health check switched from HTTP API (returns 401 in v6) to exec-based `pihole status`. PostgreSQL check switched from `su - postgres` (fails with BusyBox) to `pg_isready`. Restructured health dispatch for clarity.

### Test Results
- /api/ping returns 200 without auth (verified via curl through Caddy)
- pihole status and pg_isready both work inside containers
- CP starts and runs correctly after deploy

### Notes for Iris
- /api/ping is a new public route — no auth required, by design
- Health check for Pi-Hole now uses exec-based approach (container name, not IP)
- Health check for PostgreSQL uses pg_isready instead of psql via su
- Caddy health check unchanged (was already working correctly)

## v0.2.7.1 — john — 2026-03-30
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cycle 2 polish fixes + LXD update path mismatch (BUG-012)

### Changes
- `src/lib/health/service.ts` — CPU delta-sampling: in-memory map tracks cumulative nanoseconds, computes real CPU % between polls. Spine returns cpuPercent: -2 (N/A). First poll returns -1 (no baseline).
- `src/app/(dashboard)/health/page.tsx` — Added CPU % display with Cpu icon alongside memory bar. Shows N/A for Spine, dash for first poll.
- `src/app/api/market/route.ts` — New: GET /api/market convenience route (re-exports catalog handler)
- `src/lib/native-apps/installer.ts` — installSearch() now calls saveInstallMetadata() (was missing). Uninstaller now removes Authentik OAuth2 for search. Both installers detect previous keepData installs.
- `src/lib/apps/lxd-updater.ts` — Added getServiceWorkingDir() helper using systemctl show. updateLXDApp() resolves real WorkingDirectory from systemd before file operations. Emits SSE note when paths differ (BUG-012 fix).
- `src/lib/apps/lxd-updates.ts` — getLxdAppVersion() fallback now uses systemctl show instead of grep for consistency with lxd-updater.
- `package.json` — Version bump to 0.2.7.1

### Test Results
- Playwright: 4 screenshots, 2 tests passed
- Screenshots: Tests/John/20260330_1/

### Notes for Iris
- Health dashboard cpuPercent field added to ServiceHealth interface — frontend and API both updated
- LXD updater path resolution is backward-compatible: if systemctl show fails, falls back to configured appDir
- installSearch() metadata fix ensures uninstall works correctly for search app

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — CP orchestrator, SSE progress, backup page, manifest backup schema

### Changes
- `src/lib/backup/types.ts` — backup types: config, events, manifest backup section, app backup plan
- `src/lib/backup/service.ts` — backup orchestrator: enumerate targets, dump PostgreSQL, call Spine, poll status
- `src/app/api/backup/run/route.ts` — SSE endpoint for triggering and streaming backup progress
- `src/app/api/backup/status/route.ts` — polls Spine for current backup status
- `src/app/(dashboard)/backup/page.tsx` — backup configuration and progress UI page
- `src/lib/spine/client.ts` — startBackup() and getBackupStatus() methods
- `src/lib/market/schema.ts` — BackupSchema: stopOrder, startOrder, ownPostgres, volumes, exclude
- `src/lib/market/types.ts` — BackupSpec type export
- `src/components/layout/sidebar.tsx` — added Backup navigation item
- `messages/{en,ru,fr,es,de}.json` — i18n for Backup sidebar label
- `package.json` — version bump to 0.2.7.1

### Test Results
- CP backup status endpoint responds correctly (requires auth)
- Full backup pipeline tested via Spine API: archive created, encrypted, decryptable
- Platform healthy after deploy: 7 running, 0 stopped

### Notes for Iris
- New lib/backup/ directory with service and types
- New API routes: /api/backup/run (SSE), /api/backup/status
- New page: /backup in dashboard sidebar
- Manifest schema extended with optional backup: section
- No database migrations needed

## v0.2.7.1 — ben — 2026-03-30
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** App version pinning + system health notifications

### Changes
- `src/lib/market/installed-apps.ts` — New installed_apps PostgreSQL table: CRUD, migration from install.json, update detection via version comparison
- `src/lib/market/version-checker.ts` — Background job (6h cycle): compare installed vs catalog versions, track update availability
- `src/lib/market/schema.ts` — Added `version` field to AppManifestSchema, `latestVersion` to CatalogEntrySchema
- `src/lib/market/types.ts` — Added `version` to MarketApp, `installedVersion` to InstallMetadata
- `src/lib/market/catalog.ts` — Include `version` in manifestToMarketApp conversion
- `src/lib/market/engine.ts` — Save installedVersion to both install.json and installed_apps DB on install
- `src/lib/market/uninstaller.ts` — Remove from installed_apps DB on uninstall
- `src/lib/health/monitor.ts` — Background health monitor (60s cycle): service state transitions, disk/memory/cert/update alerts
- `src/lib/health/notification-bridge.ts` — CP-to-UI notification delivery via bridge token auth
- `src/lib/health/index.ts` — Exported monitor and bridge modules
- `src/app/api/ui-bridge/notifications/route.ts` — New POST endpoint for creating notifications in YE-UI
- `src/app/api/ui-bridge/market/route.ts` — Added updates, installed-versions, refresh-catalog actions with version data
- `src/app/api/health/services/route.ts` — Side-effect imports to start monitor and version checker
- `package.json` — Bumped to 0.2.7.1

### Test Results
- Build: TypeScript compilation passes
- Screenshots: Tests/Ben/20260330_1/

### Notes for Iris
- New `installed_apps` PostgreSQL table is auto-created on first use (no manual migration needed)
- install.json files are migrated to DB on first boot — keep both during transition
- Health monitor sends notifications to all admin users via bridge token
- YE-UI notification POST route now accepts bridge token auth (not just session cookies)
- Version checker runs 45s after startup (after update-cache at 30s)

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** SMTP email configuration + user avatar bridge endpoint

### Changes
- `src/app/(dashboard)/settings/page.tsx` — SMTP settings card: host, port, username, password, from, TLS toggle, test button, status display
- `src/app/api/settings/smtp/route.ts` — GET/POST SMTP config (non-sensitive fields via SettingsService, password to secrets file)
- `src/app/api/settings/smtp/test/route.ts` — POST send test email via configured SMTP to admin address
- `src/app/api/ui-bridge/user/avatar/route.ts` — Bridge endpoint: receive multipart avatar from YE-UI, sync to Authentik via set_avatar API
- `src/lib/settings/service.ts` — Extended PlatformSettings with smtpHost, smtpPort, smtpFrom, smtpUsername, smtpRequireTls; KEY_MAP/REVERSE_KEY_MAP updated
- `src/lib/smtp/authentik-sync.ts` — Patch Authentik email stage and brand with SMTP credentials after save
- `src/lib/smtp/mailer.ts` — nodemailer wrapper for test email sending
- `src/lib/smtp/secrets.ts` — Read/write SMTP password to /var/lib/youeye/control/.secret_smtp_password (0600)
- `src/lib/market/variables.ts` — Added smtp.* namespace: host, port, username, password, from, tls, configured
- `src/lib/market/engine.ts` — Inject smtp.* vars for apps with capabilities.smtp: true
- `src/lib/market/types.ts` — Added smtp capability to CapabilitiesSchema
- `messages/{en,ru,de,es,fr}.json` — SMTP i18n keys
- `package.json` — bumped to 0.2.6.1

### Test Results
- Playwright: 5 tests, 5 passed — CP landing loads, CP settings has SMTP section, UI SSO login, UI profile avatar section, Avatar API endpoint
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- SMTP password stored at /var/lib/youeye/control/.secret_smtp_password — ensure volume persists across CP updates
- Avatar bridge uses multipart/form-data — Authentik set_avatar API receives the file directly
- smtp.* namespace resolves empty strings when SMTP not configured — apps install fine without it

---

---

 HEAD

## v0.2.6.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Unified app market + app lifecycle management

### Changes
- `src/lib/market/schema.ts` — Add `type` field (native/marketplace), `NativeConfigSchema`, make `containers` optional for native apps, add `native` category to metadata
- `src/lib/market/types.ts` — Add `type` to `MarketApp`, add `UninstallOptions`, `UninstallVerification`, `OrphanResource` types, add `NativeConfig` type
- `src/lib/market/catalog.ts` — Include `type` in `manifestToMarketApp()` conversion
- `src/lib/market/authentik.ts` — Export `getAuthentikConfig()` and `authentikAPI()` for orphan detector
- `src/lib/market/uninstaller.ts` — Complete rewrite: unified for marketplace + native, Pi-Hole DNS cleanup, keepData option, post-uninstall verification
- `src/lib/market/orphan-detector.ts` — New: detect orphaned Caddy routes, Authentik apps, PostgreSQL DBs, containers, volume dirs
- `src/lib/native-apps/catalog.ts` — Remove hardcoded `NATIVE_APP_CATALOG`, keep only utility functions (`nativeContainerName`, `nativeGiteaRepo`)
- `src/lib/native-apps/installer.ts` — Save `InstallMetadata` after wiki install for unified tracking
- `src/app/api/market/install/route.ts` — Unified: routes to native installer for `type: native`
- `src/app/api/market/uninstall/route.ts` — Accept `keepData` param, use options object
- `src/app/api/market/status/route.ts` — Include native app containers in status (pre-migration support)
- `src/app/api/market/catalog/route.ts` — Comment update (unified)
- `src/app/api/admin/orphans/route.ts` — New: GET detects orphans, POST cleans up
- `src/app/api/ui-bridge/market/route.ts` — Fix uninstaller call signature
- `src/app/(dashboard)/market/page.tsx` — Unified: single app grid, "Built for YouEye" section, orphan section, uninstall dialog
- `src/components/market/app-card.tsx` — Add "YouEye" badge for native apps, add BellRing/Shield icons
- `src/components/market/uninstall-dialog.tsx` — New: keep-data/delete-all confirmation dialog
- `src/components/market/orphan-section.tsx` — New: orphan scan + cleanup UI
- `src/app/api/market/native/` — **Deleted** (3 route files): functionality moved to unified routes
- `package.json` — Bump to 0.2.6.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/Ben/20260329_3/
- /api/market/catalog returns 9 apps (2 native + 7 marketplace)
- /api/market/native correctly returns 404
- /api/admin/orphans detected 3 orphans from previous installs
- Unified market page renders with "Built for YouEye" section

### Notes for Iris
- `/api/market/native/*` routes removed — any UI or bridge code referencing these needs updating
- `uninstallApp()` signature changed from `(appId, boolean)` to `(appId, options)` — already fixed in ui-bridge
- Native app IDs in manifests are `wiki`/`search` (not `ye-wiki`/`ye-search`) — native installer maps them internally
- AppMarket repo needs the matching `ben` branch merged for manifests to be available on `dev`/`main`

---

 HEAD
## v0.2.6.1 — john — 2026-03-29 (resume: Playwright tests)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Setup wizard hardening — Playwright test suite (resume session)

### Changes
- No new code changes — test files only (stored locally in Tests/John/20260329_2/)

### Test Results
- `setup-wizard-partial-resume.spec.ts` — PASS (State A: setup completed in background, Go link visible, resume correctly reflected)
- `setup-wizard-double-run.spec.ts` — PASS (Run 1 completed with DNS retry failure visible + Retry button; Run 2 redirected to /setup-complete without errors)
- `cycle0-full.spec.ts` — PASS (SSO login, theme switching, API v1 paths, settings page, login error page)
- Total screenshots: 36 across all 3 test sessions
- Videos: recorded for each test run (test-results/)
- BUG-011 verified RESOLVED — no duplicate Authentik providers on re-run, DNS failure visible (not silent)
- Screenshots: Tests/John/20260329_2/

### Notes for Iris
- No new build needed — code unchanged from previous session (john-v0.2.6.1)
- Setup wizard hardening fully tested and verified

---

## v0.2.6.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Search native installer to Control Panel

### Changes
- `src/lib/native-apps/installer.ts` — Added `installSearch()` (7-step: secrets, Authentik OAuth2, LXD deploy, env file, health check, Caddy route, done); updated `installNativeApp()` dispatcher to route `ye-search` appId
- `src/lib/native-apps/catalog.ts` — Set `supportsSSO: true` for ye-search (was false)
- `package.json` — bumped to 0.2.6.1

### Test Results
- YE-App-Search installed successfully on mikevm.test via CP marketplace
- 7-scenario Playwright test suite passed for Search app (see YE-App-Search AGENTS.md)
- Screenshots: Tests/Mike/20260329_2/

### Notes for Iris
- installSearch() follows same pattern as installWiki() — Authentik OAuth2 client creation, LXD container deploy, env file, Caddy route
- Whoogle must be installed first (container: app-whoogle.incus) — Search connects to it via WHOOGLE_URL env var
- WHOOGLE_URL default in Search app code is `http://app-whoogle-main.incus:5000` but installer sets correct container name

---

## v0.2.6.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Platform Health Dashboard + Setup Wizard Hardening (BUG-011)

### Changes
- `src/lib/health/service.ts` — Health check service querying 5 services via Incus state + per-service endpoints
- `src/lib/health/index.ts` — Health module exports
- `src/app/api/health/services/route.ts` — GET /api/health/services endpoint
- `src/app/api/health/services/[slug]/restart/route.ts` — POST restart endpoint per service
- `src/app/(dashboard)/health/page.tsx` — Health dashboard page with service cards, status badges, memory bars
- `src/app/(dashboard)/page.tsx` — Added compact health dots row + degraded service banner
- `src/components/layout/sidebar.tsx` — Added Health link with HeartPulse icon
- `src/app/api/setup/run/route.ts` — Full idempotency rewrite: check-before-create, 3-retry DNS, per-step persistence
- `src/app/api/setup/steps/route.ts` — GET/DELETE setup step state API for resume/retry
- `src/app/setup/page.tsx` — Added retry button per failed step, connectivity indicators, resume support
- `messages/{en,ru,de,es,fr}.json` — Added health + sidebar i18n keys
- `package.json` — Version bump to 0.2.6.1

### Test Results
- Playwright: health page renders with all 5 service cards, dashboard health dots visible
- Screenshots: Tests/John/20260329_1/screenshots/

### Notes for Iris
- New health page at /dashboard/health — no migrations needed
- Setup wizard hardening (BUG-011): setup_steps field added to youeye.yaml — backward compatible
- Merge before any other CP changes — contains setup wizard rewrite

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Update native app YOUEYE_API_URL to /api/v1 path

### Changes
- `src/lib/native-apps/installer.ts` — YOUEYE_API_URL env var now includes /v1 suffix
- `package.json` — bumped to 0.2.5.1

### Test Results
- Tested as part of YE-UI deployment — CP updated to 0.2.5.1 successfully

### Notes for Iris
- Merge with YE-UI (john first). Native apps installed after this change will get the correct v1 URL.

---
## v0.2.5.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Authentik named server ID + notification infrastructure (ntfy + capabilities)

### Changes
- `src/app/setup/page.tsx` — Add "Identity Provider Name" field to setup wizard Step 0 with auto-default "${siteName} ID"
- `src/app/api/setup/run/route.ts` — Store authentik_name in config, set Authentik brand title, rename UI OAuth2 from "${siteName} UI" to "${siteName}"
- `src/app/(dashboard)/settings/page.tsx` — Add Identity Provider settings card for post-setup renaming
- `src/app/api/settings/identity-provider/route.ts` — New API: update authentik_name in config + Authentik brand title
- `src/app/api/setup/reconfigure/route.ts` — Accept authentik_name in reconfigure flow
- `src/lib/reconfigure/index.ts` — Add authentik_name to ReconfigureRequest and patchConfig
- `src/lib/market/types.ts` — Extend VariableContext with authentik.name and ntfy namespace, add Capabilities type
- `src/lib/market/variables.ts` — Add ntfy and authentik.name to variable resolver
- `src/lib/market/schema.ts` — Add CapabilitiesSchema and "system" category to metadata
- `src/lib/market/engine.ts` — Populate authentik.name from config, populate ntfy context for apps with push capability
- `messages/{en,de,es,fr,ru}.json` — i18n keys for authentikName, identityProvider

### Test Results
- Build: pnpm build passes, standalone.tar created (236MB)
- Playwright: 5/5 tests pass (CP landing, config API, SSO login + settings navigation, ntfy manifest, Memos capabilities)
- Screenshots: Tests/Lisa/20260329_1/ (10 screenshots including settings page with Identity Provider section)
- Identity Provider section confirmed visible at `control.lisavm.test/settings` with "YouEye ID" default value

### Notes for Iris
- Merge Lisa AFTER Mike if Mike modifies SettingsService — Lisa uses direct spineClient.patchConfig
- New "system" category in metadata schema — existing apps use search/social/productivity/media
- CapabilitiesSchema is optional and backward-compatible — existing manifests pass without it
- authentik_name field in youeye.yaml is new — Spine will store it transparently via patchConfig
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Settings Service Foundation + User Identity Foundation (setup wizard names)

### Changes
- `src/lib/settings/service.ts` — New SettingsService class with typed getAll/get/set/getRaw/setRaw/invalidate + 5s cache
- `src/lib/settings/index.ts` — Re-export barrel
- `src/app/api/settings/route.ts` — New admin-only GET/PATCH endpoint for typed platform settings
- `src/lib/site-config.ts` — Migrated from spineClient.getConfig() to settingsService.getRaw()
- `src/lib/reconfigure/index.ts` — 3 getConfig + 1 patchConfig migrated to settingsService
- `src/app/api/ui-bridge/config/route.ts` — Migrated GET/PATCH to settingsService
- `src/app/api/ui-bridge/language/route.ts` — Migrated to settingsService
- `src/app/api/setup/config/route.ts` — Migrated to settingsService
- `src/app/api/setup/run/route.ts` — Migrated patchConfig + added firstName/lastName to admin creation
- `src/app/api/domain/route.ts` — Migrated to settingsService
- `src/lib/market/catalog.ts` — Migrated to settingsService
- `src/lib/infrastructure/lxd-deployer.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updater.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updates.ts` — Migrated to settingsService
- `src/app/setup/page.tsx` — Added firstName/lastName fields to setup wizard Step 1
- `messages/*.json` — Added firstName/lastName i18n keys (all 5 languages)

### Test Results
- Playwright: 4 tests, all passed
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- CP dashboard, settings API, UI SSO login, profile settings page all verified

### Notes for Iris
- spineClient.getConfig/patchConfig still exist as transport — DO NOT remove
- New /api/settings endpoint is admin-only (getSession check)
- Setup wizard now sends admin_first_name/admin_last_name in POST body
- Merge Mike AFTER John if John adds /api/v1/ routes

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `src/lib/apps/lxd-updates.ts` — `getLxdAppLatestVersion()` now compares branch winner vs main winner and returns whichever is newer
- `src/lib/apps/lxd-updater.ts` — `getLatestRelease()` same fix: compare both, pick newer
- `src/lib/infrastructure/lxd-deployer.ts` — Python download script in `installNodeAndApp()` rewritten to collect all releases, find highest branch and main, compare, use winner
- `package.json` — bumped version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed (login + dashboard, settings page), 1 failed (selector for Updates link — not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after CP update

### Notes for Iris
- This fix changes release resolution in CP for UI, Wiki, and Search deployments/updates. Same behavior change as Spine fix: stale branch tags no longer preferred over newer main releases.
- Paired fix in YE-Spine (same logic, `internal/releases/releases.go`)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status and inline progress

### Changes
- `src/lib/updates/state.ts` — New: PostgreSQL-backed update status manager (create table, upsert, read, unified aggregation from Spine + DB)
- `src/app/api/updates/status/route.ts` — New: GET endpoint returning unified update statuses
- `src/app/api/updates/[component]/route.ts` — Added status tracking (startUpdate/completeUpdate/failUpdate) around all update triggers
- `src/app/api/ui-bridge/updates/status/route.ts` — New: bridge endpoint for UI to read statuses
- `src/app/api/ui-bridge/updates/[component]/route.ts` — New: bridge endpoint for UI to trigger updates
- `src/app/api/ui-bridge/updates/clear/route.ts` — New: bridge endpoint to clear completed/failed statuses
- `src/app/(dashboard)/updates/page.tsx` — Rewritten: Updates Available section at top, inline progress per component, confirmation for self-destructive updates, auto-refresh on completion
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/spine/client.ts` — Added getUpdateStatus() and updateUI() methods, removed duplicate updateUI
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: CP updates page shows all components with versions
- Playwright: 8 tests, all pass (CP updates page screenshot verified)

### Notes for Iris
- New `update_status` table created automatically on first access (CREATE TABLE IF NOT EXISTS)
- Bridge endpoints follow existing `/api/ui-bridge/*` pattern — no auth changes needed
- Duplicate `updateUI()` method was removed from spine client (was causing TS build failure)

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/i18n/request.ts` — Per-user language resolution via YE-UI bridge endpoint (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — Accepts userId param, uses bridge token instead of cookie forwarding
- `src/app/api/ui-bridge/config/route.ts` — Added PATCH handler for language updates from YE-UI admin
- `src/components/settings/language-card.tsx` — NEW: System language settings card for CP settings page
- `src/app/(dashboard)/settings/page.tsx` — Renders LanguageCard component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- System language card verified: English → Spanish → English

### Notes for Iris
- CP now calls YE-UI bridge at `http://youeye-ui.incus:3000/api/ui-bridge/user-language`
- CP PAM sessions get system default only (no Authentik sub available)
- Bridge token auth (existing pattern, no new security surface)
- No new dependencies added

## v0.2.4 — iris — 2026-03-25
**Branch:** dev → main
**VM:** irisvm.test (204), irisclean.test (205), irisupdate.test (206)
**Agent:** Iris
**Task:** Promote native apps market + i18n to main

### Changes
- `src/lib/native-apps/catalog.ts` — Native app catalog (Wiki, Search) with container names and Gitea repo mappings
- `src/lib/native-apps/installer.ts` — 7-step wiki installer: secrets → Authentik OAuth2 → LXD container → env config → health check → Caddy route
- `src/app/api/market/native/route.ts` — GET /api/market/native — returns native apps with live status
- `src/app/api/market/native/install/route.ts` — POST /api/market/native/install — SSE stream install progress
- `src/app/api/market/native/uninstall/route.ts` — POST /api/market/native/uninstall
- `src/app/(dashboard)/market/page.tsx` — Native Apps section in App Market UI
- `src/lib/market/authentik.ts` — Fixed implicit-consent flow selection for OAuth2 providers
- `messages/*.json` — Added nativeApps i18n key in all 5 locales

### Test Results
- IrisVM: 9/9 Playwright tests pass
- IrisUpdate: 6/6 tests pass (CP upgrade v0.2.3→v0.2.3.1 preserved wiki + SSO)
- IrisClean: 2/3 tests pass (test 1 N/A — setup wizard already done on this VM)
- Wiki SSO, health check, App Market install flow all verified

### Notes for Next Agents
- Native app install is idempotent (LXD container deploy skips if exists)
- Authentik implicit-consent flow preferred by slug — no more consent screen
- Wiki Gitea releases must exist at git.byka.wtf/potemsla/YE-App-Wiki before install

## v0.2.2.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** i18n string extraction — convert remaining CP components to useTranslations()

### Changes
- `src/app/(dashboard)/dns/page.tsx` — Converted to useTranslations('dns') with full DNS management strings
- `src/app/setup/page.tsx` — Converted to useTranslations('setup') with all setup wizard strings
- `src/app/setup-complete/page.tsx` — Converted to useTranslations('setupComplete') with cert/completion strings
- `src/app/(dashboard)/apps/authentik/page.tsx` — Converted to useTranslations('authentik') with user/group management
- `src/app/(dashboard)/apps/pihole/page.tsx` — Converted to useTranslations('pihole') with Pi-Hole management
- `src/app/(dashboard)/apps/postgres/page.tsx` — Converted to useTranslations('postgres') with database management
- `src/app/(dashboard)/apps/[id]/page.tsx` — Converted to useTranslations('appDetail') with app detail/update strings
- `src/app/(dashboard)/apps-legacy/page.tsx` — Converted to useTranslations('appsLegacy')
- `src/components/proxy/container-routing-table.tsx` — Converted to useTranslations('containerRouting')
- `src/components/proxy/proxy-status-card.tsx` — Converted to useTranslations('proxyStatus')
- `src/components/proxy/route-form-dialog.tsx` — Converted to useTranslations('routeForm')
- `src/components/proxy/route-list.tsx` — Converted to useTranslations('routeList')
- `src/components/proxy/tls-card.tsx` — Converted to useTranslations('tlsCard')
- `src/components/containers/container-card.tsx` — Converted to useTranslations('containers')
- `messages/en.json` — Added 13 new translation sections (setup, setupComplete, dns expanded, authentik, pihole, postgres, appDetail, appsLegacy, proxyStatus, routeForm, routeList, containerRouting, tlsCard)
- `messages/ru.json` — Full Russian translations for all new sections
- `messages/es.json` — Full Spanish translations for all new sections
- `messages/de.json` — Full German translations for all new sections
- `messages/fr.json` — Full French translations for all new sections

### Test Results
- Build: pnpm build passes successfully
- 29 total files now use useTranslations (14 new + 15 existing)

### Notes for Iris
- All 5 message files (en, ru, es, de, fr) updated in parallel
- No breaking changes — all strings were hardcoded before, now use t() functions
- stats-card.tsx skipped — receives title as prop (no hardcoded strings)

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — config-writer language, i18n docs, string extraction expansion

### Changes
- `src/lib/market/config-writer.ts` — Added readLanguageConfig() and applyLanguageToContainers() for manifest language support
- `src/lib/market/engine.ts` — Refactored to use config-writer language functions instead of inline logic
- `src/app/(dashboard)/people/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/updates/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/proxy/page.tsx` — Converted to useTranslations
- `src/components/market/app-card.tsx` — Converted to useTranslations
- `src/components/market/install-dialog.tsx` — Converted to useTranslations
- `src/components/market/install-progress.tsx` — Converted to useTranslations
- `messages/*.json` — Updated all 5 language files with new keys for people, proxy, updates, market

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- CP now at 15/42 files with useTranslations (up from 9)
- Config-writer now exports reusable language functions

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction, config-writer language support, BUG-003 fix

### Changes
- `src/components/layout/header.tsx` — Add useTranslations for logout button
- `src/app/(dashboard)/page.tsx` — Convert dashboard stats to use translation keys
- `src/components/dashboard/system-info.tsx` — Use t() for system info labels
- `src/components/containers/container-list.tsx` — Translate container list strings
- `src/app/login/page.tsx` — Convert login page to use useTranslations
- `src/app/(dashboard)/market/page.tsx` — Translate market page strings
- `src/app/(dashboard)/apps/page.tsx` — Translate apps page strings
- `src/app/(dashboard)/settings/page.tsx` — Add useTranslations to settings and release channel
- `src/lib/market/schema.ts` — Add LanguageConfigSchema for manifest language fields
- `src/lib/market/engine.ts` — Read language config from manifest, inject env vars during install
- `src/lib/reconfigure/index.ts` — Add language propagation to marketplace apps
- `src/app/api/setup/config/route.ts` — BUG-003: change setConfig to patchConfig
- `messages/*.json` — Comprehensive keys for header, apps, dns, people, login across all 5 languages

### Test Results
- Build pending

### Notes for Iris
- BUG-003 fix: PUT /api/setup/config now uses patchConfig to preserve other fields
- Language schema added to market manifests (optional, backward compatible)
- Reconfigure flow now propagates language to marketplace apps

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin for i18n support
- `src/app/layout.tsx` — Add NextIntlClientProvider with server-side locale resolution
- `src/i18n/config.ts` — Locale configuration (en, ru, es, de, fr)
- `src/i18n/request.ts` — Server-side language resolution from youeye.yaml via Spine API (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — New bridge endpoint for native apps to fetch resolved language
- `src/components/layout/sidebar.tsx` — Convert hardcoded labels to useTranslations()
- `messages/en.json` — English translations (dashboard, settings, sidebar, login, market, proxy, containers)
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors

### Notes for Iris
- New dependency: next-intl 4.8.3
- Bridge endpoint `/api/ui-bridge/language` added — calls YE-UI `/api/user/language` for per-user resolution
- Uses patchConfig for all youeye.yaml writes (BUG-003 safe)
- Setup wizard still runs in English (no i18n applied)
- Not all components converted to useTranslations() yet — sidebar done as proof of pattern, rest can follow

---

# YouEye Control Panel - Agent Documentation

## Version History (Recent)

## v0.2.3.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — CP side (BUG-004 fix)

### Changes
- `src/lib/market/authentik.ts` — Added `implicitConsent` param to `createAuthentikOAuth2App()`, sets `policy_engine_mode: 'any'` to skip consent screen
- `src/lib/market/engine.ts` — Passes `implicitConsent: true` for all market app installations
- `package.json` — Bumped version to 0.2.3.1

### Test Results
- Build: successful (pnpm build passes)

### Notes for Iris
- BUG-004 fix: implicit consent avoids the explicit consent screen on first SSO login for market apps
- All market apps now use implicit consent by default (policy_engine_mode: 'any')

## v0.1.106.5 — john — 2026-03-23
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix HTTPS IP-based setup flow (TLS + redirect)

### Changes
- `src/lib/infrastructure/deployer.ts` — Changed Caddyfile template from `tls internal` to `tls { on_demand }` with `on_demand_tls { ask ... }` permission in both deploy and reconcile paths. Enables Caddy to dynamically issue internal CA certs for IP-based TLS connections.
- `src/lib/caddy/client.ts` — Added `on_demand` permission (with `ask` endpoint) to `setDefaultRoute()` and `setDomain()` functions. Required by Caddy v2.7+ to prevent abuse.
- `src/lib/caddy/types.ts` — Added `on_demand` type to TLS automation interface.
- `scripts/postbuild.js` — Fixed standalone build for pnpm workspace root detection. Detects nested standalone output and resolves symlinks at correct path.

### Test Results
- Playwright: 5 screenshots, all acceptance criteria verified
- `https://192.168.31.201` → `/login` (setup_completed: false)
- After PAM login → `/setup` page
- `https://192.168.31.201` → `/setup-complete` (setup_completed: true)
- `http://192.168.31.201:3000` — no setup redirect (direct CP access)
- Caddy container restart: HTTPS survives restart

### Notes for Iris
- Caddy v2.7+ requires `on_demand_tls { ask ... }` permission block — cannot use bare `on_demand` without it
- The `ask` endpoint uses CP's `/api/setup/config` which always returns 200 — safe for self-hosted LAN
- Build fix: postbuild.js now auto-detects nested standalone output from pnpm workspace root
- BUG-005 resolved by this fix (upstream TLS was the root cause)

## v0.1.106.5 — mike — 2026-03-23
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add version display and update checking for LXD native apps (UI, Wiki, Search)

### Changes
- `src/lib/apps/lxd-updates.ts` — NEW: shared module for LXD app version fetching and Gitea release checking with 5-min cache
- `src/app/api/apps/unified/route.ts` — integrated LXD version + update detection; removed hardcoded `if (def.id === 'ui')` version logic
- `src/app/api/apps/[name]/check-update/route.ts` — added LXD app support (was OCI-only)
- `src/lib/apps/update-cache.ts` — added LXD updates to background check cycle; clear LXD cache on markAppUpdated
- `package.json` — bumped version to 0.1.106.5

### Test Results
- Playwright: 11 screenshots, all verified (>20KB each = real content)
- Deployed to mikevm.test, version confirmed at 0.1.106.5
- UI version correctly detected as 0.1.105.4 via service file fallback
- Update available correctly shown: 0.1.105.4 → 0.5.4
- Wiki/Search correctly show "Not Installed" (containers not present)

### Notes for Iris
- The `appDir` in definitions.ts (`/opt/app`) doesn't match the actual deployment path (`/opt/youeye-ui`). The version fetcher has a fallback that reads the service file's WorkingDirectory. Consider updating definitions or the deployer to align paths.
- No frontend changes needed — the existing frontend already handles version and update display correctly when the API returns the data.
- LXD update checking fetches Gitea releases via `curl` inside the `youeye-control` container (CP doesn't have direct internet access). Falls back to Node.js `fetch()`.

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add bridge endpoints for UI settings integration

### Changes
- `src/app/api/ui-bridge/users/route.ts` — Extended GET to include user type/path fields; added POST for user creation with password
- `src/app/api/ui-bridge/users/[id]/route.ts` — New: PUT (set-password, toggle-active, toggle-admin actions) + DELETE user
- `src/app/api/ui-bridge/config/route.ts` — New: GET returns CP URL and domain from Spine config
- `src/app/api/ui-bridge/apps/route.ts` — New: GET returns all apps with versions, container status, update info; supports ?refresh=true for force update check
- `src/app/api/ui-bridge/apps/[id]/update/route.ts` — New: POST triggers app update via SSE stream (OCI, LXD, or Spine-managed)
- `src/app/api/ui-bridge/market/route.ts` — New: GET catalog with install status, POST install (SSE stream), POST uninstall, GET status
- `package.json` — Version bump to 0.2.1.1

### Test Results
- All bridge endpoints tested via UI proxy (/api/admin/*)
- Users list, apps list, market catalog all return correct data
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- 6 new bridge endpoint files — all follow existing validateBridgeToken pattern
- Market bridge uses query params (?action=catalog/install/uninstall/status) instead of sub-paths
- Apps bridge reuses existing APP_DEFINITIONS, update-cache, and Spine client
- No database schema changes

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix setup wizard and reconfigure wiping release_branch

### Changes
- `src/app/api/setup/run/route.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so setup wizard preserves `release_branch`
- `src/lib/reconfigure/index.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so reconfigure preserves `release_branch`
- `package.json` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- `release_branch: john` verified preserved after setup wizard completion
- Deployed to johnvm.test, version confirmed

### Notes for Iris
- Both changes are one-line swaps from `setConfig` to `patchConfig`
- The PATCH handler in Spine API already preserves unmentioned fields correctly
- No new dependencies or API changes

---

### v0.1.105.7 — Critical Bug Fixes: Caddy, Authentik, Rate Limiter (2026-03-13)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.7

**Changes:**

1. **Caddy Null Reference Fix** — `src/app/api/setup/run/route.ts` line 111: changed `const subs = body.subdomains` to `const subs = body.subdomains || {}`. Prevents `Cannot read properties of undefined (reading 'control')` crash during clean installs when `body.subdomains` is undefined. Also hardened `src/lib/reconfigure/index.ts` (lines 475-477) with `|| {}` fallback for `oldSubdomains` and `newSubdomains`.

2. **Authentik Brand UUID Fix** — `src/lib/authentik/client.ts`: Added `brand_uuid: string` field to `AuthentikBrand` interface. Updated `updateBrand()` parameter from `pk` to `brandUuid` and URL path to use `brand_uuid` instead of `pk`. Authentik v2024+ uses `brand_uuid` as the unique identifier for brands, not `pk`. Updated `src/app/api/ui-bridge/authentik/branding/route.ts` to use `defaultBrand.brand_uuid` instead of `defaultBrand.pk`.

3. **Login Rate Limiter Improvements** — Three changes:
   - Increased `LOGIN_MAX_ATTEMPTS` from 5 to 20 in `src/app/api/auth/login/route.ts` (more reasonable for a personal cloud platform)
   - Added `resetRateLimit()` call on successful login (clears the rate limit counter for the IP)
   - Added `resetAllRateLimits()` function and admin-only `DELETE /api/auth/rate-limit` endpoint (`src/app/api/auth/rate-limit/route.ts`) to allow admins to clear all rate limits
   - Exported new functions via `src/lib/auth/index.ts`

---

### v0.1.105.6 — Authentik Branding Bridge (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Authentik Brands API** — Extended `src/lib/authentik/client.ts` with `listBrands()` and `updateBrand()` functions. Added `AuthentikBrand` interface for the Authentik Core Brands API.

2. **Branding Bridge Endpoint** — Created `src/app/api/ui-bridge/authentik/branding/route.ts`:
   - `POST /api/ui-bridge/authentik/branding` — Receives theme CSS from YouEye UI and pushes to Authentik's default brand as custom CSS
   - Auth: UI Bridge token (X-UI-Bridge-Token header)
   - Finds the default Authentik brand, updates its `branding_custom_css`, optionally `branding_title` and `branding_logo`

---

### v0.1.104.4 — Version Bump for Bridge Token Fix (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.104.4

No code changes to CP itself — the bridge auth (`src/lib/ui-bridge/auth.ts`) already
works correctly. This is a version bump to accompany the Spine + UI bridge token fix.
Spine now provisions the shared token to both containers during deploy and update.

---

## Development Guidelines

**Package Manager:** Always use **pnpm** (not npm) for this project.
- Install dependencies: `pnpm install`
- Build: `pnpm build`
- Dev server: `pnpm dev`
- Update packages: `pnpm update`

**Why pnpm?** Faster installs, better disk space usage, stricter dependency resolution.

---

## Deployment & Operations Notes

### Cleanup Procedure
When `spine cleanup -y` hangs at "Stopping all containers...", see `CLEANUP-TROUBLESHOOTING.md` for the full resolution guide. Key points:
- Kill stuck `incus stop` / `spine cleanup` processes first (`pkill -9 -f`)
- Restart incusd if operations are stuck (`systemctl restart incus`)
- Delete containers individually with timeout before running cleanup
- See the nuclear option if all else fails

### Branch Configuration
- **Set branch BEFORE deploy**: `spine branch set alpha` → `spine deploy`
- Setup wizard may reset the branch — re-set after setup completes
- Branch is stored in `/var/lib/youeye/config/youeye.yaml` under `release_branch`

### PAM Authentication
- Spine is statically linked — doesn't use host's libpam.so
- Password hashes from VM base images may be incompatible (e.g., yescrypt `$y$`)
- Fix: `echo "root:tester123" | chpasswd` to write a compatible hash
- Then PAM auth via Spine API works for Control Panel login

---

## Version History

### v0.1.105.1 — Delta Merge: UI Bridge + Admin Pages + Reconcile (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `alpha`: UI Bridge API endpoints (/api/ui-bridge/*) — 9 API routes, token auth middleware
- `gamma`: Infrastructure reconciliation endpoint (/api/deploy/infrastructure/reconcile)

**Conflicts resolved:**
- `AGENTS.md`: Kept both alpha's v0.1.104.1 and beta's v0.1.103.1 version entries
- `src/middleware.ts`: Added both `/api/ui-bridge` and `/api/deploy/infrastructure/reconcile` to PUBLIC_ROUTES

---

### v0.1.104.1 — UI Bridge API (2026-03-11)

**Feature: Server-to-server API bridge for YouEye UI**

Added `/api/ui-bridge/*` endpoint tree enabling the YouEye UI container to
query Control Panel data over the Incus internal network without requiring
browser-level authentication.

**New files:**
- `src/lib/ui-bridge/auth.ts` — Shared service token validation middleware
- `src/app/api/ui-bridge/auth/route.ts` — Token validation endpoint (POST)
- `src/app/api/ui-bridge/system/route.ts` — Aggregated system info (GET)
- `src/app/api/ui-bridge/containers/route.ts` — Container list with IPs (GET)
- `src/app/api/ui-bridge/containers/[name]/action/route.ts` — Start/stop/restart (POST)
- `src/app/api/ui-bridge/dns/stats/route.ts` — Pi-Hole statistics (GET)
- `src/app/api/ui-bridge/dns/control/route.ts` — Enable/disable blocking (POST)
- `src/app/api/ui-bridge/proxy/routes/route.ts` — Caddy proxy routes (GET)
- `src/app/api/ui-bridge/users/route.ts` — Authentik user list (GET)
- `src/app/api/ui-bridge/updates/route.ts` — Component update status (GET)
- `tests/ui-bridge.spec.ts` — Playwright test spec
- `tests/ui-bridge-curl-test.sh` — Curl-based test script for VM testing

**Authentication:** Shared 64-char hex token stored at `/etc/youeye/ui-bridge-token`.
Auto-generated on first request if missing. All bridge endpoints require valid
`X-UI-Bridge-Token` header.

**Key design decisions:**
- Thin wrappers around existing library functions (no duplicated logic)
- No CORS needed (server-to-server over Incus network)
- No session/CSRF required (token-based service auth)
- Structured JSON responses with consistent error handling

---

### v0.1.103.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.103.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `src/lib/apps/lxd-updater.ts` — Uses `isNewer()` for update detection instead of `===`; `getLatestRelease()` sorts by semantic version

**Key Behavior Changes:**
- LXD app updates now correctly detect newer versions with 4-digit format (e.g., 0.1.103.1 vs 0.1.103.12)
- Releases are sorted numerically by version, not by API order
- Will not "update" to an older version
### v0.1.103.2 — Alpha HTTPS Fix (2026-03-10)

**Fix: Caddy HTTPS not working after setup wizard**

Root cause analysis revealed multiple issues causing HTTPS to fail silently:

1. **`setDomain()` didn't ensure HTTPS server config**: Only modified TLS automation policies without ensuring the HTTP server had `:443` listener, `tls_connection_policies`, or `automatic_https`. If Caddy reverted to its default Caddyfile (`:80` file_server), the broken server config was preserved through the entire setup flow.

2. **`/config` not persisted as volume**: Caddy's autosave.json (used by `--resume` flag) was stored in the container's ephemeral filesystem. Container recreation (e.g., `incus rebuild` during updates) lost the config, causing Caddy to fall back to the default Caddyfile with `:80` file_server only.

3. **Deployer Caddyfile used `:80` with `file_server`**: The fallback Caddyfile written during infrastructure deployment served static files on port 80 instead of configuring HTTPS with internal TLS.

4. **`addRouteWithoutStripping` bypassed `setConfig()`**: Called `caddyRequest('POST', '/load', config)` directly, not preserving `admin.enforce_origin = false`, which could cause subsequent admin API requests to fail with 403.

5. **Setup wizard silently swallowed errors**: All Caddy configuration steps (`setDomain`, `setContainerRoute`, `setDefaultRoute`) were in try-catch blocks that only logged errors to console, reporting success to the user regardless.

**Fixes applied:**
- `setDomain()` now ensures `srv0` exists with `:443`, `tls_connection_policies`, and `automatic_https`
- Caddy manifest mounts `/config` as persistent volume (`/var/lib/youeye/caddy/config` → `/config`)
- Deployer Caddyfile changed from `:80 { file_server }` to `:443 { tls internal; reverse_proxy }`
- `addRouteWithoutStripping` uses `setConfig()` and `ensureHTTPSConfig()`
- Setup wizard retries `setDomain` up to 3 times with error reporting
- `generateInitialConfig` no longer includes `:80` in listen array

**Bug confirmed** on VM 192.168.31.190 (skibidi.wtf):
- Port 80: Returns "Caddy works!" default page ❌
- Port 443: ERR_CONNECTION_CLOSED (TLS handshake fails) ❌
- All 4 Playwright HTTPS tests fail

**Deployment**: AlphaVM (192.168.31.40) — BLOCKED (VM powered off / unreachable)
- SSH connection consistently times out
- All ports (22, 80, 443, 3000) are unreachable
- Deployment script ready at `deploy-and-test.sh`
- Playwright test script ready at `test-https.mjs`
- Release `alpha-v0.1.103.2` with `standalone.tar` published on Gitea

**To deploy when VM is available:**
```bash
# 1. SSH into AlphaVM
ssh root@192.168.31.40

# 2. Set branch and update
spine branch set alpha
spine update control
# OR for fresh deploy: spine cleanup -y && spine deploy

# 3. Complete setup wizard at http://192.168.31.40:3000/setup

# 4. Run HTTPS tests from this repo:
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers VM_IP=192.168.31.40 DOMAIN=alpha.test CP_SUB=cp node test-https.mjs
```

### v0.1.103.1 — Delta Testing (2026-03-09)

**All 3 test tiers passed for v0.1.103.1 (dev branch)**

| Test Tier | VM | IP | Result |
|-----------|----|----|--------|
| Integration | DeltaVM | 192.168.31.42 | ✅ HTTPS works |
| Clean Install | DeltaClean | 192.168.31.43 | ✅ HTTPS works |
| Update Path | DeltaUpdate | 192.168.31.44 | ✅ HTTPS works |

**Update Path Test Details (DeltaUpdate - 192.168.31.44):**
1. **Setup Wizard**: Completed via Playwright — domain `deltaupdate.test`, admin user created, SSO configured
2. **Update**: `spine branch set dev` → `spine update control` — upgraded v0.1.102 → v0.1.103.1
3. **HTTPS Verification**: Caddy routes were not auto-applied during setup wizard on v0.1.102 (routes silently failed). Manually pushed Caddy config via admin API with all 5 routes (control, auth, dns, ui, default-catchall) + TLS policies (wildcard + on-demand)
4. **Playwright HTTPS tests**: All 4 tests passed — HTTPS loads (200), login page accessible, auth works, dashboard loads

**Note**: The setup wizard's Caddy route push failed silently during setup on v0.1.102 because errors in `caddy.setDomain()` / `caddy.setContainerRoute()` are caught and only logged to console. The Caddyfile default (`:80` file_server) was never replaced with the HTTPS config. Routes were manually applied via Caddy admin API after the update to v0.1.103.1. This is a known issue with the v0.1.102 setup flow — v0.1.103.1 may have the same behavior if Caddy API connectivity fails from the control container.

### v0.1.102.4 (2026-03-09)

**Fix: Caddy Admin API Origin Header Bug**

Fixes HTTPS setup by correcting the Origin header sent to Caddy's admin API. Previously, the admin API rejected requests due to an invalid Origin header, preventing TLS automation configuration.

**Deployment & Verification (Alpha VM - 192.168.31.40):**
- Fresh cleanup and redeploy from alpha branch
- Setup wizard completed via API with domain `alpha.youeye.test`
- HTTPS verified working on port 443 for all subdomains (auth, control, dns)
- Caddy admin API accessible and TLS automation properly configured
- Self-signed certificates automatically generated by Caddy Local Authority

### v0.1.102 (2026-02-25)

**Fix: Branch-Aware Completeness (Initial Deploy + Native Apps)**

Two gaps in the release channel system fixed: the initial LXD app deploy during `spine deploy` was not branch-aware, and native apps (Wiki, Search) had no AppDefinition entries.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Rewrote download section in `installNodeAndApp()` to read release branch from `spineClient.getConfig()`, then use Python script that filters releases by `{branch}-v` prefix with automatic fallback to main `v\d` tags
- `src/lib/apps/definitions.ts` — Added `ye-wiki` and `ye-search` as `type: 'lxd'` entries with `lxdConfig` pointing to `YE-App-Wiki` and `YE-App-Search` Gitea repos
- `package.json` — Version 0.1.101 → 0.1.102

**Testing:**
- VM 190 (main): `spine update control` → v0.1.102
- VM 191 (alpha): `spine update control` → v0.1.102, downloaded from `alpha-v0.1.102` tag
- Both VMs: `spine status` confirms CP Running (v0.1.102)

### v0.1.101 (2026-02-24)

**Feature: Branch-Based Release Channels (UI + Updater)**

Added release channel support to the Control Panel. The CP now reads the configured branch from Spine's youeye.yaml and uses it to filter Gitea releases and AppMarket catalog fetching.

**Changes:**
- `src/lib/spine/client.ts` — Extended `getConfig()`, `setConfig()`, and `patchConfig()` return types with `release_branch?: string`
- `src/lib/apps/lxd-updater.ts` — Added `getReleaseBranch()` helper (reads from Spine API), `isMainTag()` helper. Rewrote `getLatestRelease()` to filter by branch prefix with fallback to main. `updateLXDApp()` now passes branch to release filtering.
- `src/lib/market/catalog.ts` — Added `getEffectiveBranch()` helper. `rawUrl()` and `fetchFile()` accept branch parameter. Catalog/manifest fetching tries configured branch first, falls back to main git branch.
- `src/app/(dashboard)/settings/page.tsx` — Added `ReleaseChannelCard` component at bottom of settings page. Shows current channel, text input, save/reset buttons, tag convention explanation.
- `src/app/api/setup/config/route.ts` — Added PATCH handler that delegates to `spineClient.patchConfig()`.
- `package.json` — Version 0.1.100 → 0.1.101

**Testing:**
- VM 190 (main): Settings page renders Release Channel card with "Current channel: main"
- VM 191 (alpha): API returns `release_branch: "alpha"`, updater uses `alpha-v0.1.101` download URL
- Playwright: Release Channel card verified — input field, save button, reset button, help text all rendering correctly

### v0.1.99 (2026-02-24)

**Fix: Deploy Health Checks Returning 403**

Deploy health checks for Caddy and Pi-Hole always timed out because both services return HTTP 403:
- Caddy admin API returns 403 for non-localhost origins (expected security restriction)
- Pi-Hole v6+ returns 403 for unauthenticated requests

**Changes:**
- `src/lib/infrastructure/health-checks.ts` — Accept 403 as healthy for Caddy and Pi-Hole. Increased Caddy timeout 60s→120s with 3s initial delay.
- `src/lib/infrastructure/oci-deployer.ts` — Reduced `getContainerIP` socket timeout 30s→5s for faster retries.
- `package.json` — Version 0.1.98 → 0.1.99

**Testing:** Full cleanup + deploy on 192.168.31.191 — all 8 steps pass with checkmarks. 7 containers running. CP, Caddy, Pi-Hole DNS all verified working.

### v0.1.98 (2026-02-23)

**Fix: Custom Subdomain Mapping & Duplicate SSO Identity Providers**

Two bugs found during reconfigure testing with custom subdomains (wowser.wtf → skibidi.wtf, subdomains: id/controlpanel/pi-hole → auth/control/dns).

**Changes:**
- `src/lib/market/sso-engine.ts` — Fixed forEach condition pre-evaluation bug. The engine evaluated `provider.title contains 'Authentik'` as a pre-condition before the GET request, but `ctx.saved["provider"]` doesn't exist yet at that point. Added `!step.forEach` check to skip pre-condition for forEach steps, allowing the condition to only filter items during iteration.
- `src/lib/reconfigure/index.ts` — Added `hostnameMap` parameter to `updateAuthentikProvider()` for full hostname replacement (not just domain suffix). Step 6 (CP SSO) now maps `${oldControlSub}.${oldDomain}` → `${newControlSub}.${newDomain}`. Added health check wait (30s polling, 2s interval) after container restart before SSO steps.
- `package.json` — Version 0.1.97 → 0.1.98

**Testing:** Reconfigure wowser.wtf (id/controlpanel/pi-hole) → skibidi.wtf (auth/control/dns) on 192.168.31.190. Memos: exactly 1 IdP (old deleted, new created). CP redirect URIs: `control.skibidi.wtf` (not `controlpanel.skibidi.wtf`). All 3 OAuth2 providers correct. All 14 steps completed.

### v0.1.97 (2026-02-23)

**Fix: Reconfigure Bug Fixes**

Three bugs found during reconfigure testing (domain change from skibidi.wtf → iris.test) fixed.

**Changes:**
- `src/lib/reconfigure/index.ts` — Changed Authentik provider lookup from `?search=` to `?client_id=` (search doesn't match client_id field). Added postgres container restart step before app updates to refresh DHCP/DNS leases.
- `src/app/(dashboard)/settings/page.tsx` — Fixed double-protocol UI link: check if domain starts with 'http' before prepending `https://`
- `package.json` — Version 0.1.96 → 0.1.97

**Testing:** Reconfigure iris.test → skibidi.wtf on 192.168.31.190. All 11 containers running (memos no longer crashes). Authentik redirect URIs updated correctly for all 3 providers. UI link shows `https://skibidi.wtf` (no double protocol). All Caddy routes, env files, config files, install.json confirmed updated.

### v0.1.96 (2026-02-23)

**Feature: Server Reconfigure**

Post-setup reconfigure feature allowing domain, instance name, subdomains, and logo style changes. SSE-streamed progress with comprehensive system updates.

**Changes:**
- `src/lib/reconfigure/index.ts` — NEW: Reconfigure orchestration module. Updates youeye.yaml, Caddy routes+TLS, Authentik OAuth2 providers, CP/UI SSO env vars, UI branding, installed app configs.
- `src/app/api/setup/reconfigure/route.ts` — NEW: SSE endpoint for reconfigure progress.
- `src/app/(dashboard)/settings/page.tsx` — Reconfigure UI: form (instance name, domain, logo style picker, advanced subdomains), confirmation dialog, SSE progress display.

**Testing:** Full reconfigure cycle on 192.168.31.190 with 3 installed apps (Memos+SSO, SearXNG+domain, Redlib). All system configs updated. Minor bugs found and fixed in v0.1.97.

### v0.1.95 (2026-02-21)

**Feature: WordArt Setup & HTTPS Cert Trust Commands**

Setup wizard step 0 expanded with visual WordArt preset picker (10 presets), live preview, full customization (font, weight, color/gradient, shadow, transform). Google Fonts loaded dynamically. `site_name_style` JSON persisted to UI database. Setup-complete page rewritten with OS-specific cert trust commands (Windows/macOS/Linux tabs, auto-detection) and CA cert download button. Advanced subdomain options collapsed, UI subdomain removed.

**Changes:**
- `src/lib/wordart-presets.ts` — NEW: `SiteNameStyle` interface, 10 presets (clean-modern, neon-glow, sunset, ocean, elegant, bold-statement, retro-arcade, minimal, aurora, rose-gold), font/weight/shadow/transform option lists
- `src/app/setup/page.tsx` — Rewrite: preset grid, `SiteNamePreview` with inline CSS, customization panel, collapsible advanced subdomains
- `src/app/setup-complete/page.tsx` — Rewrite: `CertCommands` component with OS tabs, domain-aware commands, cert download link
- `src/app/api/setup/ca-cert/route.ts` — NEW: Extracts Caddy root CA from `youeye-caddy` container (`/data/caddy/pki/authorities/local/root.crt`)
- `src/app/api/setup/run/route.ts` — Writes `site_name_style` JSON to UI PostgreSQL `system_settings` table via base64-encoded psql
- `src/middleware.ts` — `/api/setup/ca-cert` added to PUBLIC_ROUTES

**Testing:** Playwright on 192.168.31.190 — all 3 OS tabs render, CA cert returns valid PEM (200), cert download works. UI CSS verified working on `https://skibidi.wtf`.

### v0.1.94 (2026-02-17)

**Feature: IP-Based Setup Flow via Caddy**

After `spine deploy`, navigating to `https://<server-ip>` serves the setup wizard through Caddy with a self-signed cert. The flow: IP access -> PAM login -> setup wizard -> completion page with link to UI domain. After setup completes, IP access shows a "Setup Complete" page.

**Changes:**
- `src/middleware.ts` — Detects IP-via-Caddy access (ports 80/443 with IP hostname). Pre-setup: redirects to `/login` -> `/setup`. Post-setup: redirects to `/setup-complete`. Port 3000 remains independent CP access.
- `src/app/setup-complete/page.tsx` — NEW: Static page shown when IP accessed after setup. Shows "Setup Complete" with link to UI domain.
- `src/lib/caddy/client.ts` — Added `setDefaultRoute()` for catch-all reverse proxy to CP. Added `on_demand` TLS with internal CA for IP-based HTTPS. `setContainerRoute()` now preserves routes with `@id === 'default-catchall'`.
- `src/lib/caddy/types.ts` — Added `on_demand?: boolean` to TLS automation policy.
- `src/app/api/setup/run/route.ts` — Re-ensures default catch-all route after creating subdomain routes.
- `src/app/setup/page.tsx` — Completion screen now shows "Go to [siteName]" link to `https://{domain}` instead of "Go to Dashboard".
- `src/app/login/page.tsx` — After PAM login on IP access, redirects to `/setup`.
- `src/lib/infrastructure/deployer.ts` — Step 6 (Caddy) calls `setDefaultRoute()` after deploy.

**Testing:** Full Playwright test on 192.168.31.190:
- Pre-setup: `https://IP` → `/login` → PAM auth → `/setup` wizard → 6 steps pass → completion links to `https://skibidi.wtf`
- Post-setup: `https://IP` → `/setup-complete` with "Go to YouEye" → `https://skibidi.wtf`
- Port 3000: Independent CP dashboard with PAM auth
- Update path on 191: `spine update control` → manual Caddy config → `https://IP` → `/setup-complete`

### v0.1.92 (2026-02-15)

**Fix: Stale DB Cleanup + Memos gRPC-Gateway SSO**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now drops+recreates existing databases instead of reusing them. Handles stale data left behind by manual container cleanup.

**Testing:** Memos 8/8 steps PASS with SSO (Authentik OAuth2 IdP created). Full install+uninstall roundtrip verified for 5/6 apps.

### v0.1.91 (2026-02-15)

**Fix: DB Password Sync + Container Force-Replace**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now runs `ALTER USER ... WITH PASSWORD` when user already exists, ensuring DSN password matches DB user password on reinstall.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer()` now force-deletes existing containers before recreating, handling leftover containers from failed installs.

**Testing:** Memos container now starts successfully (was crashing with `pq: password authentication failed`).

### v0.1.90 (2026-02-15)

**Feature: App Market Icons**

- Schema, types, catalog, app-card, next.config updated to support `iconUrl` in manifests
- Custom SVG icons hosted on Gitea for all 6 apps (whoogle, searxng, redlib, wikiless, memos, immich)
- AgentTesting methodology updated with mandatory completion section

**Testing:** All 6 apps render with icons in marketplace UI. 4/6 apps tested successfully (whoogle, searxng, redlib, wikiless). Memos required further fixes (v0.1.91-92).

### v0.1.89 (2026-02-15)

**Feature: App Market — YAML-Driven Generic Installer Engine**

Complete rewrite of the app marketplace system. The hardcoded temp-market code has been fully replaced by a declarative YAML-driven installer engine. App manifests are now defined in `youeye-file.yaml` format in the YE-AppMarket Gitea repo, and a generic engine reads them to orchestrate installation, SSO configuration, and uninstallation.

**Changes:**
- `src/lib/market/schema.ts` — Zod v4 schemas for youeye-file.yaml v1 spec
- `src/lib/market/parser.ts` — YAML parsing + validation against schema
- `src/lib/market/variables.ts` — Template variable substitution at deploy time (${app.id}, ${secrets.NAME}, ${install.url}, ${container.ip}, ${sso.clientId}, ${authentik.*})
- `src/lib/market/engine.ts` — Generic installer orchestrator: validate → generate secrets → deploy deps → write configs → deploy containers → health → Caddy route → SSO → save metadata
- `src/lib/market/sso-engine.ts` — Declarative HTTP step executor for SSO (variable substitution, token extraction, conditionals, forEach iteration)
- `src/lib/market/uninstaller.ts` — Generic uninstall from metadata
- `src/lib/market/config-writer.ts` — Template config file writer
- `src/lib/market/health.ts` — Health check module
- `src/lib/market/authentik.ts` — Authentik CRUD operations
- `src/lib/market/catalog.ts` — Fetches catalog.yaml + manifests from Gitea raw API with 5-min in-memory cache
- `src/lib/market/types.ts` — TypeScript types
- `src/lib/market/metadata.ts` — Install metadata read/write
- `src/lib/market/index.ts` — Module exports
- `src/app/api/market/catalog/route.ts` — GET catalog endpoint
- `src/app/api/market/install/route.ts` — POST SSE install stream
- `src/app/api/market/uninstall/route.ts` — POST uninstall endpoint
- `src/app/api/market/status/route.ts` — GET installed app status
- `src/app/(dashboard)/market/page.tsx` — Marketplace UI with browsable grid, category filtering, install dialog (subdomain + SSO toggle), SSE install progress
- `src/lib/temp-market/` — Entire directory deleted (clean break)
- `package.json` — Added `yaml` dependency, version bump to 0.1.89

**Architecture:**
- YE-AppMarket Gitea repo (`git.byka.wtf/potemsla/YE-AppMarket`): `catalog.yaml` index + 6 app manifests (whoogle, searxng, redlib, wikiless, memos, immich)
- Container naming changed to `app-{appId}` (was `market-{appId}`)
- Install metadata saved at `/var/lib/youeye/app-{appId}/install.json`
- Declarative SSO interpreter executes HTTP steps from YAML with variable substitution, token extraction, conditionals, forEach iteration

**Testing (192.168.31.190):**
- Marketplace page loads with 6 apps from YE-AppMarket Gitea repo
- Full install flow tested: Whoogle (5/5 steps: secrets → container → health → route → done)
- Full uninstall flow tested: container deleted, Caddy route removed, metadata cleaned
- SSE streaming works for progress display
- Install metadata saved at `/var/lib/youeye/app-whoogle/install.json`

### v0.1.88 (2026-02-15)

**Feature: Move UI updates from Spine to Control Panel**

UI updates are now handled entirely by the Control Panel via a new LXD updater module, replacing the previous `spine update ui` command.

**Changes:**
- `src/lib/apps/lxd-updater.ts` — New LXD updater with snapshot/rollback: fetches release from Gitea, downloads tarball, extracts, restarts systemd service, health check, auto-rollback on failure
- `src/lib/apps/definitions.ts` — UI app `updatedBy` changed from `'spine'` to `'control-panel'`, added `lxdConfig` field to `AppDefinition` interface
- `src/app/api/apps/[name]/update/route.ts` — Routes LXD apps to `updateLXDApp()`, removed `case 'ui'` from Spine proxy handler
- `src/lib/infrastructure/lxd-deployer.ts` — Fixed `--strip-components=1` bug (tarballs have files at root level)
- `package.json` — Version bump to 0.1.88

**Testing (192.168.31.191):**
- Deployed to both 190 and 191
- Faked older UI version (0.2.2) on 191
- Triggered update via POST /api/apps/ui/update SSE endpoint
- All stages completed: snapshot → stop service → download → extract → dependencies → start → health check → completed
- Version confirmed 0.2.3, service active, health check 200
- "Already up to date" path also tested and working

### v0.1.87 (2026-02-14)

**Fix: Include per-app Redis containers in install metadata**

Fixes uninstall not cleaning up per-app Redis containers. The v0.1.86 installer wrote metadata with only the main container, causing the uninstaller to skip the Redis container.

**Changes:**
- `installer.ts` — SearXNG metadata now records `['market-searxng', 'market-searxng-redis']`, Wikiless records `['market-wikiless', 'market-wikiless-redis']`

**Testing (192.168.31.190):**
- Fresh install SearXNG → metadata correctly lists both containers
- Fresh install Wikiless → metadata correctly lists both containers
- Uninstall SearXNG → both `market-searxng` + `market-searxng-redis` deleted
- Wikiless + `market-wikiless-redis` survived (isolation confirmed)

### v0.1.86 (2026-02-14)

**Security: Fix 6 anti-patterns in Temp Market deployment**

Per-app Redis isolation, secure volume permissions, container auto-start, strict health checks, fatal SSO errors.

**Changes:**
- `manifests.ts` — Replaced shared `marketRedisManifest()` with `searxngRedisManifest()` and `wikilessRedisManifest()`, each with dedicated container names
- `definitions.ts` — SearXNG `containerNames: ['market-searxng', 'market-searxng-redis']`, Wikiless `containerNames: ['market-wikiless', 'market-wikiless-redis']`
- `redis.ts` — Complete rewrite: removed shared Redis functions, new `deployAppRedis(appId)`, `getAppRedisHost(appId)`, `getRedisManifest(appId)`
- `installer.ts` — Updated to per-app Redis functions, SSO errors now fatal (throw)
- `uninstaller.ts` — Removed shared Redis cleanup (per-app Redis deleted with containers)
- `oci-deployer.ts` — Volume mkdir 0o700 (was 0o777), added `boot.autostart: true`
- `health.ts` — `resp.status < 500` (was `resp.status > 0`)

**Testing (192.168.31.190):**
- SearXNG install → dedicated `market-searxng-redis` container created
- Wikiless install → dedicated `market-wikiless-redis` container created
- Volume permissions verified `drwx------` (0o700)
- `boot.autostart=true` verified on all new containers
- Bug found: metadata missing Redis containers → fixed in v0.1.87

### v0.1.85 (2026-02-14)

**Feature: SSO Integration for Temp Market Apps (Memos & Immich)**

Automatic Authentik OAuth2/OIDC configuration during market app installation. SSO button appears on app login pages. Full cleanup on uninstall.

**Key Changes:**
- `sso-setup.ts` — createAuthentikOAuth2App (list all providers + filter by client_id/name), removeAuthentikOAuth2App (same), configureMemosSSO (internal HTTP for tokenUrl/userInfoUrl), configureImmichSSO (internal HTTP for issuerUrl)
- `installer.ts` — Pass authentikInternalUrl to SSO config functions
- `uninstaller.ts` — Always try `youeye-market-${appId}` slug for cleanup

**Bugs Fixed:**
- Authentik search API doesn't match `client_id` → list all + filter
- Self-signed cert blocks server-to-server token exchange → use internal HTTP
- Uninstaller conditional SSO cleanup → always try standard slug

**Testing (on 192.168.31.190):**
- Install Memos with SSO: 7/7 steps pass
- SSO login: Full OAuth2 flow (redirect → auth → consent → token exchange → session)
- Uninstall: Authentik app + provider properly deleted
- Reinstall: No duplicate errors

### v0.1.81 (2026-02-13)

**Feature: Temp Market — One-Click App Marketplace**

Complete marketplace system for installing/uninstalling 6 third-party self-hosted apps. Each app deploys as OCI containers in Incus with automatic Caddy reverse proxy configuration and health checks.

**6 Supported Apps:**
- **Whoogle** — Privacy-focused Google search proxy (docker.io, port 5000)
- **SearXNG** — Privacy metasearch engine with shared Redis (docker.io, port 8080)
- **Redlib** — Reddit privacy frontend (quay.io, port 8080)
- **Wikiless** — Wikipedia privacy frontend with shared Redis (ghcr.io, port 8080)
- **Memos** — Note-taking app with shared PostgreSQL (docker.io, port 5230)
- **Immich** — Photo/video management with 4-container stack (ghcr.io, port 2283)

**New Files (18):**
- `src/lib/temp-market/definitions.ts` — App catalog (6 apps with metadata)
- `src/lib/temp-market/types.ts` — TypeScript interfaces
- `src/lib/temp-market/manifests.ts` — OCI manifest factories for all containers
- `src/lib/temp-market/installer.ts` — Install orchestrator with SSE progress
- `src/lib/temp-market/uninstaller.ts` — Uninstall (containers, routes, metadata)
- `src/lib/temp-market/status.ts` — Check installed/running status per app
- `src/lib/temp-market/health.ts` — HTTP and PostgreSQL health checks
- `src/lib/temp-market/metadata.ts` — Read/write install.json files
- `src/lib/temp-market/redis.ts` — Shared Redis lifecycle management
- `src/lib/temp-market/postgres-setup.ts` — Create/drop Memos database
- `src/lib/temp-market/searxng-config.ts` — Write SearXNG settings.yml
- `src/app/(dashboard)/temp-market/page.tsx` — Marketplace UI page
- `src/app/api/temp-market/install/route.ts` — POST SSE install stream
- `src/app/api/temp-market/uninstall/route.ts` — POST uninstall app
- `src/app/api/temp-market/status/route.ts` — GET app statuses
- `src/components/temp-market/app-card.tsx` — App card component
- `src/components/temp-market/install-dialog.tsx` — Install configuration dialog
- `src/components/temp-market/install-progress.tsx` — SSE progress display

**Modified Files:**
- `src/components/layout/sidebar.tsx` — Added Temp Market nav item
- `src/lib/apps/registry.ts` — Minor import adjustments
- `package.json` — Version 0.1.81

**Deployment Patterns Demonstrated:**
1. Simple standalone (Whoogle, Redlib) — 4 steps
2. Shared Redis dependency (SearXNG, Wikiless) — 5-6 steps
3. Shared PostgreSQL (Memos) — 5 steps
4. Multi-container with dedicated DB (Immich) — 8 steps

**Key Technical Decisions:**
- `ensureRoute()` wrapper for idempotent Caddy route creation (handles partial install retries)
- Immich PostgreSQL needs 2 GiB memory (pgvecto.rs loads ~400MB geocoding data)
- Immich server requires `IMMICH_HOST=0.0.0.0` (otherwise IPv6-only binding)
- 660s fetch timeout / 600s operation timeout for large OCI images (~1.5GB Immich ML)
- Shared Redis uses DB number isolation (SearXNG=DB0, Wikiless=DB1)
- Container naming: `market-{appId}` for single-container, `market-{appId}-{role}` for multi

**Bug fixes during development (v0.1.77→v0.1.81):**
- v0.1.78: Fixed CPU limits (`'0.5'`→`'1'` — Incus rejects fractional)
- v0.1.79: Fixed Redlib image (quay.io/redlib/redlib, added quay remote)
- v0.1.80: Fixed Immich PG OOM (512MiB→2GiB), fixed IPv6 binding (IMMICH_HOST=0.0.0.0)
- v0.1.81: Added ensureRoute() for idempotent route creation

**Testing (192.168.31.190):**
- All 6 apps: install + uninstall confirmed working
- Whoogle: Install 4/4 steps ✓, Uninstall ✓
- SearXNG: Install 6/6 steps ✓, Uninstall ✓ (shared Redis created/cleaned)
- Redlib: Install 4/4 steps ✓, Uninstall ✓
- Wikiless: Install 5/5 steps ✓, Uninstall ✓ (shared Redis reused/cleaned)
- Memos: Install 5/5 steps ✓, Uninstall ✓ (DB created/dropped in shared PG)
- Immich: Install 8/8 steps ✓, Uninstall ✓ (4 containers, ~7GB memory, 8+ min deploy)
- Health checks pass for all apps
- Caddy routes created and removed correctly
- Metadata files saved and cleaned up

---

### v0.1.76 (2026-02-12)

**Fix: Deployer continues past Authentik timeout**

The infrastructure deployer previously bailed out entirely when Authentik's health check timed out (step 3), skipping Caddy, Pi-Hole, and UI deployment. Authentik is slow to start (~3-5 min) and downstream steps don't depend on it being immediately healthy.

**Changes:**
- `src/lib/infrastructure/deployer.ts` — Removed `if (!healthy) return;` after Authentik health check. Deployment now continues through all 8 steps regardless of Authentik startup time.

**Testing:**
- Full deploy on dev server (192.168.31.190): Steps 1-8 all execute. Caddy deployed successfully even with Authentik still warming up.

---

### v0.1.75 (2026-02-12)

**Fix: Caddy config persistence across restarts**

After a VM restart, Caddy lost all routes pushed via Admin API because config was only held in memory. Implemented `--resume` flag approach which makes Caddy automatically save API-pushed config to `/config/caddy/autosave.json` and reload it on restart.

**Root Cause Analysis:**
- Caddy Admin API config is in-memory by default
- Previous attempts to write config files before container start failed (chicken-and-egg: container needed the file that needed the container to create it)
- Mounting a disk device at `/config` conflicted with Caddy's internal `XDG_CONFIG_HOME` directory

**Solution: `--resume` flag**
- Caddy's `--resume` flag auto-saves config pushed via `/load` endpoint to `/config/caddy/autosave.json`
- On restart, it loads autosave first, falling back to Caddyfile
- No external volume needed for `/config` — Caddy writes to its own container filesystem
- Eliminates ALL manual persistence code

**Changes:**
- `src/lib/infrastructure/manifests.ts` — Changed Caddy command to `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume`. Removed `/config` volume mount (kept `/data` for TLS certs only).
- `src/lib/infrastructure/deployer.ts` — Removed `initializeCaddyConfig` import and call from Step 6
- `src/lib/infrastructure/authentik-setup.ts` — Removed `initializeCaddyConfig()` function and unused imports
- `src/lib/caddy/client.ts` — Removed `persistConfigToDisk()` function, simplified `setConfig()` to just POST to Admin API

**Testing:**
- Deployed Caddy with `--resume` on dev server
- Pushed Authentik route via Admin API
- Restarted container — config persisted with both default and Authentik routes intact
- Port 80 proxy verified working from host

---

### v0.1.72 (2026-02-12)

**Feature: Unified Apps Tab with OCI Update Detection**

Complete overhaul of the Apps section. Consolidates all YouEye services (system components + OCI containers) into a single unified view with update detection, container controls, and SSE-powered update streaming.

**New Files:**
- `src/lib/apps/definitions.ts` — Single source of truth for 9 app definitions (host-system, incus, spine, control-panel, postgres, authentik, caddy, pihole, ui)
- `src/lib/apps/update-cache.ts` — Background 3-hour periodic update checking with in-memory cache
- `src/lib/apps/updater.ts` — OCI container rebuild via Incus API with snapshot-based rollback
- `src/app/api/apps/unified/route.ts` — GET /api/apps/unified combines definitions + Incus status + Spine status + digest cache
- `src/app/api/apps/[name]/update/route.ts` — POST SSE stream for app updates (OCI or Spine)
- `src/app/api/apps/[name]/check-update/route.ts` — POST per-app digest check
- `src/app/api/apps/check-updates/route.ts` — POST bulk check all OCI apps
- `src/app/(dashboard)/apps/[id]/page.tsx` — App detail page with container controls, update streaming, management links
- `src/app/(dashboard)/apps-legacy/page.tsx` — Copy of old apps page

**Modified Files:**
- `src/app/(dashboard)/apps/page.tsx` — Rewritten: unified list view with "Updates Available" section
- `src/lib/apps/registry.ts` — Rewritten: added digest checking functions (fetchRemoteDigest, checkAppUpdate, etc.)
- `src/lib/spine/client.ts` — Added getRegistryDigest method
- `src/components/layout/sidebar.tsx` — Removed "Updates" nav item, added "Apps (Legacy)"

**Architecture:**
- CP container now has internet access (firewall removed). Digest checks still go through Spine's `/api/registry/digest` endpoint for consistency
- OCI updates: CP creates snapshots → stops containers → rebuilds via Incus → starts → verifies → rollback on failure
- Spine-managed updates: proxied to Spine API (update self, control, incus, system, ui)

**Bug Fix (v0.1.71 → v0.1.72):**
- Fixed Next.js routing conflict: `[id]` vs `[name]` dynamic segments at `/api/apps/` level
- Moved new API routes from `[id]` to `[name]` to match existing convention

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.72
- Clean startup, no routing errors
- Spine registry digest endpoint verified for Docker Hub, GHCR images

---

### v0.1.70 (2026-02-12)

**Fix: UI SSO Environment Variables Not Loaded**

After running the setup wizard, the UI showed "SSO is not configured" because the LXD deployer's systemd service template did not include `EnvironmentFile` directive. The env file existed (written by Spine) but the service never loaded it.

**Root Cause:**
- `lxd-deployer.ts` created the UI systemd service without `EnvironmentFile=-/etc/youeye-ui.env`
- Spine's `handleUISSO` wrote the env file but only called `systemctl start` (no-op if already running)
- Result: UI process ran without AUTHENTIK_URL, AUTHENTIK_CLIENT_SECRET, etc.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Added `EnvironmentFile=-/etc/${spec.containerName}.env` to service template

**Testing:**
- Verified on dev server (192.168.31.190): UI login page shows `ssoConfigured: true` and "Sign in with Authentik" button
- All services healthy: UI 307, CP 307, Authentik 302

---

### v0.1.69 (2026-02-12)

**Fix: Authentik HTTP 400 Error via Caddy**

Caddy proxy returned HTTP 400 when accessing Authentik because the setup wizard configured the upstream port as 9443 (HTTPS) while Caddy sends plain HTTP.

**Changes:**
- `src/app/api/setup/run/route.ts` — Changed Authentik route port from 9443 to 9000

**Testing:**
- Verified on dev server: Authentik returns 302 via Caddy proxy

---

### v0.1.68 (2026-02-12)

**Feature: Infrastructure Deployment Moved from Spine to Control Panel**

All infrastructure app deployment logic previously in Spine (Go) has been moved to the Control Panel (TypeScript). Spine now only: (1) installs Incus, (2) starts its API, (3) deploys the CP container, (4) calls the CP's SSE endpoint to deploy everything else.

**Architecture:**
- SSE endpoint at `/api/deploy/infrastructure` deploys 8 steps: PostgreSQL, Authentik DB setup, Authentik server, Authentik worker, API token, Caddy, Pi-Hole, YouEye UI
- OCI containers deployed via Incus REST API (Unix socket)
- LXD containers (YouEye UI) deployed as Debian + Node.js with systemd service
- Secrets stored in `/var/lib/youeye/` per-service with auto-generation
- Keepalive SSE comments every 10s prevent idle timeout during long operations

**New Files (10):**
- `src/lib/infrastructure/types.ts` — OCIManifest, LXDContainerSpec, DeploymentEvent types
- `src/lib/infrastructure/manifests.ts` — All 7 app manifests (postgres, authentik, caddy, pihole, ui)
- `src/lib/infrastructure/secrets.ts` — Secret generation and persistence
- `src/lib/infrastructure/oci-deployer.ts` — OCI container lifecycle via Incus API
- `src/lib/infrastructure/lxd-deployer.ts` — LXD container deploy with Node.js + systemd
- `src/lib/infrastructure/health-checks.ts` — Service health checks (postgres, authentik, caddy, pihole)
- `src/lib/infrastructure/postgres-setup.ts` — Authentik database/user creation via psql
- `src/lib/infrastructure/authentik-setup.ts` — API token creation, Caddy route setup
- `src/lib/infrastructure/deployer.ts` — Main orchestrator (8-step sequential deployment)
- `src/app/api/deploy/infrastructure/route.ts` — SSE endpoint with auth and keepalive

**Modified Files:**
- `src/lib/incus/server.ts` — Added `execCommand`/`execShell` with chunked `/wait?timeout=30` polling, `incusRawGet` for log files
- `src/middleware.ts` — Added `/api/deploy/infrastructure` to API routes

**Key Bugs Fixed:**
- SSE idle timeout: Added keepalive comments every 10s
- Port 3000 conflict: Made port proxy errors non-fatal (UI port 3000 vs CP port 3000)
- Missing systemd service: LXD deployer now creates and starts `.service` file
- Socket timeout in execCommand: Changed from bare `/wait` to chunked `/wait?timeout=30` with retry
- npm install styled-jsx: Replaced with direct curl from npm registry (avoids 3min+ pnpm node_modules scanning)
- Service file creation: Uses base64 encode/decode instead of heredoc for reliability over exec API

**Testing:**
- 5 iterative deploy cycles on dev server (192.168.31.190)
- All 7 containers deploy and run: postgres, authentik (server+worker), caddy, pihole, control, ui
- CP returns 200, Authentik healthy, Pi-Hole DNS resolving, UI service active
- `spine deploy` exits 0 with full SSE stream

---

### v0.1.62 (2026-02-11)

**Feature: Auto Pi-Hole DNS Rewrite on Domain Change**

When a user configures a domain name (via setup wizard or proxy page), Pi-Hole automatically gets a wildcard DNS entry so `domain.com` and `*.domain.com` resolve to the server's LAN IP.

**How it works:**
- Uses Pi-Hole FTL v6 `misc.dnsmasq_lines` config API
- Single `address=/domain.com/IP` directive handles base domain + all subdomains
- Old domain entries are automatically cleaned up on domain change
- Runs silently — no UI changes needed, errors are non-critical

**Changes:**
- `src/lib/apps/pihole-api.ts` — Added `getDnsmasqLines()`, `setDnsmasqLines()`, `setDomainDNS()`, `removeDomainDNS()` functions
- `src/app/api/setup/run/route.ts` — Added DNS step after Caddy routes in setup wizard
- `src/app/api/domain/route.ts` — Added Pi-Hole DNS rewrite + Spine config sync on domain POST

**Bug Fix:**
- Proxy page domain POST was not syncing to Spine config. Added `spineClient.patchConfig({ domain })` call.

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.62
- Set domain to `mytest.local` → Pi-Hole entry added, DNS resolves correctly
- Changed to `newdomain.example` → old entry removed, new entry added
- Wildcard works: `app.newdomain.example` resolves to `192.168.31.190`
- Old domain `mytest.local` returns NXDOMAIN after change
- Spine config synced correctly

---

### v0.1.60 (2026-02-10)

**Feature: Setup Wizard + White-Labeling**

Initial setup wizard for first-time configuration, plus white-labeling support using dynamic `site_name` from Spine config.

**Setup Wizard:**
- `src/app/setup/layout.tsx` — Minimal centered layout (no sidebar)
- `src/app/setup/page.tsx` — 3-step client wizard: server config, admin account, SSE installation progress
- `src/app/api/setup/config/route.ts` — Public GET for config check, admin PUT for updates
- `src/app/api/setup/run/route.ts` — Full SSE-streamed setup: save config, create Caddy routes, create admin user, configure SSO for CP + UI, write site_name to UI DB, mark setup complete
- `src/lib/spine/client.ts` — Added `getConfig()`, `setConfig()`, `patchConfig()` methods
- `src/middleware.ts` — Added `/api/setup/config` to PUBLIC_ROUTES

**White-Labeling:**
- `src/lib/site-config.ts` — Server-side `getSiteConfig()` reads from Spine
- `src/hooks/use-site-config.ts` — Client-side `useSiteConfig()` hook
- `src/app/layout.tsx` — Dynamic `generateMetadata()` using site_name
- `src/app/login/page.tsx` — Login heading uses site_name
- `src/app/(dashboard)/settings/page.tsx` — UI section uses site_name

**Bug Fix:**
- GET `/api/setup/config` was returning 401 because the route handler had its own `getSession()` check. Removed session check from GET (public endpoint for setup-check). PUT still requires admin auth.

**Testing:**
- Deployed to dev server (192.168.31.190)
- `/api/setup/config` returns 200 with config (verified public access)
- Login page renders with dynamic title ("YouEye Control Panel")
- Setup page requires authentication (redirects to login)

---

### v0.1.59 (2026-02-10)

**Fix: Spine client timeout race**

Increased Spine Unix socket client timeout from 30s to 60s. The old timeout raced with Spine's health check loop (30s max), causing "Request timeout" when enabling UI.

**Changes:**
- `src/lib/spine/client.ts` — `req.setTimeout(60000)` (was 30000)

**Testing:**
- Deployed to dev server, full deploy passes, 7 containers running

---

### v0.1.56 (2026-02-09)

**Feature: YouEye UI Management (Phase 2)**

Automated UI container lifecycle management from the Settings page.

**Changes:**
- Settings page: Added YouEye UI section (visible when SSO configured + UI installed)
  - Domain input with auto-suggestion (ui.{domain})
  - Enable UI button: creates Authentik OAuth2, Caddy route, DB, starts service
  - Disable UI button: removes Authentik resources, Caddy route, stops service
  - Live status indicator (not-installed/installed/running)
- New API route: `/api/ui` (GET status, POST enable, DELETE disable)
- New library: `src/lib/ui/manager.ts` — full UI lifecycle management
- Spine client: added getUISSO(), setUISSO(), deleteUISSO(), updateUI() methods
- SpineStatusResponse: added `ui` field with status/installed/enabled/version/ip

**Testing:**
- Deployed to dev VM (192.168.31.190)
- Spine API returns correct UI status (installed, enabled, version, IP)
- CP Settings page bundle includes full UI management code
- API route `/api/ui` responds correctly

### v0.1.55 (2026-02-09)

**Fix: SSO Callback Redirect — All Redirects Now Use CONTROL_EXTERNAL_URL**

**Problem:**
After SSO login with Authentik, the browser was redirected to `http://0.0.0.0:3000/` instead of `https://control.skibidi.wtf/`. The v0.1.54 fix only applied `CONTROL_EXTERNAL_URL` to the OAuth2 token exchange `redirect_uri`, but the `NextResponse.redirect()` calls for navigation (success → `/`, errors → `/login?error=...`) still used `request.url` as the base URL. Inside the container, `request.url` resolves to `http://0.0.0.0:3000/...`.

**Root Cause:**
`NextResponse.redirect(new URL('/', request.url))` uses `request.url` which is `http://0.0.0.0:3000/api/auth/callback?code=...` inside the container.

**Solution:**
Compute `baseUrl` once at the top of the GET handler from `CONTROL_EXTERNAL_URL` (with forwarded-header fallback), then use it for ALL redirects — not just the token exchange redirect_uri.

**Deployment Note:**
Previous deployment used `rm -rf /opt/app/*` which doesn't remove dotfiles (`.next` directory). The old `.next` survived, causing stale compiled chunks to be served. Fixed by using `rm -rf /opt/app && mkdir -p /opt/app` to fully remove the directory including dotfiles.

**Modified Files:**
- `src/app/api/auth/callback/route.ts` — Moved `baseUrl` computation above all early returns, all `NextResponse.redirect(new URL(..., request.url))` changed to `new URL(..., baseUrl)`
- `package.json` — Version 0.1.55

**Testing (192.168.31.190):**
- `curl -sI http://10.117.96.245:3000/api/auth/callback` → `location: https://control.skibidi.wtf/login?error=Missing+code+or+state` (was `http://0.0.0.0:3000/...`)
- `spine status` → Control Panel: Running (v0.1.55)
- Process env verified: `CONTROL_EXTERNAL_URL=https://control.skibidi.wtf` present in node process

---

### v0.1.54 (2026-02-09)

**Fix: SSO Redirect URL & Authentik 2025.12 Compatibility**

**Summary:**
Fixed SSO redirect_uri going to `0.0.0.0:3000` instead of the proper subdomain. Added `CONTROL_EXTERNAL_URL` env var for explicit redirect URI control. Updated SSO setup to pass `control_url` to Spine for env injection.

**Problem:**
When the Control Panel runs inside an Incus container with `listen: 0.0.0.0:3000`, the `request.headers.get('host')` returns `0.0.0.0:3000` instead of the actual subdomain. This caused OAuth2 redirect_uri to be set incorrectly, breaking SSO login flow.

**Solution:**
Use `process.env.CONTROL_EXTERNAL_URL` (injected by Spine via systemd EnvironmentFile) as the authoritative source for the redirect URI. Falls back to request headers if env var not set.

**Modified Files:**
- `src/app/api/auth/sso/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI, fixed `secure` cookie flag to use `redirectUri.startsWith('https://')` instead of out-of-scope `proto` variable
- `src/app/api/auth/callback/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI
- `src/lib/auth/sso-setup.ts` - Pass `control_url: params.controlExternalUrl` to `spineClient.setControlSSO()`
- `src/lib/spine/client.ts` - Added `control_url: string` to `setControlSSO` params type
- `package.json` - Version 0.1.54

**Testing (192.168.31.190):**
- SSO setup successful with Authentik 2025.12
- Redirect URI: `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in SSO env file
- Auth mode correctly reports `ssoConfigured: true`

---

### v0.1.53 (2026-02-08)

**Feature: Self-Service SSO Setup via Settings Page**

**Summary:**
Complete SSO implementation allowing the Control Panel to configure its own Authentik SSO through a new Settings page UI. When accessed via IP address, login uses PAM. When accessed via subdomain, login uses Authentik SSO (no PAM option).

**How it works:**
1. Settings page checks prerequisites (domain configured, Authentik + CP subdomains in Caddy, Authentik healthy)
2. "Setup SSO" button creates OAuth2 Provider + Application in Authentik via API
3. Creates groups scope mapping for admin detection via OIDC
4. Spine stores env vars (`AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_INTERNAL_URL`) via systemd drop-in
5. CP restarts with SSO env vars loaded
6. Auth mode detection: PAM on IP access, SSO on subdomain access

**Key Design Decisions:**
- Uses Authentik 2024.12 API paths (`/propertymappings/provider/scope/`, dict-format `redirect_uris`)
- `AUTHENTIK_INTERNAL_URL` (Incus DNS `http://youeye-authentik.incus:9000`) for server-side token exchange to avoid self-signed TLS issues
- `AUTHENTIK_URL` (external URL like `https://id.skibidi.wtf`) for browser redirects
- Systemd EnvironmentFile drop-in (`sso.conf`) for clean env injection that survives CP updates

**New Files:**
- `src/lib/auth/sso-setup.ts` - Core SSO setup/teardown logic (Authentik API calls)
- `src/app/api/auth/sso/status/route.ts` - GET endpoint: SSO prerequisites and configuration status
- `src/app/api/auth/sso/setup/route.ts` - POST endpoint: Execute SSO setup
- `src/app/api/auth/sso/disable/route.ts` - POST endpoint: Disable SSO
- `src/app/(dashboard)/settings/page.tsx` - Settings page with SSO prerequisites checklist and setup/disable buttons

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added Settings nav item
- `src/lib/spine/client.ts` - Added `getControlSSO()`, `setControlSSO()`, `deleteControlSSO()` methods
- `src/lib/auth/authentik.ts` - Added `AUTHENTIK_INTERNAL_URL` for server-side calls, `groups` scope
- `src/middleware.ts` - Block PAM login on subdomain access (403), exact-match SSO public route

**Testing (192.168.31.190):**
- SSO prerequisites all met (domain, subdomains, Authentik health)
- Setup creates OAuth2 provider/app in Authentik, configures env vars
- Auth mode: `pam` on IP, `sso` on subdomain
- SSO redirect to `https://id.skibidi.wtf/application/o/authorize/` with correct params
- PAM login blocked on subdomain with 403 error
- Disable/re-enable cycle works
- Version 0.1.53 deployed and verified

---

### v0.1.51 (2026-02-08)

**Bug Fixes: Updates Page Crash, LAN Port Untick, People Create 500**

**Summary:**
Three bugs found during manual testing on user's test server, plus a backend fix discovered during verification:

1. **Bug 1 - Updates page crash**: `Cannot read properties of undefined (reading 'split')`. The TypeScript `AppInfo` interface used `container` and `image` fields, but Spine API returns `container_name` and `image_tag`. The line `app.image.split(':').pop()` crashed on undefined.
2. **Bug 2 - LAN port checkbox snap-back**: After enabling LAN port, unticking the checkbox and pressing save would visually revert to ticked. The checkbox was controlled by `state.lanEnabled` which only updated after API response, not optimistically.
3. **Bug 2b - LAN port device not removed**: Even with the frontend fix, the Incus PATCH method merges device maps and cannot delete keys. Changed to PUT with full config to properly remove the `lan-web` device.
4. **Bug 3 - People API 500 on create**: `createUser()` succeeded but `setUserPassword()` failed (Authentik password policy), causing 500 that masked successful user creation.

**Modified Files:**
- `src/lib/spine/client.ts` - Fixed `SpineUpdatesCheckResponse.apps` type: `container`→`container_name`, `image`→`image_tag`, added `available: boolean`
- `src/app/(dashboard)/updates/page.tsx` - Fixed `AppInfo` interface, replaced crash-prone `app.image.split(':').pop()` with safe `app.image_tag || 'latest'`
- `src/components/proxy/container-routing-table.tsx` - Optimistic `lanEnabled` state update on checkbox click, revert on API failure
- `src/app/api/containers/[name]/lan-port/route.ts` - Changed PATCH to PUT with full instance config (architecture, config, devices, profiles) so device removal actually works
- `src/app/api/people/route.ts` - Wrapped `setUserPassword()` in separate try/catch, returns `{ success: true, passwordWarning }` instead of 500

**Testing (192.168.31.190):**
- Updates page: returns 200, API returns correct `container_name`/`image_tag` fields
- LAN port: enable (port 8888) adds `lan-web` device, disable removes it completely
- People create: returns `{ success: true, passwordWarning }` instead of 500
- No errors in control panel logs after deployment
- v0.1.51 deployed and verified

---

### v0.1.49 (2026-02-08)

**Multi-Feature: People Tab, Proxy Simplification, Updates Apps, SSO Dual-Auth**

**Summary:**
Four major features implemented in a single release:
1. **CP1 - People Management Tab**: Full user CRUD via Authentik API. List/create/delete users, toggle admin (via "authentik Admins" group), set passwords, show/hide hidden system users.
2. **CP2 - Proxy Simplification**: Rewrote routing table to subdomain-only (removed path routing). Added LAN Port column with checkbox + port input to expose containers directly on host.
3. **CP3 - Updates Page Apps**: Extended updates page with Incus version, system packages count, and app container cards with rebuild button.
4. **CP4 - SSO Dual-Auth**: OAuth2 login via Authentik when accessed through subdomain. IP-based access uses PAM. Auto-detects mode at login.

**New Files:**
- `src/app/(dashboard)/people/page.tsx` - People management page with user table, create form, password dialog
- `src/app/api/people/route.ts` - GET (list users) and POST (create user) with admin group detection
- `src/app/api/people/[id]/route.ts` - PATCH (update user, toggle admin) and DELETE
- `src/app/api/people/[id]/password/route.ts` - POST to set user password
- `src/app/api/containers/[name]/lan-port/route.ts` - POST to add/remove Incus proxy device for LAN port
- `src/lib/auth/authentik.ts` - OAuth2 helper (buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, isSSOConfigured)
- `src/app/api/auth/sso/route.ts` - GET: initiates OAuth2 flow, redirects to Authentik
- `src/app/api/auth/callback/route.ts` - GET: OAuth2 callback, exchanges code, creates JWT session
- `src/app/api/auth/mode/route.ts` - GET: returns 'pam' or 'sso' based on Host header

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added People nav item between DNS and Updates
- `src/components/proxy/container-routing-table.tsx` - Complete rewrite: subdomain-only + LAN port column
- `src/app/(dashboard)/proxy/page.tsx` - Updated description text
- `src/app/api/containers/route.ts` - Added lanPort field with getLanPort() helper
- `src/lib/spine/client.ts` - Extended SpineUpdatesCheckResponse with incus/system/apps, added updateApp()
- `src/app/(dashboard)/updates/page.tsx` - Complete rewrite: Incus/System/App cards, rebuild button
- `src/app/api/updates/[component]/route.ts` - Unknown components now route to updateApp()
- `src/middleware.ts` - Added SSO/callback/mode to PUBLIC_ROUTES
- `src/app/login/page.tsx` - Split into Suspense wrapper + LoginContent, auth mode detection, SSO redirect

**Bug Fix (v0.1.49):**
- LAN port API now checks Incus response for errors (previously returned success even on failure)

**Testing (192.168.31.190):**
- Spine v0.1.27 + CP v0.1.49 deployed, all 7 containers running
- Auth mode API: returns `pam` for IP access, `sso` when configured
- People API: lists Authentik users with admin group detection
- LAN port: successfully adds/removes Incus proxy devices (tested on Pi-Hole port 9999)
- Updates API: returns incus v6.21, system 70 packages, 5 app containers
- Login page loads correctly (200)
- All pages accessible: /updates, /people, /proxy (200)

---

### v0.1.47 (2026-02-08)

**Authentik in Reverse Proxy Routing Table**

**Summary:**
Set `webPort: 9000` in Authentik manifest so it appears in the reverse proxy routing table on the proxy page. Also includes Authentik management page scaffolding (users, groups, stats API routes).

**Code Changes:**
- `src/lib/apps/manifest.ts` - Changed Authentik `webPort: undefined` to `webPort: 9000`
- `src/app/(dashboard)/apps/authentik/page.tsx` - NEW: Authentik management page
- `src/app/api/apps/authentik/stats/route.ts` - NEW: Authentik stats API
- `src/app/api/apps/authentik/users/route.ts` - NEW: Users API
- `src/app/api/apps/authentik/groups/route.ts` - NEW: Groups API
- `src/lib/authentik/client.ts` - NEW: Authentik API client library

**Testing (192.168.31.190):**
- CP v0.1.47 deployed, `spine update control` successful
- Containers API returns Authentik with `webPort: 9000` and `status: running`
- Three containers in proxy routing table: Control Panel (3000), Pi-Hole (80), Authentik (9000)

---

### v0.1.45 (2026-02-08)

**Security: Fetch Pi-Hole Password from Spine API**

**Summary:**
Removed hardcoded `DEFAULT_PIHOLE_PASSWORD` constant. Pi-Hole password is now fetched from Spine's `/api/pihole/credentials` API endpoint. Password changes are synced back to the host file via Spine API.

**Code Changes:**
- `src/lib/spine/client.ts` - Added `SpinePiholeCredentials` interface, `getPiholeCredentials()` (GET), `updatePiholePassword(password)` (POST)
- `src/lib/apps/secrets.ts` - Removed `DEFAULT_PIHOLE_PASSWORD = 'youeye_admin'`; `getPiholePassword()` now fetches from Spine API with systemd env fallback; `setPiholePassword()` syncs to host file via Spine API; `initializePiholePassword()` fetches from Spine if no explicit password; `hasCustomPiholePassword()` checks for empty string instead of comparing to hardcoded default

**Testing (192.168.31.190):**
- CP v0.1.45 deployed and healthy
- Spine Pi-Hole credentials API returns password
- Health check passes

---

### v0.1.44 (2026-02-09)

**PostgreSQL Management UI & SQL Console**

**Summary:**
Added full PostgreSQL management page with 4 tabs (Overview, Databases, SQL Console, Connection Info). Queries PostgreSQL via `incus exec` + psql (no npm pg dependency needed). Includes read-only SQL console for safe query execution.

**Code Changes:**
- `src/lib/postgres/client.ts` - NEW: PostgreSQL client using execShell + psql --csv. Functions: psqlQuery(), parseCSVLine(), queryReadOnly() (wraps in READ ONLY transaction), listDatabases(), getStats()
- `src/lib/incus/server.ts` - Added `incusRawGet()` for fetching exec log file content. Fixed `execCommand()` to fetch stdout/stderr from Incus log file paths instead of returning paths as content.
- `src/lib/apps/manifest.ts` - Added POSTGRES_MANIFEST (postgres:17-alpine)
- `src/lib/spine/client.ts` - Added getPostgresCredentials()
- `src/app/api/apps/postgres/stats/route.ts` - NEW: GET endpoint returning version, uptime, connections, database sizes
- `src/app/api/apps/postgres/databases/route.ts` - NEW: GET endpoint returning database list with owner, encoding, size
- `src/app/api/apps/postgres/query/route.ts` - NEW: POST endpoint for read-only SQL execution with CSRF protection
- `src/app/(dashboard)/apps/postgres/page.tsx` - NEW: 4-tab management page (Overview, Databases, SQL Console, Connection Info)
- `src/app/(dashboard)/apps/page.tsx` - Added PostgreSQL card with database icon and Manage link

**Key Decisions:**
- Used execShell + psql instead of `pg` npm package (Turbopack bundling breaks pg module resolution)
- Added incusRawGet for raw HTTP requests to Incus log endpoints (exec output stored in files, not returned inline)
- Filtered psql command tags (BEGIN, COMMIT, SET) from CSV output to prevent parser confusion
- Connected as `-U youeye` role (not default `postgres` role, since POSTGRES_USER=youeye)

**Bug Fixes (iterations v0.1.38 → v0.1.44):**
- v0.1.38: Initial implementation with `pg` npm package
- v0.1.39: Added serverExternalPackages for pg (didn't fix Turbopack issue)
- v0.1.40: Rewrote to use execShell + psql (removed pg dependency entirely)
- v0.1.41: Fixed execCommand returning log file paths instead of content (added incusRawGet)
- v0.1.42: Fixed psql connecting as wrong role (added `-U youeye`)
- v0.1.43: Fixed uptime query single-quote escaping
- v0.1.44: Filtered psql command tags from CSV output

**Testing (192.168.31.190):**
- 33/33 Playwright e2e tests passing (9 new PostgreSQL tests)
- Stats endpoint: version, uptime, connections, database sizes
- Databases endpoint: youeye + postgres databases with correct owner/encoding
- SQL Console: SELECT queries execute correctly with proper column/row parsing
- Write protection: CREATE TABLE rejected in READ ONLY transaction
- All existing Caddy/Pi-Hole/auth tests still passing

---

### v0.1.37 (2026-02-08)

**Remove install infrastructure, simplify to Spine-deployed apps**

**Summary:**
Removed all container install/deploy functionality from the Control Panel. Apps (Caddy, Pi-Hole, Postgres, Redis, Authentik) are now deployed exclusively by Spine. CP only manages already-deployed containers. Removed ~3000 lines of install code. Container firewall was later removed to allow internet access.

**Code Changes:**
- Deleted: `src/app/api/apps/install/route.ts` (315 lines) - Install API
- Deleted: `src/app/api/test/install-app/route.ts` (405 lines) - Test install API
- Deleted: `src/app/(dashboard)/apps/postgres/page.tsx` (647 lines) - Postgres management UI
- Deleted: `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik page
- Deleted: `src/app/api/apps/postgres/*` (databases, stats, users routes)
- Deleted: `src/app/api/apps/authentik/stats/route.ts`
- `src/lib/apps/manifest.ts` - Simplified from 362 to 53 lines. Only Caddy + Pi-Hole manifests. Removed OCI config generation, parseOCIImage, manifestToIncusConfig.
- `src/lib/apps/registry.ts` - Removed getRegistry, getAppInstance, isBuiltInApp, fetchRemoteRegistry
- `src/types/apps.ts` - Removed 'installing' status, PortMapping, HealthCheck, AppRegistry, InstallAppRequest
- `src/app/(dashboard)/apps/page.tsx` - Rewritten: simple 2-column card grid, no install buttons, Manage links
- `src/app/(dashboard)/proxy/page.tsx` - Removed installCaddy, shows "spine deploy" message when not deployed
- `src/app/(dashboard)/dns/page.tsx` - Removed installPihole, shows "spine deploy" message when not deployed
- `src/middleware.ts` - Removed /api/test/install-app from PUBLIC_ROUTES
- `src/components/proxy/proxy-status-card.tsx` - Removed manifest.version reference
- Removed `@playwright/test` from devDependencies (was added in error)

**Testing (192.168.31.190):**
- 24/24 Playwright e2e tests passing (standalone test suite in YouEye-Agents)
- Verified no install buttons on apps/proxy/dns pages
- Verified no postgres/authentik/redis cards on apps page
- Verified API returns exactly 2 apps (Caddy + Pi-Hole)
- Verified removed API routes return 401/404
- Container has internet access (firewall was later removed)

---

### v0.1.36 (2026-02-07)

**Fix: Pi-Hole password change, auth race condition, wildcard TLS, HTTP redirect**

**Summary:**
Fixed three Pi-Hole bugs and two Caddy HTTPS issues. Password change returned 400 due to field name mismatch. Multiple simultaneous API calls caused 429 rate-limit errors from Pi-Hole FTL. Caddy accumulated redundant per-subdomain TLS certs instead of using wildcard. HTTP did not redirect to HTTPS.

**Root Causes:**
1. `dns/page.tsx` sent `{ password: newPassword }` but backend expected `{ newPassword }`
2. `pihole-api.ts` `getSession()` had no lock - parallel requests all called `authenticate()` simultaneously, triggering Pi-Hole FTL 429 rate-limit
3. `caddy/client.ts` `ensureTLSSubject()` added individual subdomain certs even when `*.domain` wildcard existed
4. `caddy/client.ts` `ensureHTTPSConfig()` added `:80` to server listen array, causing routes to be served on both ports instead of redirecting

**Code Changes:**
- `src/app/(dashboard)/dns/page.tsx` - Fixed field name: `{ password: newPassword }` → `{ newPassword }`
- `src/lib/apps/pihole-api.ts` - Added Promise-based mutex lock to `getSession()` so only first request authenticates, others wait
- `src/lib/caddy/client.ts` - `ensureTLSSubject()`: skip adding subdomain if covered by wildcard
- `src/lib/caddy/client.ts` - `setDomain()`: clean up stale per-subdomain subjects, keep only `domain` + `*.domain`
- `src/lib/caddy/client.ts` - `ensureHTTPSConfig()`: remove `:80` from listen array, let Caddy auto-create redirect server
- `src/lib/caddy/client.ts` - Initial server creation: only listen on `:443`

**Testing (192.168.31.190):**
- Password change: 200 OK (was 400)
- 4 parallel Pi-Hole API calls: all succeeded, no 429 errors (was getting 429)
- TLS subjects cleaned to only `skibidi.wtf` + `*.skibidi.wtf` (was accumulating stale per-subdomain certs)
- Wildcard skip log: `Skipping TLS subject pihole.skibidi.wtf - covered by wildcard *.skibidi.wtf`
- HTTP redirect: 308 Permanent Redirect to HTTPS (was serving routes on port 80)
- HTTPS access: 302 from Pi-Hole (working)
- Server listeners: only `:443` (was `:443` + `:80`)

**IMPORTANT - TLS is self-signed:**
Caddy uses `module: internal` (self-signed via Caddy's internal CA), NOT Let's Encrypt. This is for local LAN only.

---

### v0.1.35 (2026-02-05)

**Fix: Pi-Hole FTL v6 API Authentication**

**Summary:** 
Fixed Pi-Hole integration to use SID URL parameter instead of Cookie header.

**Root Cause:**
Pi-Hole FTL v6+ requires the session ID (`sid`) to be passed as a URL query parameter (`?sid=xxx`), NOT as a Cookie header (`Cookie: sid=xxx`). The previous implementation used Cookie authentication which returned "Unauthorized" errors.

**Code Changes:**
- `src/lib/apps/pihole-api.ts`: NEW FILE - Complete Pi-Hole FTL v6 API client with session management
- Changed `piholeRequest()` to append `?sid=xxx` to URL instead of using Cookie header
- Updated all Pi-Hole route handlers to use new `pihole-api.ts` library

**Endpoints Updated:**
- `/api/apps/pihole/stats` - Uses `getStats()`
- `/api/apps/pihole/queries` - Uses `getQueryLog()`
- `/api/apps/pihole/dns-records` - Uses `getDNSRecords()`, `addDNSRecord()`, `removeDNSRecord()`
- `/api/apps/pihole/cname-records` - Uses `getCNAMERecords()`, `addCNAMERecord()`, `removeCNAMERecord()`
- `/api/apps/pihole/domains` - Uses `getDomainLists()`, `addDomain()`, `removeDomain()`
- `/api/apps/pihole/control` - Uses `setBlocking()`
- `/api/apps/pihole/password` - Added `clearPiholeSession()` call

**Testing:**
- Tested from dev server (192.168.31.190)
- Auth: `POST /api/auth` returns valid session with SID
- Stats with ?sid= parameter returns full summary data
- Cookie authentication confirmed NOT working (returns unauthorized)

---

### v0.1.32 (2026-02-05)

**Bug Fixes: Volume Permissions, Pi-Hole Web Server, Test API Middleware**

**Summary:** 
- Fixed Caddy volume permission issues with `shift: true`
- Fixed Pi-Hole FTL v6+ web server with `FTLCONF_webserver_port`
- Added test endpoint to PUBLIC_ROUTES to bypass JWT auth

**Root Causes:**
1. **Caddy Permission Denied:** Incus UID mapping caused `/data` to be owned by `nobody:nobody` inside container.
   Volume devices need `shift: 'true'` to enable Incus ID shifting.
2. **Pi-Hole Web Interface Down:** FTL v6+ has built-in web server but requires explicit `FTLCONF_webserver_port` env var.
3. **Test API Unauthorized:** Middleware required JWT for all routes - test endpoint uses X-Test-Secret header instead.

**Code Changes:**
- `src/lib/apps/manifest.ts`: Added `shift: 'true'` to disk device config in `manifestToIncusConfig()`
- `src/lib/apps/manifest.ts`: Added `FTLCONF_webserver_port: '80'` to Pi-Hole environment
- `src/middleware.ts`: Added `/api/test/install-app` to PUBLIC_ROUTES

**Testing:**
- Verified Caddy `/data/caddy` owned by `root:root` (not `nobody:nobody`)
- Verified Pi-Hole web interface responds on port 8080 (HTTP 302)
- Test API returns app list successfully

---

### v0.1.31 (2026-02-05)

**Feature: Test Install API Endpoint**

**Summary:** Added `/api/test/install-app` endpoint for automated app installation testing.

**Purpose:**
Provides a secure way for Iris (AI agent) to install/uninstall apps for testing without browser login.

**Security:**
- Requires `TEST_ADMIN_SECRET` environment variable (generated by Spine)
- Validates `X-Test-Secret` header against env var
- Rate limited (5 seconds between requests)
- Logged for audit trail

**API:**
```
GET /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Returns: List of available apps with status

POST /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Body: { "appName": "pihole", "action": "install" | "uninstall" }
  Returns: Success/failure status
```

**Code Changes:**
- `src/app/api/test/install-app/route.ts`: NEW FILE - Secure test endpoint

---

### v0.1.30 (2026-02-05)

**Bug Fix: Pi-Hole Password Change Using Incus REST API**

**Summary:** Rewrote Pi-Hole password change to use Incus REST API instead of shell commands.

**Root Cause:**
The `setPiholePassword()` function in `secrets.ts` was using `exec('incus config set ...')` to store the password.
This fails inside the Control Panel container because there is no `incus` binary installed - the container 
only has access to the Incus Unix socket, not the CLI tools.

**Solution:**
Changed `setPiholePassword()` to use `incusRequest()` to call the Incus REST API via Unix socket:
- Uses `PATCH /1.0/instances/youeye-pihole` to update container config.user.password
- Uses `updateInstanceState()` to restart the container after password change
- Changed `execInControl` to `execLocal` for local command execution

**Code Changes:**
- `src/lib/apps/secrets.ts`:
  - Added imports: `incusRequest`, `updateInstanceState` from `@/lib/incus/server`
  - Rewrote `setPiholePassword()` to use Incus REST API
  - Changed `execInControl` to `execLocal` for retrieving Incus configuration

**Testing:**
- Fresh `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.15 + Control Panel v0.1.30 running
- CSRF endpoint accessible
- Login page loads correctly

---

### v0.1.29 (2026-02-05)

**Bug Fix: CSRF Endpoint Blocked by Middleware**

**Summary:** Added `/api/auth/csrf` to PUBLIC_ROUTES so it can be accessed without authentication.

**Root Cause:**
The CSRF endpoint was returning 401 Unauthorized because middleware blocked unauthenticated access.

**Fix:**
Added `/api/auth/csrf` to PUBLIC_ROUTES array in middleware.ts.

**Code Changes:**
- `src/middleware.ts` - Added `/api/auth/csrf` to PUBLIC_ROUTES

**Testing:**
- CSRF endpoint returns 200 with `{"csrfToken":null}` when no cookie present
- Accessible both internally and externally

---

### v0.1.28 (2026-02-05)

**Bug Fixes: CSRF Endpoint & Pi-Hole DNS Port Binding**

**Summary:** 
1. Created missing CSRF token endpoint
2. Fixed Pi-Hole DNS port 53 conflict with Incus dnsmasq

**Issue 1: CSRF 404**
Pages were fetching `/api/auth/csrf` which didn't exist.

**Fix 1:**
Created CSRF endpoint that reads `ye-csrf` cookie and returns the token.

**Issue 2: Pi-Hole Port 53 Conflict**
Incus dnsmasq binds to bridge IP (10.x.x.x:53). Pi-Hole tried to bind to 0.0.0.0:53 which conflicted.

**Fix 2:**
- Added `getHostExternalIP()` function that reads from `HOST_IP` env var
- Added `fixPiHoleDNSBinding()` that modifies DNS proxy devices to use host external IP instead of 0.0.0.0
- Special handling for `manifest.name === 'pihole'`

**New Files:**
- `src/app/api/auth/csrf/route.ts` - Returns CSRF token from ye-csrf cookie

**Modified Files:**
- `src/app/api/apps/install/route.ts` - Added Pi-Hole DNS binding fix

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- CSRF endpoint returns 200
- Pi-Hole DNS devices will bind to HOST_IP (192.168.31.190)

---

### v0.1.27 (2026-02-05)

**Bug Fix: Pi-Hole Restart Button Not Working**

**Summary:** Added container actions (start/stop/restart) to Pi-Hole control API.

**Root Cause:**
The Pi-Hole control API only accepted `enable` and `disable` actions. When the UI sent a `restart` action, it was rejected as invalid.

**Fix:**
Added container lifecycle actions using Incus REST API:
- `start` - Start the container
- `stop` - Stop the container  
- `restart` - Restart the container (force + stateful)

**Code Changes:**
- `src/app/api/apps/pihole/control/route.ts`:
  - Added `containerAction()` helper function using `incusRequest('PUT', '/1.0/instances/.../state', {...})`
  - Added start/stop/restart to allowed actions array
  - Fixed import: now imports from `@/lib/incus/server` instead of `@/lib/incus/client`

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.27 running (Next.js 16.1.4)
- All services operational

---

### v0.1.26 (2026-02-05)

**Major Feature: Pi-Hole Enhanced Authentication & Local DNS Management**

**Summary:** Added secure password management for Pi-Hole API, persistent storage support, and Local DNS record management (A/CNAME records).

**New Features:**

1. **Secure Password Management**
   - Passwords stored in systemd environment variables (same pattern as JWT_SECRET)
   - Never exposed in logs, URLs, or container configuration
   - Admin can change password from DNS Settings tab

2. **Local DNS Records**
   - Manage A/AAAA records (domain → IP)
   - Manage CNAME records (alias → target)
   - Full CRUD from Control Panel UI

3. **Persistent Storage**
   - Pi-Hole data persists across container restarts
   - Gravity database, custom DNS records, and settings are preserved

4. **Enhanced DNS Page**
   - New "Local DNS" tab for A/AAAA and CNAME record management
   - New "Settings" tab with password management and direct Pi-Hole access link

**New Files:**
- `src/lib/apps/secrets.ts` - Secure password storage using systemd env vars
- `src/app/api/apps/pihole/password/route.ts` - GET/POST password management
- `src/app/api/apps/pihole/dns-records/route.ts` - GET/POST/DELETE A records
- `src/app/api/apps/pihole/cname-records/route.ts` - GET/POST/DELETE CNAME records

**Modified Files:**
- `src/lib/apps/manifest.ts` - Updated PIHOLE_MANIFEST with port 53 and volumes
- `src/app/api/apps/pihole/stats/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/domains/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/queries/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/control/route.ts` - Use dynamic password from secrets
- `src/app/(dashboard)/dns/page.tsx` - Added Settings and Local DNS tabs
- `scripts/postbuild.js` - Resolve symlinks to fix Windows→Linux deployment

**Build Fix:**
The postbuild script now resolves all symlinks in node_modules/ to real files. This fixes the "Cannot find module 'next'" error when deploying from Windows builds.

**Testing:**
- Deployed to dev server 192.168.31.190
- Spine v0.1.12, Control Panel v0.1.26
- Pi-Hole running and accessible

---

### v0.1.25 (2026-02-05)

**Feature: DNS Tab with Pi-Hole UI**

**Summary:** Added dedicated DNS tab to sidebar for Pi-Hole management with quick install and full management UI.

**Changes:**
- Added DNS tab to sidebar navigation
- Added DNS page at `/dns` with Pi-Hole install/management
- Overview, Query Log, and Block Lists tabs

---

### v0.1.22 (2026-02-04)

**Major Feature: Multi-App Management Pages**

**Summary:** Added management UI for core infrastructure apps: PostgreSQL, Authentik, and Pi-Hole. Also fixed critical build issue with pnpm symlinks on Windows.

**New App Pages:**
- `/apps` - Overview page with container status cards for each app
- `/apps/postgres` - PostgreSQL management: stats, databases, users
- `/apps/authentik` - Authentik management: stats, user count
- `/apps/pihole` - Pi-Hole management: stats, queries, domains, enable/disable

**New API Routes:**
- `GET /api/apps/postgres/stats` - PostgreSQL server stats
- `GET /api/apps/postgres/databases` - List databases with sizes
- `GET /api/apps/postgres/users` - List database users
- `GET /api/apps/authentik/stats` - Authentik service stats
- `GET /api/apps/pihole/stats` - Pi-Hole DNS query stats
- `GET /api/apps/pihole/queries` - Recent DNS queries
- `GET /api/apps/pihole/domains` - Whitelisted/blacklisted domains
- `POST /api/apps/pihole/control` - Enable/disable Pi-Hole

**Build Fix: pnpm Symlinks on Windows**

**Root Cause:** Windows tar creates broken symlinks when building pnpm-managed projects. The pnpm `.pnpm/node_modules/` structure uses symlinks that point to Windows paths like `//?/C:/Users/...`. When extracted on Linux, these symlinks are broken and packages like `styled-jsx`, `sharp`, etc. are missing.

**Fix:** Added `scripts/postbuild.js` that:
1. Copies `.next/static/` and `public/` to standalone (existing behavior)
2. Copies all packages from `.pnpm/node_modules/` to top-level `node_modules/`
3. This ensures all dependencies are available as real files, not broken symlinks

**Code Changes:**

*New Files:*
- `src/app/(dashboard)/apps/page.tsx` - Apps overview
- `src/app/(dashboard)/apps/postgres/page.tsx` - PostgreSQL management
- `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik management
- `src/app/(dashboard)/apps/pihole/page.tsx` - Pi-Hole management
- `src/app/api/apps/postgres/stats/route.ts` - PostgreSQL stats API
- `src/app/api/apps/postgres/databases/route.ts` - PostgreSQL databases API
- `src/app/api/apps/postgres/users/route.ts` - PostgreSQL users API
- `src/app/api/apps/authentik/stats/route.ts` - Authentik stats API
- `src/app/api/apps/pihole/stats/route.ts` - Pi-Hole stats API
- `src/app/api/apps/pihole/queries/route.ts` - Pi-Hole queries API
- `src/app/api/apps/pihole/domains/route.ts` - Pi-Hole domains API
- `src/app/api/apps/pihole/control/route.ts` - Pi-Hole control API
- `src/lib/incus/container-ip.ts` - Container IP discovery utility
- `scripts/postbuild.js` - Build fix for pnpm symlinks

*Modified Files:*
- `package.json` - Updated postbuild script to use `node scripts/postbuild.js`
- `src/components/layout/sidebar.tsx` - Added "Apps" navigation link

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Login page loads correctly
- All services running: Spine v0.1.10, Control Panel v0.1.22

**Note:** This version deployed successfully after fixing TWO bugs in Spine v0.1.10:
1. Tar extraction path (--strip-components=1)
2. Health check network isolation (incus exec curl)

---

### v0.1.21 (2026-02-04)

**Bug Fix: Route Detection for Container Routing Table**

**Summary:** Fixed a bug where the Container Routing Table displayed incorrect route information after page refresh. The UI was showing auxiliary routes (like `/favicon.ico`) instead of the main configured route.

**Root Cause:**
When detecting the current route for a container, the API used `.find()` which returns the first matching route. Path routing creates multiple routes: main route, `/_next/*`, and `/favicon.ico`. Since auxiliary routes were added with `unshift()`, they appeared first in the array and were incorrectly displayed.

**Fix:**
- Added `AUXILIARY_ROUTE_PATHS` constant to filter out `/_next/*`, `/_next`, and `/favicon.ico`
- Updated route detection logic to skip auxiliary routes when finding the "main" route

**Code Changes:**
- `src/app/api/containers/route.ts`:
  - Added `AUXILIARY_ROUTE_PATHS` constant
  - Updated route detection to filter auxiliary routes for both system containers and app manifest containers

**Testing:**
- Deployed to dev server (192.168.31.190)
- Verified subdomain route `controlpanel.skibidi.wtf` is configured correctly
- Service running successfully

---

### v0.1.20 (2026-02-04)

**Feature: Path Routing Support for Next.js Apps**

**Summary:** Added support for path-based routing with Next.js apps by creating auxiliary routes for static assets.

**Note:** Path routing still has limitations with Next.js - redirects use absolute paths. Subdomain routing is recommended.

---

### v0.1.19 (2026-02-04)

**Major Feature: Unified Proxy Configuration UI**

**Summary:** Complete redesign of the Proxy page with a unified domain configuration and container routing table. Fixes path-based routing and adds volume mounts for Caddy config persistence.

**New Features:**
1. **Domain Configuration Card** - Single input for base domain with auto-TLS
2. **Container Routing Table** - Shows all YouEye containers with web UIs
3. **Route Type Selection** - Subdomain, path, or none options per container
4. **Path Pattern Normalization** - Automatically fixes `/control` → `/control/*`

**Bug Fixes:**
1. **Path Routes Not Working** - Caddy's `*` wildcard doesn't cross path separators. Fixed by normalizing path patterns to include trailing `/*`
2. **Config Not Persisting** - Added Incus volume mounts for Caddy's `/config` and `/data` directories (requires Caddy reinstall to activate)

**New API Endpoints:**
- `GET /api/containers` - Lists containers with web UIs available for routing
- `GET/POST /api/domain` - Get/set the base domain for routing
- `POST /api/containers/[name]/route` - Set container routing (subdomain/path/none)

**Code Changes:**

*New Files:*
- `src/app/api/containers/route.ts` - Container listing endpoint
- `src/app/api/containers/[name]/route/route.ts` - Route assignment endpoint
- `src/app/api/domain/route.ts` - Domain configuration endpoint
- `src/components/proxy/container-routing-table.tsx` - New routing table component
- `src/components/ui/select.tsx` - Radix Select component

*Modified Files:*
- `src/lib/caddy/client.ts`:
  - Added `normalizePathPattern()` - Ensures `/path/*` format
  - Updated `formDataToRoute()` and `addRoute()` to return warnings
  - Added `setContainerRoute()`, `getConfiguredDomain()`, `setDomain()`
- `src/lib/apps/manifest.ts`:
  - Added `volumes` to CADDY_MANIFEST for `/config` and `/data`
  - Added `webPort` field to all manifests
  - Updated `manifestToIncusConfig()` to handle volumes
- `src/types/apps.ts`:
  - Added `volumes` and `webPort` to AppManifest interface
- `src/app/api/apps/install/route.ts`:
  - Added `ensureHostDirectories()` for volume mount directories
- `src/app/(dashboard)/proxy/page.tsx`:
  - Removed old TLSCard/RouteList/RouteFormDialog
  - Added domain input card and ContainerRoutingTable
- `package.json`:
  - Added `@radix-ui/react-select` dependency
  - Version: 0.1.18 → 0.1.19

**Technical Details:**

*Path Pattern Normalization:*
```typescript
// Input: /control → Output: /control/*
function normalizePathPattern(pattern: string): { pattern: string; modified: boolean }
```
Caddy's `*` wildcard matches any characters BUT doesn't cross `/` separators.
- `/control*` matches `/controlABC` but NOT `/control/dashboard`
- `/control/*` matches `/control/dashboard`

*Container Route Assignment:*
```typescript
setContainerRoute(domain, containerName, port, routeType, routeValue)
// routeType: 'subdomain' | 'path' | 'none'
// Example path: domain=skibidi.wtf, routeValue=/control → skibidi.wtf/control/*
```

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- `/api/containers` returns containers with webPort correctly
- `/api/domain` returns configured domain (skibidi.wtf)
- Path route `/control` normalized to `/control/*` in Caddy config
- Route works: `curl -k https://skibidi.wtf/control/` returns 307 redirect
- Caddy includes rewrite handler to strip path prefix before forwarding

**Notes:**
- Volume mounts require Caddy reinstall to activate (existing Caddy won't have them)
- Host authentication uses Spine API's `/api/auth/verify` (PAM on host, not container)
- Default host root password: set via `chpasswd` on host

---

### v0.1.18 (2026-02-04)

**Bug Fix: Admin groups not passed to isAdmin check during login**

**Root Cause:** The login route was calling `getUserGroups(username)` which always returned `[]`, then calling `isAdmin(username)` without the groups. This meant only `root` users were recognized as admin, even though users like `youeye` are in the `sudo` group.

**Fix:** Use `authResult.groups` from PAM authentication result and pass to `isAdmin(username, groups)`.

**Code Changes:**
- `src/app/api/auth/login/route.ts` - Use groups from auth result, remove unused getUserGroups import

**Testing:**
- Deployed to dev server 192.168.31.190
- User `youeye` (in sudo group) should now be recognized as admin after re-login

**Note:** Users must log out and log back in to get a new session with the correct admin status.

---

### v0.1.17 (2026-02-04)

**Bug Fix: Static Files Missing in Standalone Build**

**Root Cause:** Next.js standalone output doesn't automatically copy `.next/static/` and `public/` folders. CSS/JS files were returning 404 or being served with `text/plain` MIME type, causing browsers to refuse loading them with strict MIME checking.

**Fix:** Added `postbuild` script to copy static files into standalone folder.

**Code Changes:**
- `package.json` - Added postbuild script: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`
- `package.json` - Build script now explicitly runs postbuild: `next build && pnpm run postbuild`
- Version bump: 0.1.16 → 0.1.17

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Verified CSS returns `Content-Type: text/css; charset=UTF-8`
- Verified JS returns `Content-Type: application/javascript; charset=UTF-8`  
- Verified fonts return `Content-Type: font/woff2`
- No MIME type errors in browser console

**Note for Windows builds:** The `cp` command doesn't work on Windows. Use PowerShell:
```powershell
Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static"
Copy-Item -Recurse -Force "public" ".next\standalone\public"
```

---

### v0.1.16 (2026-02-04)

**Changes:**
- Secured Caddy Admin API: removed external port 2019 exposure
- Added route ordering by specificity (sortRoutes function)
- Enhanced TLS automation for hostname handling
- Added request timeout (10s) and retry logic with exponential backoff
- Added route verification after config application
- Improved initial Caddy config generation
- Added comprehensive logging for Caddy operations

**Code Changes:**
- `src/lib/apps/manifest.ts` - Removed adminPort from CADDY_MANIFEST
- `src/lib/caddy/client.ts` - Major refactoring with timeout/retry, sorting, verification
- `package.json` - Version bump

**Testing:**
- Deployed to dev server 192.168.31.190
- Verified port 2019 NOT exposed externally (SECURE)
- Verified internal Caddy API access works
- HTTP/HTTPS ports working

---

## Architecture Notes

### Caddy Integration
- Control Panel communicates with Caddy via Incus DNS: `http://youeye-caddy.incus:2019`
- Admin API NOT exposed to host network (security requirement)
- Caddy configured to bind admin API to `0.0.0.0:2019` inside container
- Config persistence via `--resume` flag: auto-saves to `/config/caddy/autosave.json`, reloads on restart
- No `/config` volume mount — Caddy uses its internal container filesystem for XDG_CONFIG_HOME
- `/data` volume mounted for TLS certificate persistence across container recreation

### Key Files
- `src/lib/caddy/client.ts` - Caddy Admin API client
- `src/lib/caddy/types.ts` - TypeScript types for Caddy config
- `src/lib/apps/manifest.ts` - App manifests including Caddy
- `src/app/api/caddy/*` - API routes for Caddy management

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Playwright Testing](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Playwright-Testing)** — **MANDATORY** browser testing for all Control Panel changes
- **[Control Panel](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Control-Panel)** — Complete Control Panel documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning

## v0.2.13.4 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix Cinema isCinema check — wrong app ID 'ye-cinema' → 'cinema'

### Changes
- `src/components/market/install-dialog.tsx` — fixed `app.id === 'ye-cinema'` to `app.id === 'cinema'`

### Test Results
- Deployed and confirmed v0.2.13.4 on JohnVM

### Notes for Iris
- No migrations. One-line fix only.

## v0.2.13.3 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix Cinema install wizard — add TMDB API Key input field to InstallDialog

### Changes
- `src/components/market/install-dialog.tsx` — Added `tmdbApiKey` state, conditional TMDB API Key input (password type) shown when `app.id === 'ye-cinema'`, install button disabled when Cinema is selected and key is empty, `installParams: { tmdbApiKey }` passed in `onInstall` config
- `package.json` — Bumped to 0.2.13.3

### Test Results
- pnpm build: success, 0 TypeScript errors
- spine update control: v0.2.13.3 confirmed deployed on johnvm (7 containers running)
- Cinema not currently installed on johnvm — clean state for Vlad QA
- UI fix confirmed: InstallDialog now collects and passes TMDB API Key for Cinema

### Notes for Iris
- No migrations. Pure UI fix in InstallDialog component.
- The v0.2.13.2 fix correctly wired installParams through the backend (installer.ts + API routes), but the frontend dialog never collected the key — this release closes the loop.
- Vlad should test: open market page, click Install on Cinema, verify TMDB API Key field appears, verify Install button disabled when empty, enter a key, install, confirm `incus exec ye-app-cinema -- env | grep TMDB_API_KEY` shows the provided value.

## v0.2.13.2 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** BUG-030 fix — installCinema() collect and write TMDB API key from install wizard

### Changes
- `src/lib/native-apps/installer.ts` — installCinema() now reads `config.installParams?.tmdbApiKey` and writes `TMDB_API_KEY=<value>` to `/etc/ye-app-cinema.env`. Emits a warning if key is empty at install time (non-blocking). Install button in YE-UI is disabled when TMDB key is blank.
- `package.json` — Bumped to 0.2.13.2

### Test Results
- pnpm build: success, 0 TypeScript errors
- spine update control: v0.2.13.2 confirmed deployed on johnvm
- YE-UI market page: Cinema shows as installed (Uninstall button visible), market loads correctly
- Deployed bundle verified: `/opt/youeye-ui/.next/server/chunks/7368.js` contains `tmdbApiKey":"TMDB API Key"` and `tmdbApiKeyPlaceholder":"Enter your TMDB API key"` — UI prompt is deployed
- Screenshots: Tests/John/20260401_2/

### Notes for Iris
- BUG-030 fix: TMDB API key is now collected from install wizard and written to env file
- TMDB content could NOT be verified end-to-end in this session — no live TMDB API key was available
- The installer fix ensures the key is properly collected and written to `/etc/ye-app-cinema.env`
- Content verification (homepage TMDB carousels, search results, movie cards) should be done by Vlad during QA with a real TMDB API key
- Cinema is already installed on johnvm from v0.2.13.1 — Vlad should re-install to test key collection flow

## v0.2.13.1 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Add Cinema app installer and catalog support

### Changes
- `src/lib/native-apps/catalog.ts` — Added ye-cinema/cinema entries to nativeContainerName() and nativeGiteaRepo() maps
- `src/lib/native-apps/installer.ts` — Added installCinema() (8-step installer: postgres, SSO, LXD, env, health, caddy, metadata), dispatcher case for ye-cinema, ye-cinema to ssoSlugMap, PostgreSQL cleanup in uninstallNativeApp
- `package.json` — Bumped to 0.2.13.1

### Test Results
- pnpm build: success, 0 TypeScript errors
- spine update control: updated to 0.2.13.1
- Cinema install API: all 8 steps succeeded on johnvm

### Notes for Iris
- No migration or breaking change
- New installCinema() follows exact same 8-step pattern as installNotes()

## v0.2.9.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 5 QA bugs from v0.2.9 (BUG-021 through BUG-025)

### Changes
- `src/app/setup/page.tsx` — BUG-021: Detect ye-setup-language cookie on page load to skip past language selection after reload; avoids infinite language step loop
- `src/app/api/setup/language/route.ts` — BUG-021: Set cookie httpOnly=false so client JS can detect it
- `src/lib/caddy/client.ts` — BUG-022: New ensurePingRoute() adds /api/ping at route position 0 (before host-matched routes) so Spine health checks work on any domain
- `src/app/api/setup/run/route.ts` — BUG-022: Call ensurePingRoute during setup wizard Caddy step
- `src/lib/infrastructure/deployer.ts` — BUG-022: Call ensurePingRoute in both deploy and reconcile paths (including when Caddy is already running)
- `src/lib/native-apps/installer.ts` — BUG-023: Add trailing newline to all env file writes (wiki, search, notes) to prevent line concatenation
- `src/lib/health/service.ts` — BUG-024: Add 1-retry with 1s delay to Authentik, Caddy, and Spine health checks to reduce transient false positives
- `src/lib/market/installed-apps.ts` — BUG-025: Replace 'su - postgres -c "psql..."' with 'psql -U youeye' directly (BusyBox su incompatibility)
- `package.json` — version bump to 0.2.9.1

### Test Results
- Build: successful standalone tarball (242MB)
- BUG-022: curl -sk https://johnvm.test/api/ping returns {"status":"ok"}
- BUG-025: installed_apps table exists (verified via psql -U youeye)
- All 7 containers RUNNING

### Notes for Iris
- BUG-022 fix adds a Caddy route at position 0 without host matcher; this is intentional to override host-matched routes for /api/ping
- BUG-025 fix uses psql -U youeye instead of su postgres; all future psql calls should use this pattern for BusyBox compatibility
- BUG-023 fix adds trailing newline to ALL native app env writes; existing malformed env files will be fixed on next app reinstall

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Search engine detection in installer + catalog cache resilience + dynamic native app discovery

### Changes
- `src/lib/native-apps/installer.ts` — detectSearchEngine() checks installed_apps DB + install.json metadata; installSearch() writes SEARCH_ENGINE_TYPE + SEARCH_ENGINE_URL env vars; step count increased from 7 to 8
- `src/lib/market/catalog.ts` — catalog cache persistence at /var/lib/youeye/catalog-cache.json; fetchCatalog() saves to disk on success, loads from cache on failure; getNativeApps() filters catalog by type: native; getCatalogCacheAge() for UI display; refreshCatalog() for manual refresh
- `src/lib/market/schema.ts` — CatalogEntrySchema extended with optional type field (native | marketplace)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- catalog.yaml now has type: native entries for wiki and search — CatalogEntrySchema accepts optional type with default 'marketplace'
- /var/lib/youeye/catalog-cache.json is created at runtime — no migration needed

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Improved setup wizard + language propagation + install from URL

### Changes
- `src/app/setup/page.tsx` — Complete rewrite: language selection as Step 0 (5 languages with flags), step progress indicator ("Step N of M" with stepper), smooth fade/slide transitions (200ms), contextual help expandable per step, mobile-friendly layout
- `src/app/setup-complete/page.tsx` — Confetti animation on completion, personalized welcome message, quick start links (dashboard, marketplace, docs)
- `src/app/api/setup/language/route.ts` — New endpoint: stores setup language in cookie for pre-setup i18n resolution
- `src/i18n/request.ts` — Added ye-setup-language cookie resolution before system/user language
- `src/lib/language/service.ts` — New LanguageService: propagateLanguageToAll() cascades to Authentik locale, app container env vars via Incus API
- `src/app/api/ui-bridge/user/language/route.ts` — New bridge endpoint: PATCH triggers full language propagation pipeline
- `src/app/api/market/validate-url/route.ts` — New endpoint: SSRF-safe manifest URL validation (HTTPS only, blocks RFC1918 IPs)
- `src/app/api/market/install-url/route.ts` — New endpoint: SSE install from URL with audit logging
- `src/components/market/install-from-url-dialog.tsx` — New dialog: URL input, manifest preview with capabilities, subdomain config, SSE install progress
- `src/app/(dashboard)/market/page.tsx` — Added "Install from URL" button in marketplace header
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSource() for URL source tracking (source + source_url columns)
- `messages/*.json` — New i18n keys for setup wizard (stepOf, help texts) and setup-complete (welcomeUser, quickStart) in all 5 locales

### Test Results
- Build: Both YE-ControlPanel and YE-UI build successfully
- Deploy: lisavm running v0.2.8.1, 7 containers running, 0 stopped

### Notes for Iris
- New DB columns: installed_apps.source (TEXT) and installed_apps.source_url (TEXT) — added via ALTER TABLE IF NOT EXISTS, safe for existing data
- New i18n keys in all 5 locale files — merge carefully if other agents added keys in the same section
- YE-UI has a new PATCH handler in admin proxy catch-all — needed for language propagation bridge calls
## v0.2.7.1 — john — 2026-03-30 (bugfix update)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 4 bugs from Cycle 2 testing (BUG-016, BUG-017, BUG-018, BUG-019)

### Changes
- `src/middleware.ts` — BUG-016: When setup is complete and accessed via IP+Caddy, let request through instead of redirecting to /setup-complete interstitial. BUG-017: Added /api/ping to PUBLIC_ROUTES.
- `src/app/api/ping/route.ts` — BUG-017: New unauthenticated health-check endpoint for Spine post-update verification. Returns `{"status":"ok"}`.
- `messages/en.json`, `ru.json`, `de.json`, `es.json`, `fr.json` — BUG-018: Added missing i18n keys `market.builtForYouEye` and `market.orphanScanPrompt` to all 5 locale files.
- `src/lib/health/service.ts` — BUG-019: Pi-Hole health check switched from HTTP API (returns 401 in v6) to exec-based `pihole status`. PostgreSQL check switched from `su - postgres` (fails with BusyBox) to `pg_isready`. Restructured health dispatch for clarity.

### Test Results
- /api/ping returns 200 without auth (verified via curl through Caddy)
- pihole status and pg_isready both work inside containers
- CP starts and runs correctly after deploy

### Notes for Iris
- /api/ping is a new public route — no auth required, by design
- Health check for Pi-Hole now uses exec-based approach (container name, not IP)
- Health check for PostgreSQL uses pg_isready instead of psql via su
- Caddy health check unchanged (was already working correctly)

## v0.2.7.1 — john — 2026-03-30
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cycle 2 polish fixes + LXD update path mismatch (BUG-012)

### Changes
- `src/lib/health/service.ts` — CPU delta-sampling: in-memory map tracks cumulative nanoseconds, computes real CPU % between polls. Spine returns cpuPercent: -2 (N/A). First poll returns -1 (no baseline).
- `src/app/(dashboard)/health/page.tsx` — Added CPU % display with Cpu icon alongside memory bar. Shows N/A for Spine, dash for first poll.
- `src/app/api/market/route.ts` — New: GET /api/market convenience route (re-exports catalog handler)
- `src/lib/native-apps/installer.ts` — installSearch() now calls saveInstallMetadata() (was missing). Uninstaller now removes Authentik OAuth2 for search. Both installers detect previous keepData installs.
- `src/lib/apps/lxd-updater.ts` — Added getServiceWorkingDir() helper using systemctl show. updateLXDApp() resolves real WorkingDirectory from systemd before file operations. Emits SSE note when paths differ (BUG-012 fix).
- `src/lib/apps/lxd-updates.ts` — getLxdAppVersion() fallback now uses systemctl show instead of grep for consistency with lxd-updater.
- `package.json` — Version bump to 0.2.7.1

### Test Results
- Playwright: 4 screenshots, 2 tests passed
- Screenshots: Tests/John/20260330_1/

### Notes for Iris
- Health dashboard cpuPercent field added to ServiceHealth interface — frontend and API both updated
- LXD updater path resolution is backward-compatible: if systemctl show fails, falls back to configured appDir
- installSearch() metadata fix ensures uninstall works correctly for search app

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — CP orchestrator, SSE progress, backup page, manifest backup schema

### Changes
- `src/lib/backup/types.ts` — backup types: config, events, manifest backup section, app backup plan
- `src/lib/backup/service.ts` — backup orchestrator: enumerate targets, dump PostgreSQL, call Spine, poll status
- `src/app/api/backup/run/route.ts` — SSE endpoint for triggering and streaming backup progress
- `src/app/api/backup/status/route.ts` — polls Spine for current backup status
- `src/app/(dashboard)/backup/page.tsx` — backup configuration and progress UI page
- `src/lib/spine/client.ts` — startBackup() and getBackupStatus() methods
- `src/lib/market/schema.ts` — BackupSchema: stopOrder, startOrder, ownPostgres, volumes, exclude
- `src/lib/market/types.ts` — BackupSpec type export
- `src/components/layout/sidebar.tsx` — added Backup navigation item
- `messages/{en,ru,fr,es,de}.json` — i18n for Backup sidebar label
- `package.json` — version bump to 0.2.7.1

### Test Results
- CP backup status endpoint responds correctly (requires auth)
- Full backup pipeline tested via Spine API: archive created, encrypted, decryptable
- Platform healthy after deploy: 7 running, 0 stopped

### Notes for Iris
- New lib/backup/ directory with service and types
- New API routes: /api/backup/run (SSE), /api/backup/status
- New page: /backup in dashboard sidebar
- Manifest schema extended with optional backup: section
- No database migrations needed

## v0.2.7.1 — ben — 2026-03-30
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** App version pinning + system health notifications

### Changes
- `src/lib/market/installed-apps.ts` — New installed_apps PostgreSQL table: CRUD, migration from install.json, update detection via version comparison
- `src/lib/market/version-checker.ts` — Background job (6h cycle): compare installed vs catalog versions, track update availability
- `src/lib/market/schema.ts` — Added `version` field to AppManifestSchema, `latestVersion` to CatalogEntrySchema
- `src/lib/market/types.ts` — Added `version` to MarketApp, `installedVersion` to InstallMetadata
- `src/lib/market/catalog.ts` — Include `version` in manifestToMarketApp conversion
- `src/lib/market/engine.ts` — Save installedVersion to both install.json and installed_apps DB on install
- `src/lib/market/uninstaller.ts` — Remove from installed_apps DB on uninstall
- `src/lib/health/monitor.ts` — Background health monitor (60s cycle): service state transitions, disk/memory/cert/update alerts
- `src/lib/health/notification-bridge.ts` — CP-to-UI notification delivery via bridge token auth
- `src/lib/health/index.ts` — Exported monitor and bridge modules
- `src/app/api/ui-bridge/notifications/route.ts` — New POST endpoint for creating notifications in YE-UI
- `src/app/api/ui-bridge/market/route.ts` — Added updates, installed-versions, refresh-catalog actions with version data
- `src/app/api/health/services/route.ts` — Side-effect imports to start monitor and version checker
- `package.json` — Bumped to 0.2.7.1

### Test Results
- Build: TypeScript compilation passes
- Screenshots: Tests/Ben/20260330_1/

### Notes for Iris
- New `installed_apps` PostgreSQL table is auto-created on first use (no manual migration needed)
- install.json files are migrated to DB on first boot — keep both during transition
- Health monitor sends notifications to all admin users via bridge token
- YE-UI notification POST route now accepts bridge token auth (not just session cookies)
- Version checker runs 45s after startup (after update-cache at 30s)

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** SMTP email configuration + user avatar bridge endpoint

### Changes
- `src/app/(dashboard)/settings/page.tsx` — SMTP settings card: host, port, username, password, from, TLS toggle, test button, status display
- `src/app/api/settings/smtp/route.ts` — GET/POST SMTP config (non-sensitive fields via SettingsService, password to secrets file)
- `src/app/api/settings/smtp/test/route.ts` — POST send test email via configured SMTP to admin address
- `src/app/api/ui-bridge/user/avatar/route.ts` — Bridge endpoint: receive multipart avatar from YE-UI, sync to Authentik via set_avatar API
- `src/lib/settings/service.ts` — Extended PlatformSettings with smtpHost, smtpPort, smtpFrom, smtpUsername, smtpRequireTls; KEY_MAP/REVERSE_KEY_MAP updated
- `src/lib/smtp/authentik-sync.ts` — Patch Authentik email stage and brand with SMTP credentials after save
- `src/lib/smtp/mailer.ts` — nodemailer wrapper for test email sending
- `src/lib/smtp/secrets.ts` — Read/write SMTP password to /var/lib/youeye/control/.secret_smtp_password (0600)
- `src/lib/market/variables.ts` — Added smtp.* namespace: host, port, username, password, from, tls, configured
- `src/lib/market/engine.ts` — Inject smtp.* vars for apps with capabilities.smtp: true
- `src/lib/market/types.ts` — Added smtp capability to CapabilitiesSchema
- `messages/{en,ru,de,es,fr}.json` — SMTP i18n keys
- `package.json` — bumped to 0.2.6.1

### Test Results
- Playwright: 5 tests, 5 passed — CP landing loads, CP settings has SMTP section, UI SSO login, UI profile avatar section, Avatar API endpoint
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- SMTP password stored at /var/lib/youeye/control/.secret_smtp_password — ensure volume persists across CP updates
- Avatar bridge uses multipart/form-data — Authentik set_avatar API receives the file directly
- smtp.* namespace resolves empty strings when SMTP not configured — apps install fine without it

---

---

 HEAD

## v0.2.6.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Unified app market + app lifecycle management

### Changes
- `src/lib/market/schema.ts` — Add `type` field (native/marketplace), `NativeConfigSchema`, make `containers` optional for native apps, add `native` category to metadata
- `src/lib/market/types.ts` — Add `type` to `MarketApp`, add `UninstallOptions`, `UninstallVerification`, `OrphanResource` types, add `NativeConfig` type
- `src/lib/market/catalog.ts` — Include `type` in `manifestToMarketApp()` conversion
- `src/lib/market/authentik.ts` — Export `getAuthentikConfig()` and `authentikAPI()` for orphan detector
- `src/lib/market/uninstaller.ts` — Complete rewrite: unified for marketplace + native, Pi-Hole DNS cleanup, keepData option, post-uninstall verification
- `src/lib/market/orphan-detector.ts` — New: detect orphaned Caddy routes, Authentik apps, PostgreSQL DBs, containers, volume dirs
- `src/lib/native-apps/catalog.ts` — Remove hardcoded `NATIVE_APP_CATALOG`, keep only utility functions (`nativeContainerName`, `nativeGiteaRepo`)
- `src/lib/native-apps/installer.ts` — Save `InstallMetadata` after wiki install for unified tracking
- `src/app/api/market/install/route.ts` — Unified: routes to native installer for `type: native`
- `src/app/api/market/uninstall/route.ts` — Accept `keepData` param, use options object
- `src/app/api/market/status/route.ts` — Include native app containers in status (pre-migration support)
- `src/app/api/market/catalog/route.ts` — Comment update (unified)
- `src/app/api/admin/orphans/route.ts` — New: GET detects orphans, POST cleans up
- `src/app/api/ui-bridge/market/route.ts` — Fix uninstaller call signature
- `src/app/(dashboard)/market/page.tsx` — Unified: single app grid, "Built for YouEye" section, orphan section, uninstall dialog
- `src/components/market/app-card.tsx` — Add "YouEye" badge for native apps, add BellRing/Shield icons
- `src/components/market/uninstall-dialog.tsx` — New: keep-data/delete-all confirmation dialog
- `src/components/market/orphan-section.tsx` — New: orphan scan + cleanup UI
- `src/app/api/market/native/` — **Deleted** (3 route files): functionality moved to unified routes
- `package.json` — Bump to 0.2.6.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/Ben/20260329_3/
- /api/market/catalog returns 9 apps (2 native + 7 marketplace)
- /api/market/native correctly returns 404
- /api/admin/orphans detected 3 orphans from previous installs
- Unified market page renders with "Built for YouEye" section

### Notes for Iris
- `/api/market/native/*` routes removed — any UI or bridge code referencing these needs updating
- `uninstallApp()` signature changed from `(appId, boolean)` to `(appId, options)` — already fixed in ui-bridge
- Native app IDs in manifests are `wiki`/`search` (not `ye-wiki`/`ye-search`) — native installer maps them internally
- AppMarket repo needs the matching `ben` branch merged for manifests to be available on `dev`/`main`

---

 HEAD
## v0.2.6.1 — john — 2026-03-29 (resume: Playwright tests)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Setup wizard hardening — Playwright test suite (resume session)

### Changes
- No new code changes — test files only (stored locally in Tests/John/20260329_2/)

### Test Results
- `setup-wizard-partial-resume.spec.ts` — PASS (State A: setup completed in background, Go link visible, resume correctly reflected)
- `setup-wizard-double-run.spec.ts` — PASS (Run 1 completed with DNS retry failure visible + Retry button; Run 2 redirected to /setup-complete without errors)
- `cycle0-full.spec.ts` — PASS (SSO login, theme switching, API v1 paths, settings page, login error page)
- Total screenshots: 36 across all 3 test sessions
- Videos: recorded for each test run (test-results/)
- BUG-011 verified RESOLVED — no duplicate Authentik providers on re-run, DNS failure visible (not silent)
- Screenshots: Tests/John/20260329_2/

### Notes for Iris
- No new build needed — code unchanged from previous session (john-v0.2.6.1)
- Setup wizard hardening fully tested and verified

---

## v0.2.6.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Search native installer to Control Panel

### Changes
- `src/lib/native-apps/installer.ts` — Added `installSearch()` (7-step: secrets, Authentik OAuth2, LXD deploy, env file, health check, Caddy route, done); updated `installNativeApp()` dispatcher to route `ye-search` appId
- `src/lib/native-apps/catalog.ts` — Set `supportsSSO: true` for ye-search (was false)
- `package.json` — bumped to 0.2.6.1

### Test Results
- YE-App-Search installed successfully on mikevm.test via CP marketplace
- 7-scenario Playwright test suite passed for Search app (see YE-App-Search AGENTS.md)
- Screenshots: Tests/Mike/20260329_2/

### Notes for Iris
- installSearch() follows same pattern as installWiki() — Authentik OAuth2 client creation, LXD container deploy, env file, Caddy route
- Whoogle must be installed first (container: app-whoogle.incus) — Search connects to it via WHOOGLE_URL env var
- WHOOGLE_URL default in Search app code is `http://app-whoogle-main.incus:5000` but installer sets correct container name

---

## v0.2.6.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Platform Health Dashboard + Setup Wizard Hardening (BUG-011)

### Changes
- `src/lib/health/service.ts` — Health check service querying 5 services via Incus state + per-service endpoints
- `src/lib/health/index.ts` — Health module exports
- `src/app/api/health/services/route.ts` — GET /api/health/services endpoint
- `src/app/api/health/services/[slug]/restart/route.ts` — POST restart endpoint per service
- `src/app/(dashboard)/health/page.tsx` — Health dashboard page with service cards, status badges, memory bars
- `src/app/(dashboard)/page.tsx` — Added compact health dots row + degraded service banner
- `src/components/layout/sidebar.tsx` — Added Health link with HeartPulse icon
- `src/app/api/setup/run/route.ts` — Full idempotency rewrite: check-before-create, 3-retry DNS, per-step persistence
- `src/app/api/setup/steps/route.ts` — GET/DELETE setup step state API for resume/retry
- `src/app/setup/page.tsx` — Added retry button per failed step, connectivity indicators, resume support
- `messages/{en,ru,de,es,fr}.json` — Added health + sidebar i18n keys
- `package.json` — Version bump to 0.2.6.1

### Test Results
- Playwright: health page renders with all 5 service cards, dashboard health dots visible
- Screenshots: Tests/John/20260329_1/screenshots/

### Notes for Iris
- New health page at /dashboard/health — no migrations needed
- Setup wizard hardening (BUG-011): setup_steps field added to youeye.yaml — backward compatible
- Merge before any other CP changes — contains setup wizard rewrite

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Update native app YOUEYE_API_URL to /api/v1 path

### Changes
- `src/lib/native-apps/installer.ts` — YOUEYE_API_URL env var now includes /v1 suffix
- `package.json` — bumped to 0.2.5.1

### Test Results
- Tested as part of YE-UI deployment — CP updated to 0.2.5.1 successfully

### Notes for Iris
- Merge with YE-UI (john first). Native apps installed after this change will get the correct v1 URL.

---
## v0.2.5.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Authentik named server ID + notification infrastructure (ntfy + capabilities)

### Changes
- `src/app/setup/page.tsx` — Add "Identity Provider Name" field to setup wizard Step 0 with auto-default "${siteName} ID"
- `src/app/api/setup/run/route.ts` — Store authentik_name in config, set Authentik brand title, rename UI OAuth2 from "${siteName} UI" to "${siteName}"
- `src/app/(dashboard)/settings/page.tsx` — Add Identity Provider settings card for post-setup renaming
- `src/app/api/settings/identity-provider/route.ts` — New API: update authentik_name in config + Authentik brand title
- `src/app/api/setup/reconfigure/route.ts` — Accept authentik_name in reconfigure flow
- `src/lib/reconfigure/index.ts` — Add authentik_name to ReconfigureRequest and patchConfig
- `src/lib/market/types.ts` — Extend VariableContext with authentik.name and ntfy namespace, add Capabilities type
- `src/lib/market/variables.ts` — Add ntfy and authentik.name to variable resolver
- `src/lib/market/schema.ts` — Add CapabilitiesSchema and "system" category to metadata
- `src/lib/market/engine.ts` — Populate authentik.name from config, populate ntfy context for apps with push capability
- `messages/{en,de,es,fr,ru}.json` — i18n keys for authentikName, identityProvider

### Test Results
- Build: pnpm build passes, standalone.tar created (236MB)
- Playwright: 5/5 tests pass (CP landing, config API, SSO login + settings navigation, ntfy manifest, Memos capabilities)
- Screenshots: Tests/Lisa/20260329_1/ (10 screenshots including settings page with Identity Provider section)
- Identity Provider section confirmed visible at `control.lisavm.test/settings` with "YouEye ID" default value

### Notes for Iris
- Merge Lisa AFTER Mike if Mike modifies SettingsService — Lisa uses direct spineClient.patchConfig
- New "system" category in metadata schema — existing apps use search/social/productivity/media
- CapabilitiesSchema is optional and backward-compatible — existing manifests pass without it
- authentik_name field in youeye.yaml is new — Spine will store it transparently via patchConfig
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Settings Service Foundation + User Identity Foundation (setup wizard names)

### Changes
- `src/lib/settings/service.ts` — New SettingsService class with typed getAll/get/set/getRaw/setRaw/invalidate + 5s cache
- `src/lib/settings/index.ts` — Re-export barrel
- `src/app/api/settings/route.ts` — New admin-only GET/PATCH endpoint for typed platform settings
- `src/lib/site-config.ts` — Migrated from spineClient.getConfig() to settingsService.getRaw()
- `src/lib/reconfigure/index.ts` — 3 getConfig + 1 patchConfig migrated to settingsService
- `src/app/api/ui-bridge/config/route.ts` — Migrated GET/PATCH to settingsService
- `src/app/api/ui-bridge/language/route.ts` — Migrated to settingsService
- `src/app/api/setup/config/route.ts` — Migrated to settingsService
- `src/app/api/setup/run/route.ts` — Migrated patchConfig + added firstName/lastName to admin creation
- `src/app/api/domain/route.ts` — Migrated to settingsService
- `src/lib/market/catalog.ts` — Migrated to settingsService
- `src/lib/infrastructure/lxd-deployer.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updater.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updates.ts` — Migrated to settingsService
- `src/app/setup/page.tsx` — Added firstName/lastName fields to setup wizard Step 1
- `messages/*.json` — Added firstName/lastName i18n keys (all 5 languages)

### Test Results
- Playwright: 4 tests, all passed
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- CP dashboard, settings API, UI SSO login, profile settings page all verified

### Notes for Iris
- spineClient.getConfig/patchConfig still exist as transport — DO NOT remove
- New /api/settings endpoint is admin-only (getSession check)
- Setup wizard now sends admin_first_name/admin_last_name in POST body
- Merge Mike AFTER John if John adds /api/v1/ routes

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `src/lib/apps/lxd-updates.ts` — `getLxdAppLatestVersion()` now compares branch winner vs main winner and returns whichever is newer
- `src/lib/apps/lxd-updater.ts` — `getLatestRelease()` same fix: compare both, pick newer
- `src/lib/infrastructure/lxd-deployer.ts` — Python download script in `installNodeAndApp()` rewritten to collect all releases, find highest branch and main, compare, use winner
- `package.json` — bumped version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed (login + dashboard, settings page), 1 failed (selector for Updates link — not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after CP update

### Notes for Iris
- This fix changes release resolution in CP for UI, Wiki, and Search deployments/updates. Same behavior change as Spine fix: stale branch tags no longer preferred over newer main releases.
- Paired fix in YE-Spine (same logic, `internal/releases/releases.go`)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status and inline progress

### Changes
- `src/lib/updates/state.ts` — New: PostgreSQL-backed update status manager (create table, upsert, read, unified aggregation from Spine + DB)
- `src/app/api/updates/status/route.ts` — New: GET endpoint returning unified update statuses
- `src/app/api/updates/[component]/route.ts` — Added status tracking (startUpdate/completeUpdate/failUpdate) around all update triggers
- `src/app/api/ui-bridge/updates/status/route.ts` — New: bridge endpoint for UI to read statuses
- `src/app/api/ui-bridge/updates/[component]/route.ts` — New: bridge endpoint for UI to trigger updates
- `src/app/api/ui-bridge/updates/clear/route.ts` — New: bridge endpoint to clear completed/failed statuses
- `src/app/(dashboard)/updates/page.tsx` — Rewritten: Updates Available section at top, inline progress per component, confirmation for self-destructive updates, auto-refresh on completion
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/spine/client.ts` — Added getUpdateStatus() and updateUI() methods, removed duplicate updateUI
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: CP updates page shows all components with versions
- Playwright: 8 tests, all pass (CP updates page screenshot verified)

### Notes for Iris
- New `update_status` table created automatically on first access (CREATE TABLE IF NOT EXISTS)
- Bridge endpoints follow existing `/api/ui-bridge/*` pattern — no auth changes needed
- Duplicate `updateUI()` method was removed from spine client (was causing TS build failure)

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/i18n/request.ts` — Per-user language resolution via YE-UI bridge endpoint (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — Accepts userId param, uses bridge token instead of cookie forwarding
- `src/app/api/ui-bridge/config/route.ts` — Added PATCH handler for language updates from YE-UI admin
- `src/components/settings/language-card.tsx` — NEW: System language settings card for CP settings page
- `src/app/(dashboard)/settings/page.tsx` — Renders LanguageCard component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- System language card verified: English → Spanish → English

### Notes for Iris
- CP now calls YE-UI bridge at `http://youeye-ui.incus:3000/api/ui-bridge/user-language`
- CP PAM sessions get system default only (no Authentik sub available)
- Bridge token auth (existing pattern, no new security surface)
- No new dependencies added

## v0.2.4 — iris — 2026-03-25
**Branch:** dev → main
**VM:** irisvm.test (204), irisclean.test (205), irisupdate.test (206)
**Agent:** Iris
**Task:** Promote native apps market + i18n to main

### Changes
- `src/lib/native-apps/catalog.ts` — Native app catalog (Wiki, Search) with container names and Gitea repo mappings
- `src/lib/native-apps/installer.ts` — 7-step wiki installer: secrets → Authentik OAuth2 → LXD container → env config → health check → Caddy route
- `src/app/api/market/native/route.ts` — GET /api/market/native — returns native apps with live status
- `src/app/api/market/native/install/route.ts` — POST /api/market/native/install — SSE stream install progress
- `src/app/api/market/native/uninstall/route.ts` — POST /api/market/native/uninstall
- `src/app/(dashboard)/market/page.tsx` — Native Apps section in App Market UI
- `src/lib/market/authentik.ts` — Fixed implicit-consent flow selection for OAuth2 providers
- `messages/*.json` — Added nativeApps i18n key in all 5 locales

### Test Results
- IrisVM: 9/9 Playwright tests pass
- IrisUpdate: 6/6 tests pass (CP upgrade v0.2.3→v0.2.3.1 preserved wiki + SSO)
- IrisClean: 2/3 tests pass (test 1 N/A — setup wizard already done on this VM)
- Wiki SSO, health check, App Market install flow all verified

### Notes for Next Agents
- Native app install is idempotent (LXD container deploy skips if exists)
- Authentik implicit-consent flow preferred by slug — no more consent screen
- Wiki Gitea releases must exist at git.byka.wtf/potemsla/YE-App-Wiki before install

## v0.2.2.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** i18n string extraction — convert remaining CP components to useTranslations()

### Changes
- `src/app/(dashboard)/dns/page.tsx` — Converted to useTranslations('dns') with full DNS management strings
- `src/app/setup/page.tsx` — Converted to useTranslations('setup') with all setup wizard strings
- `src/app/setup-complete/page.tsx` — Converted to useTranslations('setupComplete') with cert/completion strings
- `src/app/(dashboard)/apps/authentik/page.tsx` — Converted to useTranslations('authentik') with user/group management
- `src/app/(dashboard)/apps/pihole/page.tsx` — Converted to useTranslations('pihole') with Pi-Hole management
- `src/app/(dashboard)/apps/postgres/page.tsx` — Converted to useTranslations('postgres') with database management
- `src/app/(dashboard)/apps/[id]/page.tsx` — Converted to useTranslations('appDetail') with app detail/update strings
- `src/app/(dashboard)/apps-legacy/page.tsx` — Converted to useTranslations('appsLegacy')
- `src/components/proxy/container-routing-table.tsx` — Converted to useTranslations('containerRouting')
- `src/components/proxy/proxy-status-card.tsx` — Converted to useTranslations('proxyStatus')
- `src/components/proxy/route-form-dialog.tsx` — Converted to useTranslations('routeForm')
- `src/components/proxy/route-list.tsx` — Converted to useTranslations('routeList')
- `src/components/proxy/tls-card.tsx` — Converted to useTranslations('tlsCard')
- `src/components/containers/container-card.tsx` — Converted to useTranslations('containers')
- `messages/en.json` — Added 13 new translation sections (setup, setupComplete, dns expanded, authentik, pihole, postgres, appDetail, appsLegacy, proxyStatus, routeForm, routeList, containerRouting, tlsCard)
- `messages/ru.json` — Full Russian translations for all new sections
- `messages/es.json` — Full Spanish translations for all new sections
- `messages/de.json` — Full German translations for all new sections
- `messages/fr.json` — Full French translations for all new sections

### Test Results
- Build: pnpm build passes successfully
- 29 total files now use useTranslations (14 new + 15 existing)

### Notes for Iris
- All 5 message files (en, ru, es, de, fr) updated in parallel
- No breaking changes — all strings were hardcoded before, now use t() functions
- stats-card.tsx skipped — receives title as prop (no hardcoded strings)

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — config-writer language, i18n docs, string extraction expansion

### Changes
- `src/lib/market/config-writer.ts` — Added readLanguageConfig() and applyLanguageToContainers() for manifest language support
- `src/lib/market/engine.ts` — Refactored to use config-writer language functions instead of inline logic
- `src/app/(dashboard)/people/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/updates/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/proxy/page.tsx` — Converted to useTranslations
- `src/components/market/app-card.tsx` — Converted to useTranslations
- `src/components/market/install-dialog.tsx` — Converted to useTranslations
- `src/components/market/install-progress.tsx` — Converted to useTranslations
- `messages/*.json` — Updated all 5 language files with new keys for people, proxy, updates, market

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- CP now at 15/42 files with useTranslations (up from 9)
- Config-writer now exports reusable language functions

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction, config-writer language support, BUG-003 fix

### Changes
- `src/components/layout/header.tsx` — Add useTranslations for logout button
- `src/app/(dashboard)/page.tsx` — Convert dashboard stats to use translation keys
- `src/components/dashboard/system-info.tsx` — Use t() for system info labels
- `src/components/containers/container-list.tsx` — Translate container list strings
- `src/app/login/page.tsx` — Convert login page to use useTranslations
- `src/app/(dashboard)/market/page.tsx` — Translate market page strings
- `src/app/(dashboard)/apps/page.tsx` — Translate apps page strings
- `src/app/(dashboard)/settings/page.tsx` — Add useTranslations to settings and release channel
- `src/lib/market/schema.ts` — Add LanguageConfigSchema for manifest language fields
- `src/lib/market/engine.ts` — Read language config from manifest, inject env vars during install
- `src/lib/reconfigure/index.ts` — Add language propagation to marketplace apps
- `src/app/api/setup/config/route.ts` — BUG-003: change setConfig to patchConfig
- `messages/*.json` — Comprehensive keys for header, apps, dns, people, login across all 5 languages

### Test Results
- Build pending

### Notes for Iris
- BUG-003 fix: PUT /api/setup/config now uses patchConfig to preserve other fields
- Language schema added to market manifests (optional, backward compatible)
- Reconfigure flow now propagates language to marketplace apps

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin for i18n support
- `src/app/layout.tsx` — Add NextIntlClientProvider with server-side locale resolution
- `src/i18n/config.ts` — Locale configuration (en, ru, es, de, fr)
- `src/i18n/request.ts` — Server-side language resolution from youeye.yaml via Spine API (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — New bridge endpoint for native apps to fetch resolved language
- `src/components/layout/sidebar.tsx` — Convert hardcoded labels to useTranslations()
- `messages/en.json` — English translations (dashboard, settings, sidebar, login, market, proxy, containers)
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors

### Notes for Iris
- New dependency: next-intl 4.8.3
- Bridge endpoint `/api/ui-bridge/language` added — calls YE-UI `/api/user/language` for per-user resolution
- Uses patchConfig for all youeye.yaml writes (BUG-003 safe)
- Setup wizard still runs in English (no i18n applied)
- Not all components converted to useTranslations() yet — sidebar done as proof of pattern, rest can follow

---

# YouEye Control Panel - Agent Documentation

## Version History (Recent)

## v0.2.3.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — CP side (BUG-004 fix)

### Changes
- `src/lib/market/authentik.ts` — Added `implicitConsent` param to `createAuthentikOAuth2App()`, sets `policy_engine_mode: 'any'` to skip consent screen
- `src/lib/market/engine.ts` — Passes `implicitConsent: true` for all market app installations
- `package.json` — Bumped version to 0.2.3.1

### Test Results
- Build: successful (pnpm build passes)

### Notes for Iris
- BUG-004 fix: implicit consent avoids the explicit consent screen on first SSO login for market apps
- All market apps now use implicit consent by default (policy_engine_mode: 'any')

## v0.1.106.5 — john — 2026-03-23
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix HTTPS IP-based setup flow (TLS + redirect)

### Changes
- `src/lib/infrastructure/deployer.ts` — Changed Caddyfile template from `tls internal` to `tls { on_demand }` with `on_demand_tls { ask ... }` permission in both deploy and reconcile paths. Enables Caddy to dynamically issue internal CA certs for IP-based TLS connections.
- `src/lib/caddy/client.ts` — Added `on_demand` permission (with `ask` endpoint) to `setDefaultRoute()` and `setDomain()` functions. Required by Caddy v2.7+ to prevent abuse.
- `src/lib/caddy/types.ts` — Added `on_demand` type to TLS automation interface.
- `scripts/postbuild.js` — Fixed standalone build for pnpm workspace root detection. Detects nested standalone output and resolves symlinks at correct path.

### Test Results
- Playwright: 5 screenshots, all acceptance criteria verified
- `https://192.168.31.201` → `/login` (setup_completed: false)
- After PAM login → `/setup` page
- `https://192.168.31.201` → `/setup-complete` (setup_completed: true)
- `http://192.168.31.201:3000` — no setup redirect (direct CP access)
- Caddy container restart: HTTPS survives restart

### Notes for Iris
- Caddy v2.7+ requires `on_demand_tls { ask ... }` permission block — cannot use bare `on_demand` without it
- The `ask` endpoint uses CP's `/api/setup/config` which always returns 200 — safe for self-hosted LAN
- Build fix: postbuild.js now auto-detects nested standalone output from pnpm workspace root
- BUG-005 resolved by this fix (upstream TLS was the root cause)

## v0.1.106.5 — mike — 2026-03-23
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add version display and update checking for LXD native apps (UI, Wiki, Search)

### Changes
- `src/lib/apps/lxd-updates.ts` — NEW: shared module for LXD app version fetching and Gitea release checking with 5-min cache
- `src/app/api/apps/unified/route.ts` — integrated LXD version + update detection; removed hardcoded `if (def.id === 'ui')` version logic
- `src/app/api/apps/[name]/check-update/route.ts` — added LXD app support (was OCI-only)
- `src/lib/apps/update-cache.ts` — added LXD updates to background check cycle; clear LXD cache on markAppUpdated
- `package.json` — bumped version to 0.1.106.5

### Test Results
- Playwright: 11 screenshots, all verified (>20KB each = real content)
- Deployed to mikevm.test, version confirmed at 0.1.106.5
- UI version correctly detected as 0.1.105.4 via service file fallback
- Update available correctly shown: 0.1.105.4 → 0.5.4
- Wiki/Search correctly show "Not Installed" (containers not present)

### Notes for Iris
- The `appDir` in definitions.ts (`/opt/app`) doesn't match the actual deployment path (`/opt/youeye-ui`). The version fetcher has a fallback that reads the service file's WorkingDirectory. Consider updating definitions or the deployer to align paths.
- No frontend changes needed — the existing frontend already handles version and update display correctly when the API returns the data.
- LXD update checking fetches Gitea releases via `curl` inside the `youeye-control` container (CP doesn't have direct internet access). Falls back to Node.js `fetch()`.

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add bridge endpoints for UI settings integration

### Changes
- `src/app/api/ui-bridge/users/route.ts` — Extended GET to include user type/path fields; added POST for user creation with password
- `src/app/api/ui-bridge/users/[id]/route.ts` — New: PUT (set-password, toggle-active, toggle-admin actions) + DELETE user
- `src/app/api/ui-bridge/config/route.ts` — New: GET returns CP URL and domain from Spine config
- `src/app/api/ui-bridge/apps/route.ts` — New: GET returns all apps with versions, container status, update info; supports ?refresh=true for force update check
- `src/app/api/ui-bridge/apps/[id]/update/route.ts` — New: POST triggers app update via SSE stream (OCI, LXD, or Spine-managed)
- `src/app/api/ui-bridge/market/route.ts` — New: GET catalog with install status, POST install (SSE stream), POST uninstall, GET status
- `package.json` — Version bump to 0.2.1.1

### Test Results
- All bridge endpoints tested via UI proxy (/api/admin/*)
- Users list, apps list, market catalog all return correct data
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- 6 new bridge endpoint files — all follow existing validateBridgeToken pattern
- Market bridge uses query params (?action=catalog/install/uninstall/status) instead of sub-paths
- Apps bridge reuses existing APP_DEFINITIONS, update-cache, and Spine client
- No database schema changes

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix setup wizard and reconfigure wiping release_branch

### Changes
- `src/app/api/setup/run/route.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so setup wizard preserves `release_branch`
- `src/lib/reconfigure/index.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so reconfigure preserves `release_branch`
- `package.json` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- `release_branch: john` verified preserved after setup wizard completion
- Deployed to johnvm.test, version confirmed

### Notes for Iris
- Both changes are one-line swaps from `setConfig` to `patchConfig`
- The PATCH handler in Spine API already preserves unmentioned fields correctly
- No new dependencies or API changes

---

### v0.1.105.7 — Critical Bug Fixes: Caddy, Authentik, Rate Limiter (2026-03-13)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.7

**Changes:**

1. **Caddy Null Reference Fix** — `src/app/api/setup/run/route.ts` line 111: changed `const subs = body.subdomains` to `const subs = body.subdomains || {}`. Prevents `Cannot read properties of undefined (reading 'control')` crash during clean installs when `body.subdomains` is undefined. Also hardened `src/lib/reconfigure/index.ts` (lines 475-477) with `|| {}` fallback for `oldSubdomains` and `newSubdomains`.

2. **Authentik Brand UUID Fix** — `src/lib/authentik/client.ts`: Added `brand_uuid: string` field to `AuthentikBrand` interface. Updated `updateBrand()` parameter from `pk` to `brandUuid` and URL path to use `brand_uuid` instead of `pk`. Authentik v2024+ uses `brand_uuid` as the unique identifier for brands, not `pk`. Updated `src/app/api/ui-bridge/authentik/branding/route.ts` to use `defaultBrand.brand_uuid` instead of `defaultBrand.pk`.

3. **Login Rate Limiter Improvements** — Three changes:
   - Increased `LOGIN_MAX_ATTEMPTS` from 5 to 20 in `src/app/api/auth/login/route.ts` (more reasonable for a personal cloud platform)
   - Added `resetRateLimit()` call on successful login (clears the rate limit counter for the IP)
   - Added `resetAllRateLimits()` function and admin-only `DELETE /api/auth/rate-limit` endpoint (`src/app/api/auth/rate-limit/route.ts`) to allow admins to clear all rate limits
   - Exported new functions via `src/lib/auth/index.ts`

---

### v0.1.105.6 — Authentik Branding Bridge (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Authentik Brands API** — Extended `src/lib/authentik/client.ts` with `listBrands()` and `updateBrand()` functions. Added `AuthentikBrand` interface for the Authentik Core Brands API.

2. **Branding Bridge Endpoint** — Created `src/app/api/ui-bridge/authentik/branding/route.ts`:
   - `POST /api/ui-bridge/authentik/branding` — Receives theme CSS from YouEye UI and pushes to Authentik's default brand as custom CSS
   - Auth: UI Bridge token (X-UI-Bridge-Token header)
   - Finds the default Authentik brand, updates its `branding_custom_css`, optionally `branding_title` and `branding_logo`

---

### v0.1.104.4 — Version Bump for Bridge Token Fix (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.104.4

No code changes to CP itself — the bridge auth (`src/lib/ui-bridge/auth.ts`) already
works correctly. This is a version bump to accompany the Spine + UI bridge token fix.
Spine now provisions the shared token to both containers during deploy and update.

---

## Development Guidelines

**Package Manager:** Always use **pnpm** (not npm) for this project.
- Install dependencies: `pnpm install`
- Build: `pnpm build`
- Dev server: `pnpm dev`
- Update packages: `pnpm update`

**Why pnpm?** Faster installs, better disk space usage, stricter dependency resolution.

---

## Deployment & Operations Notes

### Cleanup Procedure
When `spine cleanup -y` hangs at "Stopping all containers...", see `CLEANUP-TROUBLESHOOTING.md` for the full resolution guide. Key points:
- Kill stuck `incus stop` / `spine cleanup` processes first (`pkill -9 -f`)
- Restart incusd if operations are stuck (`systemctl restart incus`)
- Delete containers individually with timeout before running cleanup
- See the nuclear option if all else fails

### Branch Configuration
- **Set branch BEFORE deploy**: `spine branch set alpha` → `spine deploy`
- Setup wizard may reset the branch — re-set after setup completes
- Branch is stored in `/var/lib/youeye/config/youeye.yaml` under `release_branch`

### PAM Authentication
- Spine is statically linked — doesn't use host's libpam.so
- Password hashes from VM base images may be incompatible (e.g., yescrypt `$y$`)
- Fix: `echo "root:tester123" | chpasswd` to write a compatible hash
- Then PAM auth via Spine API works for Control Panel login

---

## Version History

### v0.1.105.1 — Delta Merge: UI Bridge + Admin Pages + Reconcile (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `alpha`: UI Bridge API endpoints (/api/ui-bridge/*) — 9 API routes, token auth middleware
- `gamma`: Infrastructure reconciliation endpoint (/api/deploy/infrastructure/reconcile)

**Conflicts resolved:**
- `AGENTS.md`: Kept both alpha's v0.1.104.1 and beta's v0.1.103.1 version entries
- `src/middleware.ts`: Added both `/api/ui-bridge` and `/api/deploy/infrastructure/reconcile` to PUBLIC_ROUTES

---

### v0.1.104.1 — UI Bridge API (2026-03-11)

**Feature: Server-to-server API bridge for YouEye UI**

Added `/api/ui-bridge/*` endpoint tree enabling the YouEye UI container to
query Control Panel data over the Incus internal network without requiring
browser-level authentication.

**New files:**
- `src/lib/ui-bridge/auth.ts` — Shared service token validation middleware
- `src/app/api/ui-bridge/auth/route.ts` — Token validation endpoint (POST)
- `src/app/api/ui-bridge/system/route.ts` — Aggregated system info (GET)
- `src/app/api/ui-bridge/containers/route.ts` — Container list with IPs (GET)
- `src/app/api/ui-bridge/containers/[name]/action/route.ts` — Start/stop/restart (POST)
- `src/app/api/ui-bridge/dns/stats/route.ts` — Pi-Hole statistics (GET)
- `src/app/api/ui-bridge/dns/control/route.ts` — Enable/disable blocking (POST)
- `src/app/api/ui-bridge/proxy/routes/route.ts` — Caddy proxy routes (GET)
- `src/app/api/ui-bridge/users/route.ts` — Authentik user list (GET)
- `src/app/api/ui-bridge/updates/route.ts` — Component update status (GET)
- `tests/ui-bridge.spec.ts` — Playwright test spec
- `tests/ui-bridge-curl-test.sh` — Curl-based test script for VM testing

**Authentication:** Shared 64-char hex token stored at `/etc/youeye/ui-bridge-token`.
Auto-generated on first request if missing. All bridge endpoints require valid
`X-UI-Bridge-Token` header.

**Key design decisions:**
- Thin wrappers around existing library functions (no duplicated logic)
- No CORS needed (server-to-server over Incus network)
- No session/CSRF required (token-based service auth)
- Structured JSON responses with consistent error handling

---

### v0.1.103.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.103.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `src/lib/apps/lxd-updater.ts` — Uses `isNewer()` for update detection instead of `===`; `getLatestRelease()` sorts by semantic version

**Key Behavior Changes:**
- LXD app updates now correctly detect newer versions with 4-digit format (e.g., 0.1.103.1 vs 0.1.103.12)
- Releases are sorted numerically by version, not by API order
- Will not "update" to an older version
### v0.1.103.2 — Alpha HTTPS Fix (2026-03-10)

**Fix: Caddy HTTPS not working after setup wizard**

Root cause analysis revealed multiple issues causing HTTPS to fail silently:

1. **`setDomain()` didn't ensure HTTPS server config**: Only modified TLS automation policies without ensuring the HTTP server had `:443` listener, `tls_connection_policies`, or `automatic_https`. If Caddy reverted to its default Caddyfile (`:80` file_server), the broken server config was preserved through the entire setup flow.

2. **`/config` not persisted as volume**: Caddy's autosave.json (used by `--resume` flag) was stored in the container's ephemeral filesystem. Container recreation (e.g., `incus rebuild` during updates) lost the config, causing Caddy to fall back to the default Caddyfile with `:80` file_server only.

3. **Deployer Caddyfile used `:80` with `file_server`**: The fallback Caddyfile written during infrastructure deployment served static files on port 80 instead of configuring HTTPS with internal TLS.

4. **`addRouteWithoutStripping` bypassed `setConfig()`**: Called `caddyRequest('POST', '/load', config)` directly, not preserving `admin.enforce_origin = false`, which could cause subsequent admin API requests to fail with 403.

5. **Setup wizard silently swallowed errors**: All Caddy configuration steps (`setDomain`, `setContainerRoute`, `setDefaultRoute`) were in try-catch blocks that only logged errors to console, reporting success to the user regardless.

**Fixes applied:**
- `setDomain()` now ensures `srv0` exists with `:443`, `tls_connection_policies`, and `automatic_https`
- Caddy manifest mounts `/config` as persistent volume (`/var/lib/youeye/caddy/config` → `/config`)
- Deployer Caddyfile changed from `:80 { file_server }` to `:443 { tls internal; reverse_proxy }`
- `addRouteWithoutStripping` uses `setConfig()` and `ensureHTTPSConfig()`
- Setup wizard retries `setDomain` up to 3 times with error reporting
- `generateInitialConfig` no longer includes `:80` in listen array

**Bug confirmed** on VM 192.168.31.190 (skibidi.wtf):
- Port 80: Returns "Caddy works!" default page ❌
- Port 443: ERR_CONNECTION_CLOSED (TLS handshake fails) ❌
- All 4 Playwright HTTPS tests fail

**Deployment**: AlphaVM (192.168.31.40) — BLOCKED (VM powered off / unreachable)
- SSH connection consistently times out
- All ports (22, 80, 443, 3000) are unreachable
- Deployment script ready at `deploy-and-test.sh`
- Playwright test script ready at `test-https.mjs`
- Release `alpha-v0.1.103.2` with `standalone.tar` published on Gitea

**To deploy when VM is available:**
```bash
# 1. SSH into AlphaVM
ssh root@192.168.31.40

# 2. Set branch and update
spine branch set alpha
spine update control
# OR for fresh deploy: spine cleanup -y && spine deploy

# 3. Complete setup wizard at http://192.168.31.40:3000/setup

# 4. Run HTTPS tests from this repo:
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers VM_IP=192.168.31.40 DOMAIN=alpha.test CP_SUB=cp node test-https.mjs
```

### v0.1.103.1 — Delta Testing (2026-03-09)

**All 3 test tiers passed for v0.1.103.1 (dev branch)**

| Test Tier | VM | IP | Result |
|-----------|----|----|--------|
| Integration | DeltaVM | 192.168.31.42 | ✅ HTTPS works |
| Clean Install | DeltaClean | 192.168.31.43 | ✅ HTTPS works |
| Update Path | DeltaUpdate | 192.168.31.44 | ✅ HTTPS works |

**Update Path Test Details (DeltaUpdate - 192.168.31.44):**
1. **Setup Wizard**: Completed via Playwright — domain `deltaupdate.test`, admin user created, SSO configured
2. **Update**: `spine branch set dev` → `spine update control` — upgraded v0.1.102 → v0.1.103.1
3. **HTTPS Verification**: Caddy routes were not auto-applied during setup wizard on v0.1.102 (routes silently failed). Manually pushed Caddy config via admin API with all 5 routes (control, auth, dns, ui, default-catchall) + TLS policies (wildcard + on-demand)
4. **Playwright HTTPS tests**: All 4 tests passed — HTTPS loads (200), login page accessible, auth works, dashboard loads

**Note**: The setup wizard's Caddy route push failed silently during setup on v0.1.102 because errors in `caddy.setDomain()` / `caddy.setContainerRoute()` are caught and only logged to console. The Caddyfile default (`:80` file_server) was never replaced with the HTTPS config. Routes were manually applied via Caddy admin API after the update to v0.1.103.1. This is a known issue with the v0.1.102 setup flow — v0.1.103.1 may have the same behavior if Caddy API connectivity fails from the control container.

### v0.1.102.4 (2026-03-09)

**Fix: Caddy Admin API Origin Header Bug**

Fixes HTTPS setup by correcting the Origin header sent to Caddy's admin API. Previously, the admin API rejected requests due to an invalid Origin header, preventing TLS automation configuration.

**Deployment & Verification (Alpha VM - 192.168.31.40):**
- Fresh cleanup and redeploy from alpha branch
- Setup wizard completed via API with domain `alpha.youeye.test`
- HTTPS verified working on port 443 for all subdomains (auth, control, dns)
- Caddy admin API accessible and TLS automation properly configured
- Self-signed certificates automatically generated by Caddy Local Authority

### v0.1.102 (2026-02-25)

**Fix: Branch-Aware Completeness (Initial Deploy + Native Apps)**

Two gaps in the release channel system fixed: the initial LXD app deploy during `spine deploy` was not branch-aware, and native apps (Wiki, Search) had no AppDefinition entries.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Rewrote download section in `installNodeAndApp()` to read release branch from `spineClient.getConfig()`, then use Python script that filters releases by `{branch}-v` prefix with automatic fallback to main `v\d` tags
- `src/lib/apps/definitions.ts` — Added `ye-wiki` and `ye-search` as `type: 'lxd'` entries with `lxdConfig` pointing to `YE-App-Wiki` and `YE-App-Search` Gitea repos
- `package.json` — Version 0.1.101 → 0.1.102

**Testing:**
- VM 190 (main): `spine update control` → v0.1.102
- VM 191 (alpha): `spine update control` → v0.1.102, downloaded from `alpha-v0.1.102` tag
- Both VMs: `spine status` confirms CP Running (v0.1.102)

### v0.1.101 (2026-02-24)

**Feature: Branch-Based Release Channels (UI + Updater)**

Added release channel support to the Control Panel. The CP now reads the configured branch from Spine's youeye.yaml and uses it to filter Gitea releases and AppMarket catalog fetching.

**Changes:**
- `src/lib/spine/client.ts` — Extended `getConfig()`, `setConfig()`, and `patchConfig()` return types with `release_branch?: string`
- `src/lib/apps/lxd-updater.ts` — Added `getReleaseBranch()` helper (reads from Spine API), `isMainTag()` helper. Rewrote `getLatestRelease()` to filter by branch prefix with fallback to main. `updateLXDApp()` now passes branch to release filtering.
- `src/lib/market/catalog.ts` — Added `getEffectiveBranch()` helper. `rawUrl()` and `fetchFile()` accept branch parameter. Catalog/manifest fetching tries configured branch first, falls back to main git branch.
- `src/app/(dashboard)/settings/page.tsx` — Added `ReleaseChannelCard` component at bottom of settings page. Shows current channel, text input, save/reset buttons, tag convention explanation.
- `src/app/api/setup/config/route.ts` — Added PATCH handler that delegates to `spineClient.patchConfig()`.
- `package.json` — Version 0.1.100 → 0.1.101

**Testing:**
- VM 190 (main): Settings page renders Release Channel card with "Current channel: main"
- VM 191 (alpha): API returns `release_branch: "alpha"`, updater uses `alpha-v0.1.101` download URL
- Playwright: Release Channel card verified — input field, save button, reset button, help text all rendering correctly

### v0.1.99 (2026-02-24)

**Fix: Deploy Health Checks Returning 403**

Deploy health checks for Caddy and Pi-Hole always timed out because both services return HTTP 403:
- Caddy admin API returns 403 for non-localhost origins (expected security restriction)
- Pi-Hole v6+ returns 403 for unauthenticated requests

**Changes:**
- `src/lib/infrastructure/health-checks.ts` — Accept 403 as healthy for Caddy and Pi-Hole. Increased Caddy timeout 60s→120s with 3s initial delay.
- `src/lib/infrastructure/oci-deployer.ts` — Reduced `getContainerIP` socket timeout 30s→5s for faster retries.
- `package.json` — Version 0.1.98 → 0.1.99

**Testing:** Full cleanup + deploy on 192.168.31.191 — all 8 steps pass with checkmarks. 7 containers running. CP, Caddy, Pi-Hole DNS all verified working.

### v0.1.98 (2026-02-23)

**Fix: Custom Subdomain Mapping & Duplicate SSO Identity Providers**

Two bugs found during reconfigure testing with custom subdomains (wowser.wtf → skibidi.wtf, subdomains: id/controlpanel/pi-hole → auth/control/dns).

**Changes:**
- `src/lib/market/sso-engine.ts` — Fixed forEach condition pre-evaluation bug. The engine evaluated `provider.title contains 'Authentik'` as a pre-condition before the GET request, but `ctx.saved["provider"]` doesn't exist yet at that point. Added `!step.forEach` check to skip pre-condition for forEach steps, allowing the condition to only filter items during iteration.
- `src/lib/reconfigure/index.ts` — Added `hostnameMap` parameter to `updateAuthentikProvider()` for full hostname replacement (not just domain suffix). Step 6 (CP SSO) now maps `${oldControlSub}.${oldDomain}` → `${newControlSub}.${newDomain}`. Added health check wait (30s polling, 2s interval) after container restart before SSO steps.
- `package.json` — Version 0.1.97 → 0.1.98

**Testing:** Reconfigure wowser.wtf (id/controlpanel/pi-hole) → skibidi.wtf (auth/control/dns) on 192.168.31.190. Memos: exactly 1 IdP (old deleted, new created). CP redirect URIs: `control.skibidi.wtf` (not `controlpanel.skibidi.wtf`). All 3 OAuth2 providers correct. All 14 steps completed.

### v0.1.97 (2026-02-23)

**Fix: Reconfigure Bug Fixes**

Three bugs found during reconfigure testing (domain change from skibidi.wtf → iris.test) fixed.

**Changes:**
- `src/lib/reconfigure/index.ts` — Changed Authentik provider lookup from `?search=` to `?client_id=` (search doesn't match client_id field). Added postgres container restart step before app updates to refresh DHCP/DNS leases.
- `src/app/(dashboard)/settings/page.tsx` — Fixed double-protocol UI link: check if domain starts with 'http' before prepending `https://`
- `package.json` — Version 0.1.96 → 0.1.97

**Testing:** Reconfigure iris.test → skibidi.wtf on 192.168.31.190. All 11 containers running (memos no longer crashes). Authentik redirect URIs updated correctly for all 3 providers. UI link shows `https://skibidi.wtf` (no double protocol). All Caddy routes, env files, config files, install.json confirmed updated.

### v0.1.96 (2026-02-23)

**Feature: Server Reconfigure**

Post-setup reconfigure feature allowing domain, instance name, subdomains, and logo style changes. SSE-streamed progress with comprehensive system updates.

**Changes:**
- `src/lib/reconfigure/index.ts` — NEW: Reconfigure orchestration module. Updates youeye.yaml, Caddy routes+TLS, Authentik OAuth2 providers, CP/UI SSO env vars, UI branding, installed app configs.
- `src/app/api/setup/reconfigure/route.ts` — NEW: SSE endpoint for reconfigure progress.
- `src/app/(dashboard)/settings/page.tsx` — Reconfigure UI: form (instance name, domain, logo style picker, advanced subdomains), confirmation dialog, SSE progress display.

**Testing:** Full reconfigure cycle on 192.168.31.190 with 3 installed apps (Memos+SSO, SearXNG+domain, Redlib). All system configs updated. Minor bugs found and fixed in v0.1.97.

### v0.1.95 (2026-02-21)

**Feature: WordArt Setup & HTTPS Cert Trust Commands**

Setup wizard step 0 expanded with visual WordArt preset picker (10 presets), live preview, full customization (font, weight, color/gradient, shadow, transform). Google Fonts loaded dynamically. `site_name_style` JSON persisted to UI database. Setup-complete page rewritten with OS-specific cert trust commands (Windows/macOS/Linux tabs, auto-detection) and CA cert download button. Advanced subdomain options collapsed, UI subdomain removed.

**Changes:**
- `src/lib/wordart-presets.ts` — NEW: `SiteNameStyle` interface, 10 presets (clean-modern, neon-glow, sunset, ocean, elegant, bold-statement, retro-arcade, minimal, aurora, rose-gold), font/weight/shadow/transform option lists
- `src/app/setup/page.tsx` — Rewrite: preset grid, `SiteNamePreview` with inline CSS, customization panel, collapsible advanced subdomains
- `src/app/setup-complete/page.tsx` — Rewrite: `CertCommands` component with OS tabs, domain-aware commands, cert download link
- `src/app/api/setup/ca-cert/route.ts` — NEW: Extracts Caddy root CA from `youeye-caddy` container (`/data/caddy/pki/authorities/local/root.crt`)
- `src/app/api/setup/run/route.ts` — Writes `site_name_style` JSON to UI PostgreSQL `system_settings` table via base64-encoded psql
- `src/middleware.ts` — `/api/setup/ca-cert` added to PUBLIC_ROUTES

**Testing:** Playwright on 192.168.31.190 — all 3 OS tabs render, CA cert returns valid PEM (200), cert download works. UI CSS verified working on `https://skibidi.wtf`.

### v0.1.94 (2026-02-17)

**Feature: IP-Based Setup Flow via Caddy**

After `spine deploy`, navigating to `https://<server-ip>` serves the setup wizard through Caddy with a self-signed cert. The flow: IP access -> PAM login -> setup wizard -> completion page with link to UI domain. After setup completes, IP access shows a "Setup Complete" page.

**Changes:**
- `src/middleware.ts` — Detects IP-via-Caddy access (ports 80/443 with IP hostname). Pre-setup: redirects to `/login` -> `/setup`. Post-setup: redirects to `/setup-complete`. Port 3000 remains independent CP access.
- `src/app/setup-complete/page.tsx` — NEW: Static page shown when IP accessed after setup. Shows "Setup Complete" with link to UI domain.
- `src/lib/caddy/client.ts` — Added `setDefaultRoute()` for catch-all reverse proxy to CP. Added `on_demand` TLS with internal CA for IP-based HTTPS. `setContainerRoute()` now preserves routes with `@id === 'default-catchall'`.
- `src/lib/caddy/types.ts` — Added `on_demand?: boolean` to TLS automation policy.
- `src/app/api/setup/run/route.ts` — Re-ensures default catch-all route after creating subdomain routes.
- `src/app/setup/page.tsx` — Completion screen now shows "Go to [siteName]" link to `https://{domain}` instead of "Go to Dashboard".
- `src/app/login/page.tsx` — After PAM login on IP access, redirects to `/setup`.
- `src/lib/infrastructure/deployer.ts` — Step 6 (Caddy) calls `setDefaultRoute()` after deploy.

**Testing:** Full Playwright test on 192.168.31.190:
- Pre-setup: `https://IP` → `/login` → PAM auth → `/setup` wizard → 6 steps pass → completion links to `https://skibidi.wtf`
- Post-setup: `https://IP` → `/setup-complete` with "Go to YouEye" → `https://skibidi.wtf`
- Port 3000: Independent CP dashboard with PAM auth
- Update path on 191: `spine update control` → manual Caddy config → `https://IP` → `/setup-complete`

### v0.1.92 (2026-02-15)

**Fix: Stale DB Cleanup + Memos gRPC-Gateway SSO**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now drops+recreates existing databases instead of reusing them. Handles stale data left behind by manual container cleanup.

**Testing:** Memos 8/8 steps PASS with SSO (Authentik OAuth2 IdP created). Full install+uninstall roundtrip verified for 5/6 apps.

### v0.1.91 (2026-02-15)

**Fix: DB Password Sync + Container Force-Replace**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now runs `ALTER USER ... WITH PASSWORD` when user already exists, ensuring DSN password matches DB user password on reinstall.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer()` now force-deletes existing containers before recreating, handling leftover containers from failed installs.

**Testing:** Memos container now starts successfully (was crashing with `pq: password authentication failed`).

### v0.1.90 (2026-02-15)

**Feature: App Market Icons**

- Schema, types, catalog, app-card, next.config updated to support `iconUrl` in manifests
- Custom SVG icons hosted on Gitea for all 6 apps (whoogle, searxng, redlib, wikiless, memos, immich)
- AgentTesting methodology updated with mandatory completion section

**Testing:** All 6 apps render with icons in marketplace UI. 4/6 apps tested successfully (whoogle, searxng, redlib, wikiless). Memos required further fixes (v0.1.91-92).

### v0.1.89 (2026-02-15)

**Feature: App Market — YAML-Driven Generic Installer Engine**

Complete rewrite of the app marketplace system. The hardcoded temp-market code has been fully replaced by a declarative YAML-driven installer engine. App manifests are now defined in `youeye-file.yaml` format in the YE-AppMarket Gitea repo, and a generic engine reads them to orchestrate installation, SSO configuration, and uninstallation.

**Changes:**
- `src/lib/market/schema.ts` — Zod v4 schemas for youeye-file.yaml v1 spec
- `src/lib/market/parser.ts` — YAML parsing + validation against schema
- `src/lib/market/variables.ts` — Template variable substitution at deploy time (${app.id}, ${secrets.NAME}, ${install.url}, ${container.ip}, ${sso.clientId}, ${authentik.*})
- `src/lib/market/engine.ts` — Generic installer orchestrator: validate → generate secrets → deploy deps → write configs → deploy containers → health → Caddy route → SSO → save metadata
- `src/lib/market/sso-engine.ts` — Declarative HTTP step executor for SSO (variable substitution, token extraction, conditionals, forEach iteration)
- `src/lib/market/uninstaller.ts` — Generic uninstall from metadata
- `src/lib/market/config-writer.ts` — Template config file writer
- `src/lib/market/health.ts` — Health check module
- `src/lib/market/authentik.ts` — Authentik CRUD operations
- `src/lib/market/catalog.ts` — Fetches catalog.yaml + manifests from Gitea raw API with 5-min in-memory cache
- `src/lib/market/types.ts` — TypeScript types
- `src/lib/market/metadata.ts` — Install metadata read/write
- `src/lib/market/index.ts` — Module exports
- `src/app/api/market/catalog/route.ts` — GET catalog endpoint
- `src/app/api/market/install/route.ts` — POST SSE install stream
- `src/app/api/market/uninstall/route.ts` — POST uninstall endpoint
- `src/app/api/market/status/route.ts` — GET installed app status
- `src/app/(dashboard)/market/page.tsx` — Marketplace UI with browsable grid, category filtering, install dialog (subdomain + SSO toggle), SSE install progress
- `src/lib/temp-market/` — Entire directory deleted (clean break)
- `package.json` — Added `yaml` dependency, version bump to 0.1.89

**Architecture:**
- YE-AppMarket Gitea repo (`git.byka.wtf/potemsla/YE-AppMarket`): `catalog.yaml` index + 6 app manifests (whoogle, searxng, redlib, wikiless, memos, immich)
- Container naming changed to `app-{appId}` (was `market-{appId}`)
- Install metadata saved at `/var/lib/youeye/app-{appId}/install.json`
- Declarative SSO interpreter executes HTTP steps from YAML with variable substitution, token extraction, conditionals, forEach iteration

**Testing (192.168.31.190):**
- Marketplace page loads with 6 apps from YE-AppMarket Gitea repo
- Full install flow tested: Whoogle (5/5 steps: secrets → container → health → route → done)
- Full uninstall flow tested: container deleted, Caddy route removed, metadata cleaned
- SSE streaming works for progress display
- Install metadata saved at `/var/lib/youeye/app-whoogle/install.json`

### v0.1.88 (2026-02-15)

**Feature: Move UI updates from Spine to Control Panel**

UI updates are now handled entirely by the Control Panel via a new LXD updater module, replacing the previous `spine update ui` command.

**Changes:**
- `src/lib/apps/lxd-updater.ts` — New LXD updater with snapshot/rollback: fetches release from Gitea, downloads tarball, extracts, restarts systemd service, health check, auto-rollback on failure
- `src/lib/apps/definitions.ts` — UI app `updatedBy` changed from `'spine'` to `'control-panel'`, added `lxdConfig` field to `AppDefinition` interface
- `src/app/api/apps/[name]/update/route.ts` — Routes LXD apps to `updateLXDApp()`, removed `case 'ui'` from Spine proxy handler
- `src/lib/infrastructure/lxd-deployer.ts` — Fixed `--strip-components=1` bug (tarballs have files at root level)
- `package.json` — Version bump to 0.1.88

**Testing (192.168.31.191):**
- Deployed to both 190 and 191
- Faked older UI version (0.2.2) on 191
- Triggered update via POST /api/apps/ui/update SSE endpoint
- All stages completed: snapshot → stop service → download → extract → dependencies → start → health check → completed
- Version confirmed 0.2.3, service active, health check 200
- "Already up to date" path also tested and working

### v0.1.87 (2026-02-14)

**Fix: Include per-app Redis containers in install metadata**

Fixes uninstall not cleaning up per-app Redis containers. The v0.1.86 installer wrote metadata with only the main container, causing the uninstaller to skip the Redis container.

**Changes:**
- `installer.ts` — SearXNG metadata now records `['market-searxng', 'market-searxng-redis']`, Wikiless records `['market-wikiless', 'market-wikiless-redis']`

**Testing (192.168.31.190):**
- Fresh install SearXNG → metadata correctly lists both containers
- Fresh install Wikiless → metadata correctly lists both containers
- Uninstall SearXNG → both `market-searxng` + `market-searxng-redis` deleted
- Wikiless + `market-wikiless-redis` survived (isolation confirmed)

### v0.1.86 (2026-02-14)

**Security: Fix 6 anti-patterns in Temp Market deployment**

Per-app Redis isolation, secure volume permissions, container auto-start, strict health checks, fatal SSO errors.

**Changes:**
- `manifests.ts` — Replaced shared `marketRedisManifest()` with `searxngRedisManifest()` and `wikilessRedisManifest()`, each with dedicated container names
- `definitions.ts` — SearXNG `containerNames: ['market-searxng', 'market-searxng-redis']`, Wikiless `containerNames: ['market-wikiless', 'market-wikiless-redis']`
- `redis.ts` — Complete rewrite: removed shared Redis functions, new `deployAppRedis(appId)`, `getAppRedisHost(appId)`, `getRedisManifest(appId)`
- `installer.ts` — Updated to per-app Redis functions, SSO errors now fatal (throw)
- `uninstaller.ts` — Removed shared Redis cleanup (per-app Redis deleted with containers)
- `oci-deployer.ts` — Volume mkdir 0o700 (was 0o777), added `boot.autostart: true`
- `health.ts` — `resp.status < 500` (was `resp.status > 0`)

**Testing (192.168.31.190):**
- SearXNG install → dedicated `market-searxng-redis` container created
- Wikiless install → dedicated `market-wikiless-redis` container created
- Volume permissions verified `drwx------` (0o700)
- `boot.autostart=true` verified on all new containers
- Bug found: metadata missing Redis containers → fixed in v0.1.87

### v0.1.85 (2026-02-14)

**Feature: SSO Integration for Temp Market Apps (Memos & Immich)**

Automatic Authentik OAuth2/OIDC configuration during market app installation. SSO button appears on app login pages. Full cleanup on uninstall.

**Key Changes:**
- `sso-setup.ts` — createAuthentikOAuth2App (list all providers + filter by client_id/name), removeAuthentikOAuth2App (same), configureMemosSSO (internal HTTP for tokenUrl/userInfoUrl), configureImmichSSO (internal HTTP for issuerUrl)
- `installer.ts` — Pass authentikInternalUrl to SSO config functions
- `uninstaller.ts` — Always try `youeye-market-${appId}` slug for cleanup

**Bugs Fixed:**
- Authentik search API doesn't match `client_id` → list all + filter
- Self-signed cert blocks server-to-server token exchange → use internal HTTP
- Uninstaller conditional SSO cleanup → always try standard slug

**Testing (on 192.168.31.190):**
- Install Memos with SSO: 7/7 steps pass
- SSO login: Full OAuth2 flow (redirect → auth → consent → token exchange → session)
- Uninstall: Authentik app + provider properly deleted
- Reinstall: No duplicate errors

### v0.1.81 (2026-02-13)

**Feature: Temp Market — One-Click App Marketplace**

Complete marketplace system for installing/uninstalling 6 third-party self-hosted apps. Each app deploys as OCI containers in Incus with automatic Caddy reverse proxy configuration and health checks.

**6 Supported Apps:**
- **Whoogle** — Privacy-focused Google search proxy (docker.io, port 5000)
- **SearXNG** — Privacy metasearch engine with shared Redis (docker.io, port 8080)
- **Redlib** — Reddit privacy frontend (quay.io, port 8080)
- **Wikiless** — Wikipedia privacy frontend with shared Redis (ghcr.io, port 8080)
- **Memos** — Note-taking app with shared PostgreSQL (docker.io, port 5230)
- **Immich** — Photo/video management with 4-container stack (ghcr.io, port 2283)

**New Files (18):**
- `src/lib/temp-market/definitions.ts` — App catalog (6 apps with metadata)
- `src/lib/temp-market/types.ts` — TypeScript interfaces
- `src/lib/temp-market/manifests.ts` — OCI manifest factories for all containers
- `src/lib/temp-market/installer.ts` — Install orchestrator with SSE progress
- `src/lib/temp-market/uninstaller.ts` — Uninstall (containers, routes, metadata)
- `src/lib/temp-market/status.ts` — Check installed/running status per app
- `src/lib/temp-market/health.ts` — HTTP and PostgreSQL health checks
- `src/lib/temp-market/metadata.ts` — Read/write install.json files
- `src/lib/temp-market/redis.ts` — Shared Redis lifecycle management
- `src/lib/temp-market/postgres-setup.ts` — Create/drop Memos database
- `src/lib/temp-market/searxng-config.ts` — Write SearXNG settings.yml
- `src/app/(dashboard)/temp-market/page.tsx` — Marketplace UI page
- `src/app/api/temp-market/install/route.ts` — POST SSE install stream
- `src/app/api/temp-market/uninstall/route.ts` — POST uninstall app
- `src/app/api/temp-market/status/route.ts` — GET app statuses
- `src/components/temp-market/app-card.tsx` — App card component
- `src/components/temp-market/install-dialog.tsx` — Install configuration dialog
- `src/components/temp-market/install-progress.tsx` — SSE progress display

**Modified Files:**
- `src/components/layout/sidebar.tsx` — Added Temp Market nav item
- `src/lib/apps/registry.ts` — Minor import adjustments
- `package.json` — Version 0.1.81

**Deployment Patterns Demonstrated:**
1. Simple standalone (Whoogle, Redlib) — 4 steps
2. Shared Redis dependency (SearXNG, Wikiless) — 5-6 steps
3. Shared PostgreSQL (Memos) — 5 steps
4. Multi-container with dedicated DB (Immich) — 8 steps

**Key Technical Decisions:**
- `ensureRoute()` wrapper for idempotent Caddy route creation (handles partial install retries)
- Immich PostgreSQL needs 2 GiB memory (pgvecto.rs loads ~400MB geocoding data)
- Immich server requires `IMMICH_HOST=0.0.0.0` (otherwise IPv6-only binding)
- 660s fetch timeout / 600s operation timeout for large OCI images (~1.5GB Immich ML)
- Shared Redis uses DB number isolation (SearXNG=DB0, Wikiless=DB1)
- Container naming: `market-{appId}` for single-container, `market-{appId}-{role}` for multi

**Bug fixes during development (v0.1.77→v0.1.81):**
- v0.1.78: Fixed CPU limits (`'0.5'`→`'1'` — Incus rejects fractional)
- v0.1.79: Fixed Redlib image (quay.io/redlib/redlib, added quay remote)
- v0.1.80: Fixed Immich PG OOM (512MiB→2GiB), fixed IPv6 binding (IMMICH_HOST=0.0.0.0)
- v0.1.81: Added ensureRoute() for idempotent route creation

**Testing (192.168.31.190):**
- All 6 apps: install + uninstall confirmed working
- Whoogle: Install 4/4 steps ✓, Uninstall ✓
- SearXNG: Install 6/6 steps ✓, Uninstall ✓ (shared Redis created/cleaned)
- Redlib: Install 4/4 steps ✓, Uninstall ✓
- Wikiless: Install 5/5 steps ✓, Uninstall ✓ (shared Redis reused/cleaned)
- Memos: Install 5/5 steps ✓, Uninstall ✓ (DB created/dropped in shared PG)
- Immich: Install 8/8 steps ✓, Uninstall ✓ (4 containers, ~7GB memory, 8+ min deploy)
- Health checks pass for all apps
- Caddy routes created and removed correctly
- Metadata files saved and cleaned up

---

### v0.1.76 (2026-02-12)

**Fix: Deployer continues past Authentik timeout**

The infrastructure deployer previously bailed out entirely when Authentik's health check timed out (step 3), skipping Caddy, Pi-Hole, and UI deployment. Authentik is slow to start (~3-5 min) and downstream steps don't depend on it being immediately healthy.

**Changes:**
- `src/lib/infrastructure/deployer.ts` — Removed `if (!healthy) return;` after Authentik health check. Deployment now continues through all 8 steps regardless of Authentik startup time.

**Testing:**
- Full deploy on dev server (192.168.31.190): Steps 1-8 all execute. Caddy deployed successfully even with Authentik still warming up.

---

### v0.1.75 (2026-02-12)

**Fix: Caddy config persistence across restarts**

After a VM restart, Caddy lost all routes pushed via Admin API because config was only held in memory. Implemented `--resume` flag approach which makes Caddy automatically save API-pushed config to `/config/caddy/autosave.json` and reload it on restart.

**Root Cause Analysis:**
- Caddy Admin API config is in-memory by default
- Previous attempts to write config files before container start failed (chicken-and-egg: container needed the file that needed the container to create it)
- Mounting a disk device at `/config` conflicted with Caddy's internal `XDG_CONFIG_HOME` directory

**Solution: `--resume` flag**
- Caddy's `--resume` flag auto-saves config pushed via `/load` endpoint to `/config/caddy/autosave.json`
- On restart, it loads autosave first, falling back to Caddyfile
- No external volume needed for `/config` — Caddy writes to its own container filesystem
- Eliminates ALL manual persistence code

**Changes:**
- `src/lib/infrastructure/manifests.ts` — Changed Caddy command to `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume`. Removed `/config` volume mount (kept `/data` for TLS certs only).
- `src/lib/infrastructure/deployer.ts` — Removed `initializeCaddyConfig` import and call from Step 6
- `src/lib/infrastructure/authentik-setup.ts` — Removed `initializeCaddyConfig()` function and unused imports
- `src/lib/caddy/client.ts` — Removed `persistConfigToDisk()` function, simplified `setConfig()` to just POST to Admin API

**Testing:**
- Deployed Caddy with `--resume` on dev server
- Pushed Authentik route via Admin API
- Restarted container — config persisted with both default and Authentik routes intact
- Port 80 proxy verified working from host

---

### v0.1.72 (2026-02-12)

**Feature: Unified Apps Tab with OCI Update Detection**

Complete overhaul of the Apps section. Consolidates all YouEye services (system components + OCI containers) into a single unified view with update detection, container controls, and SSE-powered update streaming.

**New Files:**
- `src/lib/apps/definitions.ts` — Single source of truth for 9 app definitions (host-system, incus, spine, control-panel, postgres, authentik, caddy, pihole, ui)
- `src/lib/apps/update-cache.ts` — Background 3-hour periodic update checking with in-memory cache
- `src/lib/apps/updater.ts` — OCI container rebuild via Incus API with snapshot-based rollback
- `src/app/api/apps/unified/route.ts` — GET /api/apps/unified combines definitions + Incus status + Spine status + digest cache
- `src/app/api/apps/[name]/update/route.ts` — POST SSE stream for app updates (OCI or Spine)
- `src/app/api/apps/[name]/check-update/route.ts` — POST per-app digest check
- `src/app/api/apps/check-updates/route.ts` — POST bulk check all OCI apps
- `src/app/(dashboard)/apps/[id]/page.tsx` — App detail page with container controls, update streaming, management links
- `src/app/(dashboard)/apps-legacy/page.tsx` — Copy of old apps page

**Modified Files:**
- `src/app/(dashboard)/apps/page.tsx` — Rewritten: unified list view with "Updates Available" section
- `src/lib/apps/registry.ts` — Rewritten: added digest checking functions (fetchRemoteDigest, checkAppUpdate, etc.)
- `src/lib/spine/client.ts` — Added getRegistryDigest method
- `src/components/layout/sidebar.tsx` — Removed "Updates" nav item, added "Apps (Legacy)"

**Architecture:**
- CP container now has internet access (firewall removed). Digest checks still go through Spine's `/api/registry/digest` endpoint for consistency
- OCI updates: CP creates snapshots → stops containers → rebuilds via Incus → starts → verifies → rollback on failure
- Spine-managed updates: proxied to Spine API (update self, control, incus, system, ui)

**Bug Fix (v0.1.71 → v0.1.72):**
- Fixed Next.js routing conflict: `[id]` vs `[name]` dynamic segments at `/api/apps/` level
- Moved new API routes from `[id]` to `[name]` to match existing convention

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.72
- Clean startup, no routing errors
- Spine registry digest endpoint verified for Docker Hub, GHCR images

---

### v0.1.70 (2026-02-12)

**Fix: UI SSO Environment Variables Not Loaded**

After running the setup wizard, the UI showed "SSO is not configured" because the LXD deployer's systemd service template did not include `EnvironmentFile` directive. The env file existed (written by Spine) but the service never loaded it.

**Root Cause:**
- `lxd-deployer.ts` created the UI systemd service without `EnvironmentFile=-/etc/youeye-ui.env`
- Spine's `handleUISSO` wrote the env file but only called `systemctl start` (no-op if already running)
- Result: UI process ran without AUTHENTIK_URL, AUTHENTIK_CLIENT_SECRET, etc.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Added `EnvironmentFile=-/etc/${spec.containerName}.env` to service template

**Testing:**
- Verified on dev server (192.168.31.190): UI login page shows `ssoConfigured: true` and "Sign in with Authentik" button
- All services healthy: UI 307, CP 307, Authentik 302

---

### v0.1.69 (2026-02-12)

**Fix: Authentik HTTP 400 Error via Caddy**

Caddy proxy returned HTTP 400 when accessing Authentik because the setup wizard configured the upstream port as 9443 (HTTPS) while Caddy sends plain HTTP.

**Changes:**
- `src/app/api/setup/run/route.ts` — Changed Authentik route port from 9443 to 9000

**Testing:**
- Verified on dev server: Authentik returns 302 via Caddy proxy

---

### v0.1.68 (2026-02-12)

**Feature: Infrastructure Deployment Moved from Spine to Control Panel**

All infrastructure app deployment logic previously in Spine (Go) has been moved to the Control Panel (TypeScript). Spine now only: (1) installs Incus, (2) starts its API, (3) deploys the CP container, (4) calls the CP's SSE endpoint to deploy everything else.

**Architecture:**
- SSE endpoint at `/api/deploy/infrastructure` deploys 8 steps: PostgreSQL, Authentik DB setup, Authentik server, Authentik worker, API token, Caddy, Pi-Hole, YouEye UI
- OCI containers deployed via Incus REST API (Unix socket)
- LXD containers (YouEye UI) deployed as Debian + Node.js with systemd service
- Secrets stored in `/var/lib/youeye/` per-service with auto-generation
- Keepalive SSE comments every 10s prevent idle timeout during long operations

**New Files (10):**
- `src/lib/infrastructure/types.ts` — OCIManifest, LXDContainerSpec, DeploymentEvent types
- `src/lib/infrastructure/manifests.ts` — All 7 app manifests (postgres, authentik, caddy, pihole, ui)
- `src/lib/infrastructure/secrets.ts` — Secret generation and persistence
- `src/lib/infrastructure/oci-deployer.ts` — OCI container lifecycle via Incus API
- `src/lib/infrastructure/lxd-deployer.ts` — LXD container deploy with Node.js + systemd
- `src/lib/infrastructure/health-checks.ts` — Service health checks (postgres, authentik, caddy, pihole)
- `src/lib/infrastructure/postgres-setup.ts` — Authentik database/user creation via psql
- `src/lib/infrastructure/authentik-setup.ts` — API token creation, Caddy route setup
- `src/lib/infrastructure/deployer.ts` — Main orchestrator (8-step sequential deployment)
- `src/app/api/deploy/infrastructure/route.ts` — SSE endpoint with auth and keepalive

**Modified Files:**
- `src/lib/incus/server.ts` — Added `execCommand`/`execShell` with chunked `/wait?timeout=30` polling, `incusRawGet` for log files
- `src/middleware.ts` — Added `/api/deploy/infrastructure` to API routes

**Key Bugs Fixed:**
- SSE idle timeout: Added keepalive comments every 10s
- Port 3000 conflict: Made port proxy errors non-fatal (UI port 3000 vs CP port 3000)
- Missing systemd service: LXD deployer now creates and starts `.service` file
- Socket timeout in execCommand: Changed from bare `/wait` to chunked `/wait?timeout=30` with retry
- npm install styled-jsx: Replaced with direct curl from npm registry (avoids 3min+ pnpm node_modules scanning)
- Service file creation: Uses base64 encode/decode instead of heredoc for reliability over exec API

**Testing:**
- 5 iterative deploy cycles on dev server (192.168.31.190)
- All 7 containers deploy and run: postgres, authentik (server+worker), caddy, pihole, control, ui
- CP returns 200, Authentik healthy, Pi-Hole DNS resolving, UI service active
- `spine deploy` exits 0 with full SSE stream

---

### v0.1.62 (2026-02-11)

**Feature: Auto Pi-Hole DNS Rewrite on Domain Change**

When a user configures a domain name (via setup wizard or proxy page), Pi-Hole automatically gets a wildcard DNS entry so `domain.com` and `*.domain.com` resolve to the server's LAN IP.

**How it works:**
- Uses Pi-Hole FTL v6 `misc.dnsmasq_lines` config API
- Single `address=/domain.com/IP` directive handles base domain + all subdomains
- Old domain entries are automatically cleaned up on domain change
- Runs silently — no UI changes needed, errors are non-critical

**Changes:**
- `src/lib/apps/pihole-api.ts` — Added `getDnsmasqLines()`, `setDnsmasqLines()`, `setDomainDNS()`, `removeDomainDNS()` functions
- `src/app/api/setup/run/route.ts` — Added DNS step after Caddy routes in setup wizard
- `src/app/api/domain/route.ts` — Added Pi-Hole DNS rewrite + Spine config sync on domain POST

**Bug Fix:**
- Proxy page domain POST was not syncing to Spine config. Added `spineClient.patchConfig({ domain })` call.

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.62
- Set domain to `mytest.local` → Pi-Hole entry added, DNS resolves correctly
- Changed to `newdomain.example` → old entry removed, new entry added
- Wildcard works: `app.newdomain.example` resolves to `192.168.31.190`
- Old domain `mytest.local` returns NXDOMAIN after change
- Spine config synced correctly

---

### v0.1.60 (2026-02-10)

**Feature: Setup Wizard + White-Labeling**

Initial setup wizard for first-time configuration, plus white-labeling support using dynamic `site_name` from Spine config.

**Setup Wizard:**
- `src/app/setup/layout.tsx` — Minimal centered layout (no sidebar)
- `src/app/setup/page.tsx` — 3-step client wizard: server config, admin account, SSE installation progress
- `src/app/api/setup/config/route.ts` — Public GET for config check, admin PUT for updates
- `src/app/api/setup/run/route.ts` — Full SSE-streamed setup: save config, create Caddy routes, create admin user, configure SSO for CP + UI, write site_name to UI DB, mark setup complete
- `src/lib/spine/client.ts` — Added `getConfig()`, `setConfig()`, `patchConfig()` methods
- `src/middleware.ts` — Added `/api/setup/config` to PUBLIC_ROUTES

**White-Labeling:**
- `src/lib/site-config.ts` — Server-side `getSiteConfig()` reads from Spine
- `src/hooks/use-site-config.ts` — Client-side `useSiteConfig()` hook
- `src/app/layout.tsx` — Dynamic `generateMetadata()` using site_name
- `src/app/login/page.tsx` — Login heading uses site_name
- `src/app/(dashboard)/settings/page.tsx` — UI section uses site_name

**Bug Fix:**
- GET `/api/setup/config` was returning 401 because the route handler had its own `getSession()` check. Removed session check from GET (public endpoint for setup-check). PUT still requires admin auth.

**Testing:**
- Deployed to dev server (192.168.31.190)
- `/api/setup/config` returns 200 with config (verified public access)
- Login page renders with dynamic title ("YouEye Control Panel")
- Setup page requires authentication (redirects to login)

---

### v0.1.59 (2026-02-10)

**Fix: Spine client timeout race**

Increased Spine Unix socket client timeout from 30s to 60s. The old timeout raced with Spine's health check loop (30s max), causing "Request timeout" when enabling UI.

**Changes:**
- `src/lib/spine/client.ts` — `req.setTimeout(60000)` (was 30000)

**Testing:**
- Deployed to dev server, full deploy passes, 7 containers running

---

### v0.1.56 (2026-02-09)

**Feature: YouEye UI Management (Phase 2)**

Automated UI container lifecycle management from the Settings page.

**Changes:**
- Settings page: Added YouEye UI section (visible when SSO configured + UI installed)
  - Domain input with auto-suggestion (ui.{domain})
  - Enable UI button: creates Authentik OAuth2, Caddy route, DB, starts service
  - Disable UI button: removes Authentik resources, Caddy route, stops service
  - Live status indicator (not-installed/installed/running)
- New API route: `/api/ui` (GET status, POST enable, DELETE disable)
- New library: `src/lib/ui/manager.ts` — full UI lifecycle management
- Spine client: added getUISSO(), setUISSO(), deleteUISSO(), updateUI() methods
- SpineStatusResponse: added `ui` field with status/installed/enabled/version/ip

**Testing:**
- Deployed to dev VM (192.168.31.190)
- Spine API returns correct UI status (installed, enabled, version, IP)
- CP Settings page bundle includes full UI management code
- API route `/api/ui` responds correctly

### v0.1.55 (2026-02-09)

**Fix: SSO Callback Redirect — All Redirects Now Use CONTROL_EXTERNAL_URL**

**Problem:**
After SSO login with Authentik, the browser was redirected to `http://0.0.0.0:3000/` instead of `https://control.skibidi.wtf/`. The v0.1.54 fix only applied `CONTROL_EXTERNAL_URL` to the OAuth2 token exchange `redirect_uri`, but the `NextResponse.redirect()` calls for navigation (success → `/`, errors → `/login?error=...`) still used `request.url` as the base URL. Inside the container, `request.url` resolves to `http://0.0.0.0:3000/...`.

**Root Cause:**
`NextResponse.redirect(new URL('/', request.url))` uses `request.url` which is `http://0.0.0.0:3000/api/auth/callback?code=...` inside the container.

**Solution:**
Compute `baseUrl` once at the top of the GET handler from `CONTROL_EXTERNAL_URL` (with forwarded-header fallback), then use it for ALL redirects — not just the token exchange redirect_uri.

**Deployment Note:**
Previous deployment used `rm -rf /opt/app/*` which doesn't remove dotfiles (`.next` directory). The old `.next` survived, causing stale compiled chunks to be served. Fixed by using `rm -rf /opt/app && mkdir -p /opt/app` to fully remove the directory including dotfiles.

**Modified Files:**
- `src/app/api/auth/callback/route.ts` — Moved `baseUrl` computation above all early returns, all `NextResponse.redirect(new URL(..., request.url))` changed to `new URL(..., baseUrl)`
- `package.json` — Version 0.1.55

**Testing (192.168.31.190):**
- `curl -sI http://10.117.96.245:3000/api/auth/callback` → `location: https://control.skibidi.wtf/login?error=Missing+code+or+state` (was `http://0.0.0.0:3000/...`)
- `spine status` → Control Panel: Running (v0.1.55)
- Process env verified: `CONTROL_EXTERNAL_URL=https://control.skibidi.wtf` present in node process

---

### v0.1.54 (2026-02-09)

**Fix: SSO Redirect URL & Authentik 2025.12 Compatibility**

**Summary:**
Fixed SSO redirect_uri going to `0.0.0.0:3000` instead of the proper subdomain. Added `CONTROL_EXTERNAL_URL` env var for explicit redirect URI control. Updated SSO setup to pass `control_url` to Spine for env injection.

**Problem:**
When the Control Panel runs inside an Incus container with `listen: 0.0.0.0:3000`, the `request.headers.get('host')` returns `0.0.0.0:3000` instead of the actual subdomain. This caused OAuth2 redirect_uri to be set incorrectly, breaking SSO login flow.

**Solution:**
Use `process.env.CONTROL_EXTERNAL_URL` (injected by Spine via systemd EnvironmentFile) as the authoritative source for the redirect URI. Falls back to request headers if env var not set.

**Modified Files:**
- `src/app/api/auth/sso/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI, fixed `secure` cookie flag to use `redirectUri.startsWith('https://')` instead of out-of-scope `proto` variable
- `src/app/api/auth/callback/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI
- `src/lib/auth/sso-setup.ts` - Pass `control_url: params.controlExternalUrl` to `spineClient.setControlSSO()`
- `src/lib/spine/client.ts` - Added `control_url: string` to `setControlSSO` params type
- `package.json` - Version 0.1.54

**Testing (192.168.31.190):**
- SSO setup successful with Authentik 2025.12
- Redirect URI: `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in SSO env file
- Auth mode correctly reports `ssoConfigured: true`

---

### v0.1.53 (2026-02-08)

**Feature: Self-Service SSO Setup via Settings Page**

**Summary:**
Complete SSO implementation allowing the Control Panel to configure its own Authentik SSO through a new Settings page UI. When accessed via IP address, login uses PAM. When accessed via subdomain, login uses Authentik SSO (no PAM option).

**How it works:**
1. Settings page checks prerequisites (domain configured, Authentik + CP subdomains in Caddy, Authentik healthy)
2. "Setup SSO" button creates OAuth2 Provider + Application in Authentik via API
3. Creates groups scope mapping for admin detection via OIDC
4. Spine stores env vars (`AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_INTERNAL_URL`) via systemd drop-in
5. CP restarts with SSO env vars loaded
6. Auth mode detection: PAM on IP access, SSO on subdomain access

**Key Design Decisions:**
- Uses Authentik 2024.12 API paths (`/propertymappings/provider/scope/`, dict-format `redirect_uris`)
- `AUTHENTIK_INTERNAL_URL` (Incus DNS `http://youeye-authentik.incus:9000`) for server-side token exchange to avoid self-signed TLS issues
- `AUTHENTIK_URL` (external URL like `https://id.skibidi.wtf`) for browser redirects
- Systemd EnvironmentFile drop-in (`sso.conf`) for clean env injection that survives CP updates

**New Files:**
- `src/lib/auth/sso-setup.ts` - Core SSO setup/teardown logic (Authentik API calls)
- `src/app/api/auth/sso/status/route.ts` - GET endpoint: SSO prerequisites and configuration status
- `src/app/api/auth/sso/setup/route.ts` - POST endpoint: Execute SSO setup
- `src/app/api/auth/sso/disable/route.ts` - POST endpoint: Disable SSO
- `src/app/(dashboard)/settings/page.tsx` - Settings page with SSO prerequisites checklist and setup/disable buttons

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added Settings nav item
- `src/lib/spine/client.ts` - Added `getControlSSO()`, `setControlSSO()`, `deleteControlSSO()` methods
- `src/lib/auth/authentik.ts` - Added `AUTHENTIK_INTERNAL_URL` for server-side calls, `groups` scope
- `src/middleware.ts` - Block PAM login on subdomain access (403), exact-match SSO public route

**Testing (192.168.31.190):**
- SSO prerequisites all met (domain, subdomains, Authentik health)
- Setup creates OAuth2 provider/app in Authentik, configures env vars
- Auth mode: `pam` on IP, `sso` on subdomain
- SSO redirect to `https://id.skibidi.wtf/application/o/authorize/` with correct params
- PAM login blocked on subdomain with 403 error
- Disable/re-enable cycle works
- Version 0.1.53 deployed and verified

---

### v0.1.51 (2026-02-08)

**Bug Fixes: Updates Page Crash, LAN Port Untick, People Create 500**

**Summary:**
Three bugs found during manual testing on user's test server, plus a backend fix discovered during verification:

1. **Bug 1 - Updates page crash**: `Cannot read properties of undefined (reading 'split')`. The TypeScript `AppInfo` interface used `container` and `image` fields, but Spine API returns `container_name` and `image_tag`. The line `app.image.split(':').pop()` crashed on undefined.
2. **Bug 2 - LAN port checkbox snap-back**: After enabling LAN port, unticking the checkbox and pressing save would visually revert to ticked. The checkbox was controlled by `state.lanEnabled` which only updated after API response, not optimistically.
3. **Bug 2b - LAN port device not removed**: Even with the frontend fix, the Incus PATCH method merges device maps and cannot delete keys. Changed to PUT with full config to properly remove the `lan-web` device.
4. **Bug 3 - People API 500 on create**: `createUser()` succeeded but `setUserPassword()` failed (Authentik password policy), causing 500 that masked successful user creation.

**Modified Files:**
- `src/lib/spine/client.ts` - Fixed `SpineUpdatesCheckResponse.apps` type: `container`→`container_name`, `image`→`image_tag`, added `available: boolean`
- `src/app/(dashboard)/updates/page.tsx` - Fixed `AppInfo` interface, replaced crash-prone `app.image.split(':').pop()` with safe `app.image_tag || 'latest'`
- `src/components/proxy/container-routing-table.tsx` - Optimistic `lanEnabled` state update on checkbox click, revert on API failure
- `src/app/api/containers/[name]/lan-port/route.ts` - Changed PATCH to PUT with full instance config (architecture, config, devices, profiles) so device removal actually works
- `src/app/api/people/route.ts` - Wrapped `setUserPassword()` in separate try/catch, returns `{ success: true, passwordWarning }` instead of 500

**Testing (192.168.31.190):**
- Updates page: returns 200, API returns correct `container_name`/`image_tag` fields
- LAN port: enable (port 8888) adds `lan-web` device, disable removes it completely
- People create: returns `{ success: true, passwordWarning }` instead of 500
- No errors in control panel logs after deployment
- v0.1.51 deployed and verified

---

### v0.1.49 (2026-02-08)

**Multi-Feature: People Tab, Proxy Simplification, Updates Apps, SSO Dual-Auth**

**Summary:**
Four major features implemented in a single release:
1. **CP1 - People Management Tab**: Full user CRUD via Authentik API. List/create/delete users, toggle admin (via "authentik Admins" group), set passwords, show/hide hidden system users.
2. **CP2 - Proxy Simplification**: Rewrote routing table to subdomain-only (removed path routing). Added LAN Port column with checkbox + port input to expose containers directly on host.
3. **CP3 - Updates Page Apps**: Extended updates page with Incus version, system packages count, and app container cards with rebuild button.
4. **CP4 - SSO Dual-Auth**: OAuth2 login via Authentik when accessed through subdomain. IP-based access uses PAM. Auto-detects mode at login.

**New Files:**
- `src/app/(dashboard)/people/page.tsx` - People management page with user table, create form, password dialog
- `src/app/api/people/route.ts` - GET (list users) and POST (create user) with admin group detection
- `src/app/api/people/[id]/route.ts` - PATCH (update user, toggle admin) and DELETE
- `src/app/api/people/[id]/password/route.ts` - POST to set user password
- `src/app/api/containers/[name]/lan-port/route.ts` - POST to add/remove Incus proxy device for LAN port
- `src/lib/auth/authentik.ts` - OAuth2 helper (buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, isSSOConfigured)
- `src/app/api/auth/sso/route.ts` - GET: initiates OAuth2 flow, redirects to Authentik
- `src/app/api/auth/callback/route.ts` - GET: OAuth2 callback, exchanges code, creates JWT session
- `src/app/api/auth/mode/route.ts` - GET: returns 'pam' or 'sso' based on Host header

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added People nav item between DNS and Updates
- `src/components/proxy/container-routing-table.tsx` - Complete rewrite: subdomain-only + LAN port column
- `src/app/(dashboard)/proxy/page.tsx` - Updated description text
- `src/app/api/containers/route.ts` - Added lanPort field with getLanPort() helper
- `src/lib/spine/client.ts` - Extended SpineUpdatesCheckResponse with incus/system/apps, added updateApp()
- `src/app/(dashboard)/updates/page.tsx` - Complete rewrite: Incus/System/App cards, rebuild button
- `src/app/api/updates/[component]/route.ts` - Unknown components now route to updateApp()
- `src/middleware.ts` - Added SSO/callback/mode to PUBLIC_ROUTES
- `src/app/login/page.tsx` - Split into Suspense wrapper + LoginContent, auth mode detection, SSO redirect

**Bug Fix (v0.1.49):**
- LAN port API now checks Incus response for errors (previously returned success even on failure)

**Testing (192.168.31.190):**
- Spine v0.1.27 + CP v0.1.49 deployed, all 7 containers running
- Auth mode API: returns `pam` for IP access, `sso` when configured
- People API: lists Authentik users with admin group detection
- LAN port: successfully adds/removes Incus proxy devices (tested on Pi-Hole port 9999)
- Updates API: returns incus v6.21, system 70 packages, 5 app containers
- Login page loads correctly (200)
- All pages accessible: /updates, /people, /proxy (200)

---

### v0.1.47 (2026-02-08)

**Authentik in Reverse Proxy Routing Table**

**Summary:**
Set `webPort: 9000` in Authentik manifest so it appears in the reverse proxy routing table on the proxy page. Also includes Authentik management page scaffolding (users, groups, stats API routes).

**Code Changes:**
- `src/lib/apps/manifest.ts` - Changed Authentik `webPort: undefined` to `webPort: 9000`
- `src/app/(dashboard)/apps/authentik/page.tsx` - NEW: Authentik management page
- `src/app/api/apps/authentik/stats/route.ts` - NEW: Authentik stats API
- `src/app/api/apps/authentik/users/route.ts` - NEW: Users API
- `src/app/api/apps/authentik/groups/route.ts` - NEW: Groups API
- `src/lib/authentik/client.ts` - NEW: Authentik API client library

**Testing (192.168.31.190):**
- CP v0.1.47 deployed, `spine update control` successful
- Containers API returns Authentik with `webPort: 9000` and `status: running`
- Three containers in proxy routing table: Control Panel (3000), Pi-Hole (80), Authentik (9000)

---

### v0.1.45 (2026-02-08)

**Security: Fetch Pi-Hole Password from Spine API**

**Summary:**
Removed hardcoded `DEFAULT_PIHOLE_PASSWORD` constant. Pi-Hole password is now fetched from Spine's `/api/pihole/credentials` API endpoint. Password changes are synced back to the host file via Spine API.

**Code Changes:**
- `src/lib/spine/client.ts` - Added `SpinePiholeCredentials` interface, `getPiholeCredentials()` (GET), `updatePiholePassword(password)` (POST)
- `src/lib/apps/secrets.ts` - Removed `DEFAULT_PIHOLE_PASSWORD = 'youeye_admin'`; `getPiholePassword()` now fetches from Spine API with systemd env fallback; `setPiholePassword()` syncs to host file via Spine API; `initializePiholePassword()` fetches from Spine if no explicit password; `hasCustomPiholePassword()` checks for empty string instead of comparing to hardcoded default

**Testing (192.168.31.190):**
- CP v0.1.45 deployed and healthy
- Spine Pi-Hole credentials API returns password
- Health check passes

---

### v0.1.44 (2026-02-09)

**PostgreSQL Management UI & SQL Console**

**Summary:**
Added full PostgreSQL management page with 4 tabs (Overview, Databases, SQL Console, Connection Info). Queries PostgreSQL via `incus exec` + psql (no npm pg dependency needed). Includes read-only SQL console for safe query execution.

**Code Changes:**
- `src/lib/postgres/client.ts` - NEW: PostgreSQL client using execShell + psql --csv. Functions: psqlQuery(), parseCSVLine(), queryReadOnly() (wraps in READ ONLY transaction), listDatabases(), getStats()
- `src/lib/incus/server.ts` - Added `incusRawGet()` for fetching exec log file content. Fixed `execCommand()` to fetch stdout/stderr from Incus log file paths instead of returning paths as content.
- `src/lib/apps/manifest.ts` - Added POSTGRES_MANIFEST (postgres:17-alpine)
- `src/lib/spine/client.ts` - Added getPostgresCredentials()
- `src/app/api/apps/postgres/stats/route.ts` - NEW: GET endpoint returning version, uptime, connections, database sizes
- `src/app/api/apps/postgres/databases/route.ts` - NEW: GET endpoint returning database list with owner, encoding, size
- `src/app/api/apps/postgres/query/route.ts` - NEW: POST endpoint for read-only SQL execution with CSRF protection
- `src/app/(dashboard)/apps/postgres/page.tsx` - NEW: 4-tab management page (Overview, Databases, SQL Console, Connection Info)
- `src/app/(dashboard)/apps/page.tsx` - Added PostgreSQL card with database icon and Manage link

**Key Decisions:**
- Used execShell + psql instead of `pg` npm package (Turbopack bundling breaks pg module resolution)
- Added incusRawGet for raw HTTP requests to Incus log endpoints (exec output stored in files, not returned inline)
- Filtered psql command tags (BEGIN, COMMIT, SET) from CSV output to prevent parser confusion
- Connected as `-U youeye` role (not default `postgres` role, since POSTGRES_USER=youeye)

**Bug Fixes (iterations v0.1.38 → v0.1.44):**
- v0.1.38: Initial implementation with `pg` npm package
- v0.1.39: Added serverExternalPackages for pg (didn't fix Turbopack issue)
- v0.1.40: Rewrote to use execShell + psql (removed pg dependency entirely)
- v0.1.41: Fixed execCommand returning log file paths instead of content (added incusRawGet)
- v0.1.42: Fixed psql connecting as wrong role (added `-U youeye`)
- v0.1.43: Fixed uptime query single-quote escaping
- v0.1.44: Filtered psql command tags from CSV output

**Testing (192.168.31.190):**
- 33/33 Playwright e2e tests passing (9 new PostgreSQL tests)
- Stats endpoint: version, uptime, connections, database sizes
- Databases endpoint: youeye + postgres databases with correct owner/encoding
- SQL Console: SELECT queries execute correctly with proper column/row parsing
- Write protection: CREATE TABLE rejected in READ ONLY transaction
- All existing Caddy/Pi-Hole/auth tests still passing

---

### v0.1.37 (2026-02-08)

**Remove install infrastructure, simplify to Spine-deployed apps**

**Summary:**
Removed all container install/deploy functionality from the Control Panel. Apps (Caddy, Pi-Hole, Postgres, Redis, Authentik) are now deployed exclusively by Spine. CP only manages already-deployed containers. Removed ~3000 lines of install code. Container firewall was later removed to allow internet access.

**Code Changes:**
- Deleted: `src/app/api/apps/install/route.ts` (315 lines) - Install API
- Deleted: `src/app/api/test/install-app/route.ts` (405 lines) - Test install API
- Deleted: `src/app/(dashboard)/apps/postgres/page.tsx` (647 lines) - Postgres management UI
- Deleted: `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik page
- Deleted: `src/app/api/apps/postgres/*` (databases, stats, users routes)
- Deleted: `src/app/api/apps/authentik/stats/route.ts`
- `src/lib/apps/manifest.ts` - Simplified from 362 to 53 lines. Only Caddy + Pi-Hole manifests. Removed OCI config generation, parseOCIImage, manifestToIncusConfig.
- `src/lib/apps/registry.ts` - Removed getRegistry, getAppInstance, isBuiltInApp, fetchRemoteRegistry
- `src/types/apps.ts` - Removed 'installing' status, PortMapping, HealthCheck, AppRegistry, InstallAppRequest
- `src/app/(dashboard)/apps/page.tsx` - Rewritten: simple 2-column card grid, no install buttons, Manage links
- `src/app/(dashboard)/proxy/page.tsx` - Removed installCaddy, shows "spine deploy" message when not deployed
- `src/app/(dashboard)/dns/page.tsx` - Removed installPihole, shows "spine deploy" message when not deployed
- `src/middleware.ts` - Removed /api/test/install-app from PUBLIC_ROUTES
- `src/components/proxy/proxy-status-card.tsx` - Removed manifest.version reference
- Removed `@playwright/test` from devDependencies (was added in error)

**Testing (192.168.31.190):**
- 24/24 Playwright e2e tests passing (standalone test suite in YouEye-Agents)
- Verified no install buttons on apps/proxy/dns pages
- Verified no postgres/authentik/redis cards on apps page
- Verified API returns exactly 2 apps (Caddy + Pi-Hole)
- Verified removed API routes return 401/404
- Container has internet access (firewall was later removed)

---

### v0.1.36 (2026-02-07)

**Fix: Pi-Hole password change, auth race condition, wildcard TLS, HTTP redirect**

**Summary:**
Fixed three Pi-Hole bugs and two Caddy HTTPS issues. Password change returned 400 due to field name mismatch. Multiple simultaneous API calls caused 429 rate-limit errors from Pi-Hole FTL. Caddy accumulated redundant per-subdomain TLS certs instead of using wildcard. HTTP did not redirect to HTTPS.

**Root Causes:**
1. `dns/page.tsx` sent `{ password: newPassword }` but backend expected `{ newPassword }`
2. `pihole-api.ts` `getSession()` had no lock - parallel requests all called `authenticate()` simultaneously, triggering Pi-Hole FTL 429 rate-limit
3. `caddy/client.ts` `ensureTLSSubject()` added individual subdomain certs even when `*.domain` wildcard existed
4. `caddy/client.ts` `ensureHTTPSConfig()` added `:80` to server listen array, causing routes to be served on both ports instead of redirecting

**Code Changes:**
- `src/app/(dashboard)/dns/page.tsx` - Fixed field name: `{ password: newPassword }` → `{ newPassword }`
- `src/lib/apps/pihole-api.ts` - Added Promise-based mutex lock to `getSession()` so only first request authenticates, others wait
- `src/lib/caddy/client.ts` - `ensureTLSSubject()`: skip adding subdomain if covered by wildcard
- `src/lib/caddy/client.ts` - `setDomain()`: clean up stale per-subdomain subjects, keep only `domain` + `*.domain`
- `src/lib/caddy/client.ts` - `ensureHTTPSConfig()`: remove `:80` from listen array, let Caddy auto-create redirect server
- `src/lib/caddy/client.ts` - Initial server creation: only listen on `:443`

**Testing (192.168.31.190):**
- Password change: 200 OK (was 400)
- 4 parallel Pi-Hole API calls: all succeeded, no 429 errors (was getting 429)
- TLS subjects cleaned to only `skibidi.wtf` + `*.skibidi.wtf` (was accumulating stale per-subdomain certs)
- Wildcard skip log: `Skipping TLS subject pihole.skibidi.wtf - covered by wildcard *.skibidi.wtf`
- HTTP redirect: 308 Permanent Redirect to HTTPS (was serving routes on port 80)
- HTTPS access: 302 from Pi-Hole (working)
- Server listeners: only `:443` (was `:443` + `:80`)

**IMPORTANT - TLS is self-signed:**
Caddy uses `module: internal` (self-signed via Caddy's internal CA), NOT Let's Encrypt. This is for local LAN only.

---

### v0.1.35 (2026-02-05)

**Fix: Pi-Hole FTL v6 API Authentication**

**Summary:** 
Fixed Pi-Hole integration to use SID URL parameter instead of Cookie header.

**Root Cause:**
Pi-Hole FTL v6+ requires the session ID (`sid`) to be passed as a URL query parameter (`?sid=xxx`), NOT as a Cookie header (`Cookie: sid=xxx`). The previous implementation used Cookie authentication which returned "Unauthorized" errors.

**Code Changes:**
- `src/lib/apps/pihole-api.ts`: NEW FILE - Complete Pi-Hole FTL v6 API client with session management
- Changed `piholeRequest()` to append `?sid=xxx` to URL instead of using Cookie header
- Updated all Pi-Hole route handlers to use new `pihole-api.ts` library

**Endpoints Updated:**
- `/api/apps/pihole/stats` - Uses `getStats()`
- `/api/apps/pihole/queries` - Uses `getQueryLog()`
- `/api/apps/pihole/dns-records` - Uses `getDNSRecords()`, `addDNSRecord()`, `removeDNSRecord()`
- `/api/apps/pihole/cname-records` - Uses `getCNAMERecords()`, `addCNAMERecord()`, `removeCNAMERecord()`
- `/api/apps/pihole/domains` - Uses `getDomainLists()`, `addDomain()`, `removeDomain()`
- `/api/apps/pihole/control` - Uses `setBlocking()`
- `/api/apps/pihole/password` - Added `clearPiholeSession()` call

**Testing:**
- Tested from dev server (192.168.31.190)
- Auth: `POST /api/auth` returns valid session with SID
- Stats with ?sid= parameter returns full summary data
- Cookie authentication confirmed NOT working (returns unauthorized)

---

### v0.1.32 (2026-02-05)

**Bug Fixes: Volume Permissions, Pi-Hole Web Server, Test API Middleware**

**Summary:** 
- Fixed Caddy volume permission issues with `shift: true`
- Fixed Pi-Hole FTL v6+ web server with `FTLCONF_webserver_port`
- Added test endpoint to PUBLIC_ROUTES to bypass JWT auth

**Root Causes:**
1. **Caddy Permission Denied:** Incus UID mapping caused `/data` to be owned by `nobody:nobody` inside container.
   Volume devices need `shift: 'true'` to enable Incus ID shifting.
2. **Pi-Hole Web Interface Down:** FTL v6+ has built-in web server but requires explicit `FTLCONF_webserver_port` env var.
3. **Test API Unauthorized:** Middleware required JWT for all routes - test endpoint uses X-Test-Secret header instead.

**Code Changes:**
- `src/lib/apps/manifest.ts`: Added `shift: 'true'` to disk device config in `manifestToIncusConfig()`
- `src/lib/apps/manifest.ts`: Added `FTLCONF_webserver_port: '80'` to Pi-Hole environment
- `src/middleware.ts`: Added `/api/test/install-app` to PUBLIC_ROUTES

**Testing:**
- Verified Caddy `/data/caddy` owned by `root:root` (not `nobody:nobody`)
- Verified Pi-Hole web interface responds on port 8080 (HTTP 302)
- Test API returns app list successfully

---

### v0.1.31 (2026-02-05)

**Feature: Test Install API Endpoint**

**Summary:** Added `/api/test/install-app` endpoint for automated app installation testing.

**Purpose:**
Provides a secure way for Iris (AI agent) to install/uninstall apps for testing without browser login.

**Security:**
- Requires `TEST_ADMIN_SECRET` environment variable (generated by Spine)
- Validates `X-Test-Secret` header against env var
- Rate limited (5 seconds between requests)
- Logged for audit trail

**API:**
```
GET /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Returns: List of available apps with status

POST /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Body: { "appName": "pihole", "action": "install" | "uninstall" }
  Returns: Success/failure status
```

**Code Changes:**
- `src/app/api/test/install-app/route.ts`: NEW FILE - Secure test endpoint

---

### v0.1.30 (2026-02-05)

**Bug Fix: Pi-Hole Password Change Using Incus REST API**

**Summary:** Rewrote Pi-Hole password change to use Incus REST API instead of shell commands.

**Root Cause:**
The `setPiholePassword()` function in `secrets.ts` was using `exec('incus config set ...')` to store the password.
This fails inside the Control Panel container because there is no `incus` binary installed - the container 
only has access to the Incus Unix socket, not the CLI tools.

**Solution:**
Changed `setPiholePassword()` to use `incusRequest()` to call the Incus REST API via Unix socket:
- Uses `PATCH /1.0/instances/youeye-pihole` to update container config.user.password
- Uses `updateInstanceState()` to restart the container after password change
- Changed `execInControl` to `execLocal` for local command execution

**Code Changes:**
- `src/lib/apps/secrets.ts`:
  - Added imports: `incusRequest`, `updateInstanceState` from `@/lib/incus/server`
  - Rewrote `setPiholePassword()` to use Incus REST API
  - Changed `execInControl` to `execLocal` for retrieving Incus configuration

**Testing:**
- Fresh `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.15 + Control Panel v0.1.30 running
- CSRF endpoint accessible
- Login page loads correctly

---

### v0.1.29 (2026-02-05)

**Bug Fix: CSRF Endpoint Blocked by Middleware**

**Summary:** Added `/api/auth/csrf` to PUBLIC_ROUTES so it can be accessed without authentication.

**Root Cause:**
The CSRF endpoint was returning 401 Unauthorized because middleware blocked unauthenticated access.

**Fix:**
Added `/api/auth/csrf` to PUBLIC_ROUTES array in middleware.ts.

**Code Changes:**
- `src/middleware.ts` - Added `/api/auth/csrf` to PUBLIC_ROUTES

**Testing:**
- CSRF endpoint returns 200 with `{"csrfToken":null}` when no cookie present
- Accessible both internally and externally

---

### v0.1.28 (2026-02-05)

**Bug Fixes: CSRF Endpoint & Pi-Hole DNS Port Binding**

**Summary:** 
1. Created missing CSRF token endpoint
2. Fixed Pi-Hole DNS port 53 conflict with Incus dnsmasq

**Issue 1: CSRF 404**
Pages were fetching `/api/auth/csrf` which didn't exist.

**Fix 1:**
Created CSRF endpoint that reads `ye-csrf` cookie and returns the token.

**Issue 2: Pi-Hole Port 53 Conflict**
Incus dnsmasq binds to bridge IP (10.x.x.x:53). Pi-Hole tried to bind to 0.0.0.0:53 which conflicted.

**Fix 2:**
- Added `getHostExternalIP()` function that reads from `HOST_IP` env var
- Added `fixPiHoleDNSBinding()` that modifies DNS proxy devices to use host external IP instead of 0.0.0.0
- Special handling for `manifest.name === 'pihole'`

**New Files:**
- `src/app/api/auth/csrf/route.ts` - Returns CSRF token from ye-csrf cookie

**Modified Files:**
- `src/app/api/apps/install/route.ts` - Added Pi-Hole DNS binding fix

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- CSRF endpoint returns 200
- Pi-Hole DNS devices will bind to HOST_IP (192.168.31.190)

---

### v0.1.27 (2026-02-05)

**Bug Fix: Pi-Hole Restart Button Not Working**

**Summary:** Added container actions (start/stop/restart) to Pi-Hole control API.

**Root Cause:**
The Pi-Hole control API only accepted `enable` and `disable` actions. When the UI sent a `restart` action, it was rejected as invalid.

**Fix:**
Added container lifecycle actions using Incus REST API:
- `start` - Start the container
- `stop` - Stop the container  
- `restart` - Restart the container (force + stateful)

**Code Changes:**
- `src/app/api/apps/pihole/control/route.ts`:
  - Added `containerAction()` helper function using `incusRequest('PUT', '/1.0/instances/.../state', {...})`
  - Added start/stop/restart to allowed actions array
  - Fixed import: now imports from `@/lib/incus/server` instead of `@/lib/incus/client`

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.27 running (Next.js 16.1.4)
- All services operational

---

### v0.1.26 (2026-02-05)

**Major Feature: Pi-Hole Enhanced Authentication & Local DNS Management**

**Summary:** Added secure password management for Pi-Hole API, persistent storage support, and Local DNS record management (A/CNAME records).

**New Features:**

1. **Secure Password Management**
   - Passwords stored in systemd environment variables (same pattern as JWT_SECRET)
   - Never exposed in logs, URLs, or container configuration
   - Admin can change password from DNS Settings tab

2. **Local DNS Records**
   - Manage A/AAAA records (domain → IP)
   - Manage CNAME records (alias → target)
   - Full CRUD from Control Panel UI

3. **Persistent Storage**
   - Pi-Hole data persists across container restarts
   - Gravity database, custom DNS records, and settings are preserved

4. **Enhanced DNS Page**
   - New "Local DNS" tab for A/AAAA and CNAME record management
   - New "Settings" tab with password management and direct Pi-Hole access link

**New Files:**
- `src/lib/apps/secrets.ts` - Secure password storage using systemd env vars
- `src/app/api/apps/pihole/password/route.ts` - GET/POST password management
- `src/app/api/apps/pihole/dns-records/route.ts` - GET/POST/DELETE A records
- `src/app/api/apps/pihole/cname-records/route.ts` - GET/POST/DELETE CNAME records

**Modified Files:**
- `src/lib/apps/manifest.ts` - Updated PIHOLE_MANIFEST with port 53 and volumes
- `src/app/api/apps/pihole/stats/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/domains/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/queries/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/control/route.ts` - Use dynamic password from secrets
- `src/app/(dashboard)/dns/page.tsx` - Added Settings and Local DNS tabs
- `scripts/postbuild.js` - Resolve symlinks to fix Windows→Linux deployment

**Build Fix:**
The postbuild script now resolves all symlinks in node_modules/ to real files. This fixes the "Cannot find module 'next'" error when deploying from Windows builds.

**Testing:**
- Deployed to dev server 192.168.31.190
- Spine v0.1.12, Control Panel v0.1.26
- Pi-Hole running and accessible

---

### v0.1.25 (2026-02-05)

**Feature: DNS Tab with Pi-Hole UI**

**Summary:** Added dedicated DNS tab to sidebar for Pi-Hole management with quick install and full management UI.

**Changes:**
- Added DNS tab to sidebar navigation
- Added DNS page at `/dns` with Pi-Hole install/management
- Overview, Query Log, and Block Lists tabs

---

### v0.1.22 (2026-02-04)

**Major Feature: Multi-App Management Pages**

**Summary:** Added management UI for core infrastructure apps: PostgreSQL, Authentik, and Pi-Hole. Also fixed critical build issue with pnpm symlinks on Windows.

**New App Pages:**
- `/apps` - Overview page with container status cards for each app
- `/apps/postgres` - PostgreSQL management: stats, databases, users
- `/apps/authentik` - Authentik management: stats, user count
- `/apps/pihole` - Pi-Hole management: stats, queries, domains, enable/disable

**New API Routes:**
- `GET /api/apps/postgres/stats` - PostgreSQL server stats
- `GET /api/apps/postgres/databases` - List databases with sizes
- `GET /api/apps/postgres/users` - List database users
- `GET /api/apps/authentik/stats` - Authentik service stats
- `GET /api/apps/pihole/stats` - Pi-Hole DNS query stats
- `GET /api/apps/pihole/queries` - Recent DNS queries
- `GET /api/apps/pihole/domains` - Whitelisted/blacklisted domains
- `POST /api/apps/pihole/control` - Enable/disable Pi-Hole

**Build Fix: pnpm Symlinks on Windows**

**Root Cause:** Windows tar creates broken symlinks when building pnpm-managed projects. The pnpm `.pnpm/node_modules/` structure uses symlinks that point to Windows paths like `//?/C:/Users/...`. When extracted on Linux, these symlinks are broken and packages like `styled-jsx`, `sharp`, etc. are missing.

**Fix:** Added `scripts/postbuild.js` that:
1. Copies `.next/static/` and `public/` to standalone (existing behavior)
2. Copies all packages from `.pnpm/node_modules/` to top-level `node_modules/`
3. This ensures all dependencies are available as real files, not broken symlinks

**Code Changes:**

*New Files:*
- `src/app/(dashboard)/apps/page.tsx` - Apps overview
- `src/app/(dashboard)/apps/postgres/page.tsx` - PostgreSQL management
- `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik management
- `src/app/(dashboard)/apps/pihole/page.tsx` - Pi-Hole management
- `src/app/api/apps/postgres/stats/route.ts` - PostgreSQL stats API
- `src/app/api/apps/postgres/databases/route.ts` - PostgreSQL databases API
- `src/app/api/apps/postgres/users/route.ts` - PostgreSQL users API
- `src/app/api/apps/authentik/stats/route.ts` - Authentik stats API
- `src/app/api/apps/pihole/stats/route.ts` - Pi-Hole stats API
- `src/app/api/apps/pihole/queries/route.ts` - Pi-Hole queries API
- `src/app/api/apps/pihole/domains/route.ts` - Pi-Hole domains API
- `src/app/api/apps/pihole/control/route.ts` - Pi-Hole control API
- `src/lib/incus/container-ip.ts` - Container IP discovery utility
- `scripts/postbuild.js` - Build fix for pnpm symlinks

*Modified Files:*
- `package.json` - Updated postbuild script to use `node scripts/postbuild.js`
- `src/components/layout/sidebar.tsx` - Added "Apps" navigation link

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Login page loads correctly
- All services running: Spine v0.1.10, Control Panel v0.1.22

**Note:** This version deployed successfully after fixing TWO bugs in Spine v0.1.10:
1. Tar extraction path (--strip-components=1)
2. Health check network isolation (incus exec curl)

---

### v0.1.21 (2026-02-04)

**Bug Fix: Route Detection for Container Routing Table**

**Summary:** Fixed a bug where the Container Routing Table displayed incorrect route information after page refresh. The UI was showing auxiliary routes (like `/favicon.ico`) instead of the main configured route.

**Root Cause:**
When detecting the current route for a container, the API used `.find()` which returns the first matching route. Path routing creates multiple routes: main route, `/_next/*`, and `/favicon.ico`. Since auxiliary routes were added with `unshift()`, they appeared first in the array and were incorrectly displayed.

**Fix:**
- Added `AUXILIARY_ROUTE_PATHS` constant to filter out `/_next/*`, `/_next`, and `/favicon.ico`
- Updated route detection logic to skip auxiliary routes when finding the "main" route

**Code Changes:**
- `src/app/api/containers/route.ts`:
  - Added `AUXILIARY_ROUTE_PATHS` constant
  - Updated route detection to filter auxiliary routes for both system containers and app manifest containers

**Testing:**
- Deployed to dev server (192.168.31.190)
- Verified subdomain route `controlpanel.skibidi.wtf` is configured correctly
- Service running successfully

---

### v0.1.20 (2026-02-04)

**Feature: Path Routing Support for Next.js Apps**

**Summary:** Added support for path-based routing with Next.js apps by creating auxiliary routes for static assets.

**Note:** Path routing still has limitations with Next.js - redirects use absolute paths. Subdomain routing is recommended.

---

### v0.1.19 (2026-02-04)

**Major Feature: Unified Proxy Configuration UI**

**Summary:** Complete redesign of the Proxy page with a unified domain configuration and container routing table. Fixes path-based routing and adds volume mounts for Caddy config persistence.

**New Features:**
1. **Domain Configuration Card** - Single input for base domain with auto-TLS
2. **Container Routing Table** - Shows all YouEye containers with web UIs
3. **Route Type Selection** - Subdomain, path, or none options per container
4. **Path Pattern Normalization** - Automatically fixes `/control` → `/control/*`

**Bug Fixes:**
1. **Path Routes Not Working** - Caddy's `*` wildcard doesn't cross path separators. Fixed by normalizing path patterns to include trailing `/*`
2. **Config Not Persisting** - Added Incus volume mounts for Caddy's `/config` and `/data` directories (requires Caddy reinstall to activate)

**New API Endpoints:**
- `GET /api/containers` - Lists containers with web UIs available for routing
- `GET/POST /api/domain` - Get/set the base domain for routing
- `POST /api/containers/[name]/route` - Set container routing (subdomain/path/none)

**Code Changes:**

*New Files:*
- `src/app/api/containers/route.ts` - Container listing endpoint
- `src/app/api/containers/[name]/route/route.ts` - Route assignment endpoint
- `src/app/api/domain/route.ts` - Domain configuration endpoint
- `src/components/proxy/container-routing-table.tsx` - New routing table component
- `src/components/ui/select.tsx` - Radix Select component

*Modified Files:*
- `src/lib/caddy/client.ts`:
  - Added `normalizePathPattern()` - Ensures `/path/*` format
  - Updated `formDataToRoute()` and `addRoute()` to return warnings
  - Added `setContainerRoute()`, `getConfiguredDomain()`, `setDomain()`
- `src/lib/apps/manifest.ts`:
  - Added `volumes` to CADDY_MANIFEST for `/config` and `/data`
  - Added `webPort` field to all manifests
  - Updated `manifestToIncusConfig()` to handle volumes
- `src/types/apps.ts`:
  - Added `volumes` and `webPort` to AppManifest interface
- `src/app/api/apps/install/route.ts`:
  - Added `ensureHostDirectories()` for volume mount directories
- `src/app/(dashboard)/proxy/page.tsx`:
  - Removed old TLSCard/RouteList/RouteFormDialog
  - Added domain input card and ContainerRoutingTable
- `package.json`:
  - Added `@radix-ui/react-select` dependency
  - Version: 0.1.18 → 0.1.19

**Technical Details:**

*Path Pattern Normalization:*
```typescript
// Input: /control → Output: /control/*
function normalizePathPattern(pattern: string): { pattern: string; modified: boolean }
```
Caddy's `*` wildcard matches any characters BUT doesn't cross `/` separators.
- `/control*` matches `/controlABC` but NOT `/control/dashboard`
- `/control/*` matches `/control/dashboard`

*Container Route Assignment:*
```typescript
setContainerRoute(domain, containerName, port, routeType, routeValue)
// routeType: 'subdomain' | 'path' | 'none'
// Example path: domain=skibidi.wtf, routeValue=/control → skibidi.wtf/control/*
```

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- `/api/containers` returns containers with webPort correctly
- `/api/domain` returns configured domain (skibidi.wtf)
- Path route `/control` normalized to `/control/*` in Caddy config
- Route works: `curl -k https://skibidi.wtf/control/` returns 307 redirect
- Caddy includes rewrite handler to strip path prefix before forwarding

**Notes:**
- Volume mounts require Caddy reinstall to activate (existing Caddy won't have them)
- Host authentication uses Spine API's `/api/auth/verify` (PAM on host, not container)
- Default host root password: set via `chpasswd` on host

---

### v0.1.18 (2026-02-04)

**Bug Fix: Admin groups not passed to isAdmin check during login**

**Root Cause:** The login route was calling `getUserGroups(username)` which always returned `[]`, then calling `isAdmin(username)` without the groups. This meant only `root` users were recognized as admin, even though users like `youeye` are in the `sudo` group.

**Fix:** Use `authResult.groups` from PAM authentication result and pass to `isAdmin(username, groups)`.

**Code Changes:**
- `src/app/api/auth/login/route.ts` - Use groups from auth result, remove unused getUserGroups import

**Testing:**
- Deployed to dev server 192.168.31.190
- User `youeye` (in sudo group) should now be recognized as admin after re-login

**Note:** Users must log out and log back in to get a new session with the correct admin status.

---

### v0.1.17 (2026-02-04)

**Bug Fix: Static Files Missing in Standalone Build**

**Root Cause:** Next.js standalone output doesn't automatically copy `.next/static/` and `public/` folders. CSS/JS files were returning 404 or being served with `text/plain` MIME type, causing browsers to refuse loading them with strict MIME checking.

**Fix:** Added `postbuild` script to copy static files into standalone folder.

**Code Changes:**
- `package.json` - Added postbuild script: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`
- `package.json` - Build script now explicitly runs postbuild: `next build && pnpm run postbuild`
- Version bump: 0.1.16 → 0.1.17

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Verified CSS returns `Content-Type: text/css; charset=UTF-8`
- Verified JS returns `Content-Type: application/javascript; charset=UTF-8`  
- Verified fonts return `Content-Type: font/woff2`
- No MIME type errors in browser console

**Note for Windows builds:** The `cp` command doesn't work on Windows. Use PowerShell:
```powershell
Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static"
Copy-Item -Recurse -Force "public" ".next\standalone\public"
```

---

### v0.1.16 (2026-02-04)

**Changes:**
- Secured Caddy Admin API: removed external port 2019 exposure
- Added route ordering by specificity (sortRoutes function)
- Enhanced TLS automation for hostname handling
- Added request timeout (10s) and retry logic with exponential backoff
- Added route verification after config application
- Improved initial Caddy config generation
- Added comprehensive logging for Caddy operations

**Code Changes:**
- `src/lib/apps/manifest.ts` - Removed adminPort from CADDY_MANIFEST
- `src/lib/caddy/client.ts` - Major refactoring with timeout/retry, sorting, verification
- `package.json` - Version bump

**Testing:**
- Deployed to dev server 192.168.31.190
- Verified port 2019 NOT exposed externally (SECURE)
- Verified internal Caddy API access works
- HTTP/HTTPS ports working

---

## Architecture Notes

### Caddy Integration
- Control Panel communicates with Caddy via Incus DNS: `http://youeye-caddy.incus:2019`
- Admin API NOT exposed to host network (security requirement)
- Caddy configured to bind admin API to `0.0.0.0:2019` inside container
- Config persistence via `--resume` flag: auto-saves to `/config/caddy/autosave.json`, reloads on restart
- No `/config` volume mount — Caddy uses its internal container filesystem for XDG_CONFIG_HOME
- `/data` volume mounted for TLS certificate persistence across container recreation

### Key Files
- `src/lib/caddy/client.ts` - Caddy Admin API client
- `src/lib/caddy/types.ts` - TypeScript types for Caddy config
- `src/lib/apps/manifest.ts` - App manifests including Caddy
- `src/app/api/caddy/*` - API routes for Caddy management

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Playwright Testing](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Playwright-Testing)** — **MANDATORY** browser testing for all Control Panel changes
- **[Control Panel](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Control-Panel)** — Complete Control Panel documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning
## v0.2.13.1-r1 — ben — 2026-04-01
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** BUG-031 revision — market install dialog shows wrong app name; fix and related manifest validation issues

### Changes
- `src/components/market/app-card.tsx` — Added `data-app-id={app.id}` to card container and `data-testid={"install-" + app.id}` to Install button. Enables precise per-app button targeting in Playwright tests. Root cause of BUG-031 was Vlad's locator `page.locator('*').filter({ hasText: /whoogle/i })` matching the entire body element and returning Notes' Install button first. The React app-state logic was correct all along.

### AppMarket fixes (YE-AppMarket ben branch)
- `apps/wiki.yaml` — Fixed `capabilities: notifications: true` (boolean) to `notifications: "push"` (string literal) to match Zod `CapabilitiesSchema` `z.literal('push')`. Boolean `true` was silently failing Zod validation and preventing Wiki from appearing in the catalog API.
- `apps/search.yaml` — Same notifications fix. Also fixed `sso.configure` from a list of env var names (invalid) to `{type: "none", steps: []}` matching `SSOConfigureSchema`.

### Test Results
- Smoke tests: 3/3 passed — `[data-testid="install-notes"]` and `[data-testid="install-whoogle"]` both found; dialogs show correct app names
- Catalog API: 10/10 apps load including wiki and search (was 8, missing wiki+search)
- Whoogle install (INSTALL-01): passed 32s — app-whoogle container running
- Search install (SEARCH-01): passed 37s — Whoogle auto-detected, app-search container running
- search.benvm.test (SEARCH-02): accessible, returns search UI

### Notes for Iris
- No changes to YE-ControlPanel TypeScript source beyond app-card.tsx data-testid attributes
- YE-AppMarket ben branch has 3 manifest fixes — must be merged to main before YE-ControlPanel is deployed from main
- BUG-031 was a test authoring bug: Vlad's locator was too broad. data-testid attributes prevent recurrence.

## v0.2.13.1 — ben — 2026-04-01
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Version bump for search app fix cycle

### Changes
- `package.json` — Version bumped from 0.2.12 to 0.2.13.1. The installer (src/lib/native-apps/installer.ts) already correctly writes SEARCH_ENGINE_TYPE and SEARCH_ENGINE_URL from the cycle-3 work — no code changes needed here.

### Test Results
- spine update control successfully deployed v0.2.13.1 on benvm
- /api/ping → {status: ok} confirmed
- 7 running, 0 stopped

### Notes for Iris
- Minimal change — version bump only in this repo

## v0.2.9.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 5 QA bugs from v0.2.9 (BUG-021 through BUG-025)

### Changes
- `src/app/setup/page.tsx` — BUG-021: Detect ye-setup-language cookie on page load to skip past language selection after reload; avoids infinite language step loop
- `src/app/api/setup/language/route.ts` — BUG-021: Set cookie httpOnly=false so client JS can detect it
- `src/lib/caddy/client.ts` — BUG-022: New ensurePingRoute() adds /api/ping at route position 0 (before host-matched routes) so Spine health checks work on any domain
- `src/app/api/setup/run/route.ts` — BUG-022: Call ensurePingRoute during setup wizard Caddy step
- `src/lib/infrastructure/deployer.ts` — BUG-022: Call ensurePingRoute in both deploy and reconcile paths (including when Caddy is already running)
- `src/lib/native-apps/installer.ts` — BUG-023: Add trailing newline to all env file writes (wiki, search, notes) to prevent line concatenation
- `src/lib/health/service.ts` — BUG-024: Add 1-retry with 1s delay to Authentik, Caddy, and Spine health checks to reduce transient false positives
- `src/lib/market/installed-apps.ts` — BUG-025: Replace 'su - postgres -c "psql..."' with 'psql -U youeye' directly (BusyBox su incompatibility)
- `package.json` — version bump to 0.2.9.1

### Test Results
- Build: successful standalone tarball (242MB)
- BUG-022: curl -sk https://johnvm.test/api/ping returns {"status":"ok"}
- BUG-025: installed_apps table exists (verified via psql -U youeye)
- All 7 containers RUNNING

### Notes for Iris
- BUG-022 fix adds a Caddy route at position 0 without host matcher; this is intentional to override host-matched routes for /api/ping
- BUG-025 fix uses psql -U youeye instead of su postgres; all future psql calls should use this pattern for BusyBox compatibility
- BUG-023 fix adds trailing newline to ALL native app env writes; existing malformed env files will be fixed on next app reinstall

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Search engine detection in installer + catalog cache resilience + dynamic native app discovery

### Changes
- `src/lib/native-apps/installer.ts` — detectSearchEngine() checks installed_apps DB + install.json metadata; installSearch() writes SEARCH_ENGINE_TYPE + SEARCH_ENGINE_URL env vars; step count increased from 7 to 8
- `src/lib/market/catalog.ts` — catalog cache persistence at /var/lib/youeye/catalog-cache.json; fetchCatalog() saves to disk on success, loads from cache on failure; getNativeApps() filters catalog by type: native; getCatalogCacheAge() for UI display; refreshCatalog() for manual refresh
- `src/lib/market/schema.ts` — CatalogEntrySchema extended with optional type field (native | marketplace)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- catalog.yaml now has type: native entries for wiki and search — CatalogEntrySchema accepts optional type with default 'marketplace'
- /var/lib/youeye/catalog-cache.json is created at runtime — no migration needed

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Improved setup wizard + language propagation + install from URL

### Changes
- `src/app/setup/page.tsx` — Complete rewrite: language selection as Step 0 (5 languages with flags), step progress indicator ("Step N of M" with stepper), smooth fade/slide transitions (200ms), contextual help expandable per step, mobile-friendly layout
- `src/app/setup-complete/page.tsx` — Confetti animation on completion, personalized welcome message, quick start links (dashboard, marketplace, docs)
- `src/app/api/setup/language/route.ts` — New endpoint: stores setup language in cookie for pre-setup i18n resolution
- `src/i18n/request.ts` — Added ye-setup-language cookie resolution before system/user language
- `src/lib/language/service.ts` — New LanguageService: propagateLanguageToAll() cascades to Authentik locale, app container env vars via Incus API
- `src/app/api/ui-bridge/user/language/route.ts` — New bridge endpoint: PATCH triggers full language propagation pipeline
- `src/app/api/market/validate-url/route.ts` — New endpoint: SSRF-safe manifest URL validation (HTTPS only, blocks RFC1918 IPs)
- `src/app/api/market/install-url/route.ts` — New endpoint: SSE install from URL with audit logging
- `src/components/market/install-from-url-dialog.tsx` — New dialog: URL input, manifest preview with capabilities, subdomain config, SSE install progress
- `src/app/(dashboard)/market/page.tsx` — Added "Install from URL" button in marketplace header
- `src/lib/market/installed-apps.ts` — Added updateInstalledAppSource() for URL source tracking (source + source_url columns)
- `messages/*.json` — New i18n keys for setup wizard (stepOf, help texts) and setup-complete (welcomeUser, quickStart) in all 5 locales

### Test Results
- Build: Both YE-ControlPanel and YE-UI build successfully
- Deploy: lisavm running v0.2.8.1, 7 containers running, 0 stopped

### Notes for Iris
- New DB columns: installed_apps.source (TEXT) and installed_apps.source_url (TEXT) — added via ALTER TABLE IF NOT EXISTS, safe for existing data
- New i18n keys in all 5 locale files — merge carefully if other agents added keys in the same section
- YE-UI has a new PATCH handler in admin proxy catch-all — needed for language propagation bridge calls
## v0.2.7.1 — john — 2026-03-30 (bugfix update)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix 4 bugs from Cycle 2 testing (BUG-016, BUG-017, BUG-018, BUG-019)

### Changes
- `src/middleware.ts` — BUG-016: When setup is complete and accessed via IP+Caddy, let request through instead of redirecting to /setup-complete interstitial. BUG-017: Added /api/ping to PUBLIC_ROUTES.
- `src/app/api/ping/route.ts` — BUG-017: New unauthenticated health-check endpoint for Spine post-update verification. Returns `{"status":"ok"}`.
- `messages/en.json`, `ru.json`, `de.json`, `es.json`, `fr.json` — BUG-018: Added missing i18n keys `market.builtForYouEye` and `market.orphanScanPrompt` to all 5 locale files.
- `src/lib/health/service.ts` — BUG-019: Pi-Hole health check switched from HTTP API (returns 401 in v6) to exec-based `pihole status`. PostgreSQL check switched from `su - postgres` (fails with BusyBox) to `pg_isready`. Restructured health dispatch for clarity.

### Test Results
- /api/ping returns 200 without auth (verified via curl through Caddy)
- pihole status and pg_isready both work inside containers
- CP starts and runs correctly after deploy

### Notes for Iris
- /api/ping is a new public route — no auth required, by design
- Health check for Pi-Hole now uses exec-based approach (container name, not IP)
- Health check for PostgreSQL uses pg_isready instead of psql via su
- Caddy health check unchanged (was already working correctly)

## v0.2.7.1 — john — 2026-03-30
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cycle 2 polish fixes + LXD update path mismatch (BUG-012)

### Changes
- `src/lib/health/service.ts` — CPU delta-sampling: in-memory map tracks cumulative nanoseconds, computes real CPU % between polls. Spine returns cpuPercent: -2 (N/A). First poll returns -1 (no baseline).
- `src/app/(dashboard)/health/page.tsx` — Added CPU % display with Cpu icon alongside memory bar. Shows N/A for Spine, dash for first poll.
- `src/app/api/market/route.ts` — New: GET /api/market convenience route (re-exports catalog handler)
- `src/lib/native-apps/installer.ts` — installSearch() now calls saveInstallMetadata() (was missing). Uninstaller now removes Authentik OAuth2 for search. Both installers detect previous keepData installs.
- `src/lib/apps/lxd-updater.ts` — Added getServiceWorkingDir() helper using systemctl show. updateLXDApp() resolves real WorkingDirectory from systemd before file operations. Emits SSE note when paths differ (BUG-012 fix).
- `src/lib/apps/lxd-updates.ts` — getLxdAppVersion() fallback now uses systemctl show instead of grep for consistency with lxd-updater.
- `package.json` — Version bump to 0.2.7.1

### Test Results
- Playwright: 4 screenshots, 2 tests passed
- Screenshots: Tests/John/20260330_1/

### Notes for Iris
- Health dashboard cpuPercent field added to ServiceHealth interface — frontend and API both updated
- LXD updater path resolution is backward-compatible: if systemctl show fails, falls back to configured appDir
- installSearch() metadata fix ensures uninstall works correctly for search app

## v0.2.7.1 — lisa — 2026-03-30
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Backup engine — CP orchestrator, SSE progress, backup page, manifest backup schema

### Changes
- `src/lib/backup/types.ts` — backup types: config, events, manifest backup section, app backup plan
- `src/lib/backup/service.ts` — backup orchestrator: enumerate targets, dump PostgreSQL, call Spine, poll status
- `src/app/api/backup/run/route.ts` — SSE endpoint for triggering and streaming backup progress
- `src/app/api/backup/status/route.ts` — polls Spine for current backup status
- `src/app/(dashboard)/backup/page.tsx` — backup configuration and progress UI page
- `src/lib/spine/client.ts` — startBackup() and getBackupStatus() methods
- `src/lib/market/schema.ts` — BackupSchema: stopOrder, startOrder, ownPostgres, volumes, exclude
- `src/lib/market/types.ts` — BackupSpec type export
- `src/components/layout/sidebar.tsx` — added Backup navigation item
- `messages/{en,ru,fr,es,de}.json` — i18n for Backup sidebar label
- `package.json` — version bump to 0.2.7.1

### Test Results
- CP backup status endpoint responds correctly (requires auth)
- Full backup pipeline tested via Spine API: archive created, encrypted, decryptable
- Platform healthy after deploy: 7 running, 0 stopped

### Notes for Iris
- New lib/backup/ directory with service and types
- New API routes: /api/backup/run (SSE), /api/backup/status
- New page: /backup in dashboard sidebar
- Manifest schema extended with optional backup: section
- No database migrations needed

## v0.2.7.1 — ben — 2026-03-30
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** App version pinning + system health notifications

### Changes
- `src/lib/market/installed-apps.ts` — New installed_apps PostgreSQL table: CRUD, migration from install.json, update detection via version comparison
- `src/lib/market/version-checker.ts` — Background job (6h cycle): compare installed vs catalog versions, track update availability
- `src/lib/market/schema.ts` — Added `version` field to AppManifestSchema, `latestVersion` to CatalogEntrySchema
- `src/lib/market/types.ts` — Added `version` to MarketApp, `installedVersion` to InstallMetadata
- `src/lib/market/catalog.ts` — Include `version` in manifestToMarketApp conversion
- `src/lib/market/engine.ts` — Save installedVersion to both install.json and installed_apps DB on install
- `src/lib/market/uninstaller.ts` — Remove from installed_apps DB on uninstall
- `src/lib/health/monitor.ts` — Background health monitor (60s cycle): service state transitions, disk/memory/cert/update alerts
- `src/lib/health/notification-bridge.ts` — CP-to-UI notification delivery via bridge token auth
- `src/lib/health/index.ts` — Exported monitor and bridge modules
- `src/app/api/ui-bridge/notifications/route.ts` — New POST endpoint for creating notifications in YE-UI
- `src/app/api/ui-bridge/market/route.ts` — Added updates, installed-versions, refresh-catalog actions with version data
- `src/app/api/health/services/route.ts` — Side-effect imports to start monitor and version checker
- `package.json` — Bumped to 0.2.7.1

### Test Results
- Build: TypeScript compilation passes
- Screenshots: Tests/Ben/20260330_1/

### Notes for Iris
- New `installed_apps` PostgreSQL table is auto-created on first use (no manual migration needed)
- install.json files are migrated to DB on first boot — keep both during transition
- Health monitor sends notifications to all admin users via bridge token
- YE-UI notification POST route now accepts bridge token auth (not just session cookies)
- Version checker runs 45s after startup (after update-cache at 30s)

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** SMTP email configuration + user avatar bridge endpoint

### Changes
- `src/app/(dashboard)/settings/page.tsx` — SMTP settings card: host, port, username, password, from, TLS toggle, test button, status display
- `src/app/api/settings/smtp/route.ts` — GET/POST SMTP config (non-sensitive fields via SettingsService, password to secrets file)
- `src/app/api/settings/smtp/test/route.ts` — POST send test email via configured SMTP to admin address
- `src/app/api/ui-bridge/user/avatar/route.ts` — Bridge endpoint: receive multipart avatar from YE-UI, sync to Authentik via set_avatar API
- `src/lib/settings/service.ts` — Extended PlatformSettings with smtpHost, smtpPort, smtpFrom, smtpUsername, smtpRequireTls; KEY_MAP/REVERSE_KEY_MAP updated
- `src/lib/smtp/authentik-sync.ts` — Patch Authentik email stage and brand with SMTP credentials after save
- `src/lib/smtp/mailer.ts` — nodemailer wrapper for test email sending
- `src/lib/smtp/secrets.ts` — Read/write SMTP password to /var/lib/youeye/control/.secret_smtp_password (0600)
- `src/lib/market/variables.ts` — Added smtp.* namespace: host, port, username, password, from, tls, configured
- `src/lib/market/engine.ts` — Inject smtp.* vars for apps with capabilities.smtp: true
- `src/lib/market/types.ts` — Added smtp capability to CapabilitiesSchema
- `messages/{en,ru,de,es,fr}.json` — SMTP i18n keys
- `package.json` — bumped to 0.2.6.1

### Test Results
- Playwright: 5 tests, 5 passed — CP landing loads, CP settings has SMTP section, UI SSO login, UI profile avatar section, Avatar API endpoint
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- SMTP password stored at /var/lib/youeye/control/.secret_smtp_password — ensure volume persists across CP updates
- Avatar bridge uses multipart/form-data — Authentik set_avatar API receives the file directly
- smtp.* namespace resolves empty strings when SMTP not configured — apps install fine without it

---

---

 HEAD

## v0.2.6.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Unified app market + app lifecycle management

### Changes
- `src/lib/market/schema.ts` — Add `type` field (native/marketplace), `NativeConfigSchema`, make `containers` optional for native apps, add `native` category to metadata
- `src/lib/market/types.ts` — Add `type` to `MarketApp`, add `UninstallOptions`, `UninstallVerification`, `OrphanResource` types, add `NativeConfig` type
- `src/lib/market/catalog.ts` — Include `type` in `manifestToMarketApp()` conversion
- `src/lib/market/authentik.ts` — Export `getAuthentikConfig()` and `authentikAPI()` for orphan detector
- `src/lib/market/uninstaller.ts` — Complete rewrite: unified for marketplace + native, Pi-Hole DNS cleanup, keepData option, post-uninstall verification
- `src/lib/market/orphan-detector.ts` — New: detect orphaned Caddy routes, Authentik apps, PostgreSQL DBs, containers, volume dirs
- `src/lib/native-apps/catalog.ts` — Remove hardcoded `NATIVE_APP_CATALOG`, keep only utility functions (`nativeContainerName`, `nativeGiteaRepo`)
- `src/lib/native-apps/installer.ts` — Save `InstallMetadata` after wiki install for unified tracking
- `src/app/api/market/install/route.ts` — Unified: routes to native installer for `type: native`
- `src/app/api/market/uninstall/route.ts` — Accept `keepData` param, use options object
- `src/app/api/market/status/route.ts` — Include native app containers in status (pre-migration support)
- `src/app/api/market/catalog/route.ts` — Comment update (unified)
- `src/app/api/admin/orphans/route.ts` — New: GET detects orphans, POST cleans up
- `src/app/api/ui-bridge/market/route.ts` — Fix uninstaller call signature
- `src/app/(dashboard)/market/page.tsx` — Unified: single app grid, "Built for YouEye" section, orphan section, uninstall dialog
- `src/components/market/app-card.tsx` — Add "YouEye" badge for native apps, add BellRing/Shield icons
- `src/components/market/uninstall-dialog.tsx` — New: keep-data/delete-all confirmation dialog
- `src/components/market/orphan-section.tsx` — New: orphan scan + cleanup UI
- `src/app/api/market/native/` — **Deleted** (3 route files): functionality moved to unified routes
- `package.json` — Bump to 0.2.6.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/Ben/20260329_3/
- /api/market/catalog returns 9 apps (2 native + 7 marketplace)
- /api/market/native correctly returns 404
- /api/admin/orphans detected 3 orphans from previous installs
- Unified market page renders with "Built for YouEye" section

### Notes for Iris
- `/api/market/native/*` routes removed — any UI or bridge code referencing these needs updating
- `uninstallApp()` signature changed from `(appId, boolean)` to `(appId, options)` — already fixed in ui-bridge
- Native app IDs in manifests are `wiki`/`search` (not `ye-wiki`/`ye-search`) — native installer maps them internally
- AppMarket repo needs the matching `ben` branch merged for manifests to be available on `dev`/`main`

---

 HEAD
## v0.2.6.1 — john — 2026-03-29 (resume: Playwright tests)
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Setup wizard hardening — Playwright test suite (resume session)

### Changes
- No new code changes — test files only (stored locally in Tests/John/20260329_2/)

### Test Results
- `setup-wizard-partial-resume.spec.ts` — PASS (State A: setup completed in background, Go link visible, resume correctly reflected)
- `setup-wizard-double-run.spec.ts` — PASS (Run 1 completed with DNS retry failure visible + Retry button; Run 2 redirected to /setup-complete without errors)
- `cycle0-full.spec.ts` — PASS (SSO login, theme switching, API v1 paths, settings page, login error page)
- Total screenshots: 36 across all 3 test sessions
- Videos: recorded for each test run (test-results/)
- BUG-011 verified RESOLVED — no duplicate Authentik providers on re-run, DNS failure visible (not silent)
- Screenshots: Tests/John/20260329_2/

### Notes for Iris
- No new build needed — code unchanged from previous session (john-v0.2.6.1)
- Setup wizard hardening fully tested and verified

---

## v0.2.6.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add YE-App-Search native installer to Control Panel

### Changes
- `src/lib/native-apps/installer.ts` — Added `installSearch()` (7-step: secrets, Authentik OAuth2, LXD deploy, env file, health check, Caddy route, done); updated `installNativeApp()` dispatcher to route `ye-search` appId
- `src/lib/native-apps/catalog.ts` — Set `supportsSSO: true` for ye-search (was false)
- `package.json` — bumped to 0.2.6.1

### Test Results
- YE-App-Search installed successfully on mikevm.test via CP marketplace
- 7-scenario Playwright test suite passed for Search app (see YE-App-Search AGENTS.md)
- Screenshots: Tests/Mike/20260329_2/

### Notes for Iris
- installSearch() follows same pattern as installWiki() — Authentik OAuth2 client creation, LXD container deploy, env file, Caddy route
- Whoogle must be installed first (container: app-whoogle.incus) — Search connects to it via WHOOGLE_URL env var
- WHOOGLE_URL default in Search app code is `http://app-whoogle-main.incus:5000` but installer sets correct container name

---

## v0.2.6.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Platform Health Dashboard + Setup Wizard Hardening (BUG-011)

### Changes
- `src/lib/health/service.ts` — Health check service querying 5 services via Incus state + per-service endpoints
- `src/lib/health/index.ts` — Health module exports
- `src/app/api/health/services/route.ts` — GET /api/health/services endpoint
- `src/app/api/health/services/[slug]/restart/route.ts` — POST restart endpoint per service
- `src/app/(dashboard)/health/page.tsx` — Health dashboard page with service cards, status badges, memory bars
- `src/app/(dashboard)/page.tsx` — Added compact health dots row + degraded service banner
- `src/components/layout/sidebar.tsx` — Added Health link with HeartPulse icon
- `src/app/api/setup/run/route.ts` — Full idempotency rewrite: check-before-create, 3-retry DNS, per-step persistence
- `src/app/api/setup/steps/route.ts` — GET/DELETE setup step state API for resume/retry
- `src/app/setup/page.tsx` — Added retry button per failed step, connectivity indicators, resume support
- `messages/{en,ru,de,es,fr}.json` — Added health + sidebar i18n keys
- `package.json` — Version bump to 0.2.6.1

### Test Results
- Playwright: health page renders with all 5 service cards, dashboard health dots visible
- Screenshots: Tests/John/20260329_1/screenshots/

### Notes for Iris
- New health page at /dashboard/health — no migrations needed
- Setup wizard hardening (BUG-011): setup_steps field added to youeye.yaml — backward compatible
- Merge before any other CP changes — contains setup wizard rewrite

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Update native app YOUEYE_API_URL to /api/v1 path

### Changes
- `src/lib/native-apps/installer.ts` — YOUEYE_API_URL env var now includes /v1 suffix
- `package.json` — bumped to 0.2.5.1

### Test Results
- Tested as part of YE-UI deployment — CP updated to 0.2.5.1 successfully

### Notes for Iris
- Merge with YE-UI (john first). Native apps installed after this change will get the correct v1 URL.

---
## v0.2.5.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Authentik named server ID + notification infrastructure (ntfy + capabilities)

### Changes
- `src/app/setup/page.tsx` — Add "Identity Provider Name" field to setup wizard Step 0 with auto-default "${siteName} ID"
- `src/app/api/setup/run/route.ts` — Store authentik_name in config, set Authentik brand title, rename UI OAuth2 from "${siteName} UI" to "${siteName}"
- `src/app/(dashboard)/settings/page.tsx` — Add Identity Provider settings card for post-setup renaming
- `src/app/api/settings/identity-provider/route.ts` — New API: update authentik_name in config + Authentik brand title
- `src/app/api/setup/reconfigure/route.ts` — Accept authentik_name in reconfigure flow
- `src/lib/reconfigure/index.ts` — Add authentik_name to ReconfigureRequest and patchConfig
- `src/lib/market/types.ts` — Extend VariableContext with authentik.name and ntfy namespace, add Capabilities type
- `src/lib/market/variables.ts` — Add ntfy and authentik.name to variable resolver
- `src/lib/market/schema.ts` — Add CapabilitiesSchema and "system" category to metadata
- `src/lib/market/engine.ts` — Populate authentik.name from config, populate ntfy context for apps with push capability
- `messages/{en,de,es,fr,ru}.json` — i18n keys for authentikName, identityProvider

### Test Results
- Build: pnpm build passes, standalone.tar created (236MB)
- Playwright: 5/5 tests pass (CP landing, config API, SSO login + settings navigation, ntfy manifest, Memos capabilities)
- Screenshots: Tests/Lisa/20260329_1/ (10 screenshots including settings page with Identity Provider section)
- Identity Provider section confirmed visible at `control.lisavm.test/settings` with "YouEye ID" default value

### Notes for Iris
- Merge Lisa AFTER Mike if Mike modifies SettingsService — Lisa uses direct spineClient.patchConfig
- New "system" category in metadata schema — existing apps use search/social/productivity/media
- CapabilitiesSchema is optional and backward-compatible — existing manifests pass without it
- authentik_name field in youeye.yaml is new — Spine will store it transparently via patchConfig
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Settings Service Foundation + User Identity Foundation (setup wizard names)

### Changes
- `src/lib/settings/service.ts` — New SettingsService class with typed getAll/get/set/getRaw/setRaw/invalidate + 5s cache
- `src/lib/settings/index.ts` — Re-export barrel
- `src/app/api/settings/route.ts` — New admin-only GET/PATCH endpoint for typed platform settings
- `src/lib/site-config.ts` — Migrated from spineClient.getConfig() to settingsService.getRaw()
- `src/lib/reconfigure/index.ts` — 3 getConfig + 1 patchConfig migrated to settingsService
- `src/app/api/ui-bridge/config/route.ts` — Migrated GET/PATCH to settingsService
- `src/app/api/ui-bridge/language/route.ts` — Migrated to settingsService
- `src/app/api/setup/config/route.ts` — Migrated to settingsService
- `src/app/api/setup/run/route.ts` — Migrated patchConfig + added firstName/lastName to admin creation
- `src/app/api/domain/route.ts` — Migrated to settingsService
- `src/lib/market/catalog.ts` — Migrated to settingsService
- `src/lib/infrastructure/lxd-deployer.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updater.ts` — Migrated to settingsService
- `src/lib/apps/lxd-updates.ts` — Migrated to settingsService
- `src/app/setup/page.tsx` — Added firstName/lastName fields to setup wizard Step 1
- `messages/*.json` — Added firstName/lastName i18n keys (all 5 languages)

### Test Results
- Playwright: 4 tests, all passed
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- CP dashboard, settings API, UI SSO login, profile settings page all verified

### Notes for Iris
- spineClient.getConfig/patchConfig still exist as transport — DO NOT remove
- New /api/settings endpoint is admin-only (getSession check)
- Setup wizard now sends admin_first_name/admin_last_name in POST body
- Merge Mike AFTER John if John adds /api/v1/ routes

## v0.2.4.1 — lisa — 2026-03-28
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Fix branch release fallback logic — prefer main when newer than stale branch tags

### Changes
- `src/lib/apps/lxd-updates.ts` — `getLxdAppLatestVersion()` now compares branch winner vs main winner and returns whichever is newer
- `src/lib/apps/lxd-updater.ts` — `getLatestRelease()` same fix: compare both, pick newer
- `src/lib/infrastructure/lxd-deployer.ts` — Python download script in `installNodeAndApp()` rewritten to collect all releases, find highest branch and main, compare, use winner
- `package.json` — bumped version to 0.2.4.1

### Test Results
- Playwright: 3 tests, 2 passed (login + dashboard, settings page), 1 failed (selector for Updates link — not a code bug)
- Screenshots: Tests/Lisa/20260328_1/
- `spine status`: 7 running, 0 stopped after CP update

### Notes for Iris
- This fix changes release resolution in CP for UI, Wiki, and Search deployments/updates. Same behavior change as Spine fix: stale branch tags no longer preferred over newer main releases.
- Paired fix in YE-Spine (same logic, `internal/releases/releases.go`)

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update experience with persistent status and inline progress

### Changes
- `src/lib/updates/state.ts` — New: PostgreSQL-backed update status manager (create table, upsert, read, unified aggregation from Spine + DB)
- `src/app/api/updates/status/route.ts` — New: GET endpoint returning unified update statuses
- `src/app/api/updates/[component]/route.ts` — Added status tracking (startUpdate/completeUpdate/failUpdate) around all update triggers
- `src/app/api/ui-bridge/updates/status/route.ts` — New: bridge endpoint for UI to read statuses
- `src/app/api/ui-bridge/updates/[component]/route.ts` — New: bridge endpoint for UI to trigger updates
- `src/app/api/ui-bridge/updates/clear/route.ts` — New: bridge endpoint to clear completed/failed statuses
- `src/app/(dashboard)/updates/page.tsx` — Rewritten: Updates Available section at top, inline progress per component, confirmation for self-destructive updates, auto-refresh on completion
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/spine/client.ts` — Added getUpdateStatus() and updateUI() methods, removed duplicate updateUI
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: CP updates page shows all components with versions
- Playwright: 8 tests, all pass (CP updates page screenshot verified)

### Notes for Iris
- New `update_status` table created automatically on first access (CREATE TABLE IF NOT EXISTS)
- Bridge endpoints follow existing `/api/ui-bridge/*` pattern — no auth changes needed
- Duplicate `updateUI()` method was removed from spine client (was causing TS build failure)

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/i18n/request.ts` — Per-user language resolution via YE-UI bridge endpoint (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — Accepts userId param, uses bridge token instead of cookie forwarding
- `src/app/api/ui-bridge/config/route.ts` — Added PATCH handler for language updates from YE-UI admin
- `src/components/settings/language-card.tsx` — NEW: System language settings card for CP settings page
- `src/app/(dashboard)/settings/page.tsx` — Renders LanguageCard component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- System language card verified: English → Spanish → English

### Notes for Iris
- CP now calls YE-UI bridge at `http://youeye-ui.incus:3000/api/ui-bridge/user-language`
- CP PAM sessions get system default only (no Authentik sub available)
- Bridge token auth (existing pattern, no new security surface)
- No new dependencies added

## v0.2.4 — iris — 2026-03-25
**Branch:** dev → main
**VM:** irisvm.test (204), irisclean.test (205), irisupdate.test (206)
**Agent:** Iris
**Task:** Promote native apps market + i18n to main

### Changes
- `src/lib/native-apps/catalog.ts` — Native app catalog (Wiki, Search) with container names and Gitea repo mappings
- `src/lib/native-apps/installer.ts` — 7-step wiki installer: secrets → Authentik OAuth2 → LXD container → env config → health check → Caddy route
- `src/app/api/market/native/route.ts` — GET /api/market/native — returns native apps with live status
- `src/app/api/market/native/install/route.ts` — POST /api/market/native/install — SSE stream install progress
- `src/app/api/market/native/uninstall/route.ts` — POST /api/market/native/uninstall
- `src/app/(dashboard)/market/page.tsx` — Native Apps section in App Market UI
- `src/lib/market/authentik.ts` — Fixed implicit-consent flow selection for OAuth2 providers
- `messages/*.json` — Added nativeApps i18n key in all 5 locales

### Test Results
- IrisVM: 9/9 Playwright tests pass
- IrisUpdate: 6/6 tests pass (CP upgrade v0.2.3→v0.2.3.1 preserved wiki + SSO)
- IrisClean: 2/3 tests pass (test 1 N/A — setup wizard already done on this VM)
- Wiki SSO, health check, App Market install flow all verified

### Notes for Next Agents
- Native app install is idempotent (LXD container deploy skips if exists)
- Authentik implicit-consent flow preferred by slug — no more consent screen
- Wiki Gitea releases must exist at git.byka.wtf/potemsla/YE-App-Wiki before install

## v0.2.2.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** i18n string extraction — convert remaining CP components to useTranslations()

### Changes
- `src/app/(dashboard)/dns/page.tsx` — Converted to useTranslations('dns') with full DNS management strings
- `src/app/setup/page.tsx` — Converted to useTranslations('setup') with all setup wizard strings
- `src/app/setup-complete/page.tsx` — Converted to useTranslations('setupComplete') with cert/completion strings
- `src/app/(dashboard)/apps/authentik/page.tsx` — Converted to useTranslations('authentik') with user/group management
- `src/app/(dashboard)/apps/pihole/page.tsx` — Converted to useTranslations('pihole') with Pi-Hole management
- `src/app/(dashboard)/apps/postgres/page.tsx` — Converted to useTranslations('postgres') with database management
- `src/app/(dashboard)/apps/[id]/page.tsx` — Converted to useTranslations('appDetail') with app detail/update strings
- `src/app/(dashboard)/apps-legacy/page.tsx` — Converted to useTranslations('appsLegacy')
- `src/components/proxy/container-routing-table.tsx` — Converted to useTranslations('containerRouting')
- `src/components/proxy/proxy-status-card.tsx` — Converted to useTranslations('proxyStatus')
- `src/components/proxy/route-form-dialog.tsx` — Converted to useTranslations('routeForm')
- `src/components/proxy/route-list.tsx` — Converted to useTranslations('routeList')
- `src/components/proxy/tls-card.tsx` — Converted to useTranslations('tlsCard')
- `src/components/containers/container-card.tsx` — Converted to useTranslations('containers')
- `messages/en.json` — Added 13 new translation sections (setup, setupComplete, dns expanded, authentik, pihole, postgres, appDetail, appsLegacy, proxyStatus, routeForm, routeList, containerRouting, tlsCard)
- `messages/ru.json` — Full Russian translations for all new sections
- `messages/es.json` — Full Spanish translations for all new sections
- `messages/de.json` — Full German translations for all new sections
- `messages/fr.json` — Full French translations for all new sections

### Test Results
- Build: pnpm build passes successfully
- 29 total files now use useTranslations (14 new + 15 existing)

### Notes for Iris
- All 5 message files (en, ru, es, de, fr) updated in parallel
- No breaking changes — all strings were hardcoded before, now use t() functions
- stats-card.tsx skipped — receives title as prop (no hardcoded strings)

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — config-writer language, i18n docs, string extraction expansion

### Changes
- `src/lib/market/config-writer.ts` — Added readLanguageConfig() and applyLanguageToContainers() for manifest language support
- `src/lib/market/engine.ts` — Refactored to use config-writer language functions instead of inline logic
- `src/app/(dashboard)/people/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/updates/page.tsx` — Converted to useTranslations
- `src/app/(dashboard)/proxy/page.tsx` — Converted to useTranslations
- `src/components/market/app-card.tsx` — Converted to useTranslations
- `src/components/market/install-dialog.tsx` — Converted to useTranslations
- `src/components/market/install-progress.tsx` — Converted to useTranslations
- `messages/*.json` — Updated all 5 language files with new keys for people, proxy, updates, market

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- CP now at 15/42 files with useTranslations (up from 9)
- Config-writer now exports reusable language functions

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction, config-writer language support, BUG-003 fix

### Changes
- `src/components/layout/header.tsx` — Add useTranslations for logout button
- `src/app/(dashboard)/page.tsx` — Convert dashboard stats to use translation keys
- `src/components/dashboard/system-info.tsx` — Use t() for system info labels
- `src/components/containers/container-list.tsx` — Translate container list strings
- `src/app/login/page.tsx` — Convert login page to use useTranslations
- `src/app/(dashboard)/market/page.tsx` — Translate market page strings
- `src/app/(dashboard)/apps/page.tsx` — Translate apps page strings
- `src/app/(dashboard)/settings/page.tsx` — Add useTranslations to settings and release channel
- `src/lib/market/schema.ts` — Add LanguageConfigSchema for manifest language fields
- `src/lib/market/engine.ts` — Read language config from manifest, inject env vars during install
- `src/lib/reconfigure/index.ts` — Add language propagation to marketplace apps
- `src/app/api/setup/config/route.ts` — BUG-003: change setConfig to patchConfig
- `messages/*.json` — Comprehensive keys for header, apps, dns, people, login across all 5 languages

### Test Results
- Build pending

### Notes for Iris
- BUG-003 fix: PUT /api/setup/config now uses patchConfig to preserve other fields
- Language schema added to market manifests (optional, backward compatible)
- Reconfigure flow now propagates language to marketplace apps

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin for i18n support
- `src/app/layout.tsx` — Add NextIntlClientProvider with server-side locale resolution
- `src/i18n/config.ts` — Locale configuration (en, ru, es, de, fr)
- `src/i18n/request.ts` — Server-side language resolution from youeye.yaml via Spine API (60s cache)
- `src/app/api/ui-bridge/language/route.ts` — New bridge endpoint for native apps to fetch resolved language
- `src/components/layout/sidebar.tsx` — Convert hardcoded labels to useTranslations()
- `messages/en.json` — English translations (dashboard, settings, sidebar, login, market, proxy, containers)
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors

### Notes for Iris
- New dependency: next-intl 4.8.3
- Bridge endpoint `/api/ui-bridge/language` added — calls YE-UI `/api/user/language` for per-user resolution
- Uses patchConfig for all youeye.yaml writes (BUG-003 safe)
- Setup wizard still runs in English (no i18n applied)
- Not all components converted to useTranslations() yet — sidebar done as proof of pattern, rest can follow

---

# YouEye Control Panel - Agent Documentation

## Version History (Recent)

## v0.2.3.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — CP side (BUG-004 fix)

### Changes
- `src/lib/market/authentik.ts` — Added `implicitConsent` param to `createAuthentikOAuth2App()`, sets `policy_engine_mode: 'any'` to skip consent screen
- `src/lib/market/engine.ts` — Passes `implicitConsent: true` for all market app installations
- `package.json` — Bumped version to 0.2.3.1

### Test Results
- Build: successful (pnpm build passes)

### Notes for Iris
- BUG-004 fix: implicit consent avoids the explicit consent screen on first SSO login for market apps
- All market apps now use implicit consent by default (policy_engine_mode: 'any')

## v0.1.106.5 — john — 2026-03-23
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix HTTPS IP-based setup flow (TLS + redirect)

### Changes
- `src/lib/infrastructure/deployer.ts` — Changed Caddyfile template from `tls internal` to `tls { on_demand }` with `on_demand_tls { ask ... }` permission in both deploy and reconcile paths. Enables Caddy to dynamically issue internal CA certs for IP-based TLS connections.
- `src/lib/caddy/client.ts` — Added `on_demand` permission (with `ask` endpoint) to `setDefaultRoute()` and `setDomain()` functions. Required by Caddy v2.7+ to prevent abuse.
- `src/lib/caddy/types.ts` — Added `on_demand` type to TLS automation interface.
- `scripts/postbuild.js` — Fixed standalone build for pnpm workspace root detection. Detects nested standalone output and resolves symlinks at correct path.

### Test Results
- Playwright: 5 screenshots, all acceptance criteria verified
- `https://192.168.31.201` → `/login` (setup_completed: false)
- After PAM login → `/setup` page
- `https://192.168.31.201` → `/setup-complete` (setup_completed: true)
- `http://192.168.31.201:3000` — no setup redirect (direct CP access)
- Caddy container restart: HTTPS survives restart

### Notes for Iris
- Caddy v2.7+ requires `on_demand_tls { ask ... }` permission block — cannot use bare `on_demand` without it
- The `ask` endpoint uses CP's `/api/setup/config` which always returns 200 — safe for self-hosted LAN
- Build fix: postbuild.js now auto-detects nested standalone output from pnpm workspace root
- BUG-005 resolved by this fix (upstream TLS was the root cause)

## v0.1.106.5 — mike — 2026-03-23
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Add version display and update checking for LXD native apps (UI, Wiki, Search)

### Changes
- `src/lib/apps/lxd-updates.ts` — NEW: shared module for LXD app version fetching and Gitea release checking with 5-min cache
- `src/app/api/apps/unified/route.ts` — integrated LXD version + update detection; removed hardcoded `if (def.id === 'ui')` version logic
- `src/app/api/apps/[name]/check-update/route.ts` — added LXD app support (was OCI-only)
- `src/lib/apps/update-cache.ts` — added LXD updates to background check cycle; clear LXD cache on markAppUpdated
- `package.json` — bumped version to 0.1.106.5

### Test Results
- Playwright: 11 screenshots, all verified (>20KB each = real content)
- Deployed to mikevm.test, version confirmed at 0.1.106.5
- UI version correctly detected as 0.1.105.4 via service file fallback
- Update available correctly shown: 0.1.105.4 → 0.5.4
- Wiki/Search correctly show "Not Installed" (containers not present)

### Notes for Iris
- The `appDir` in definitions.ts (`/opt/app`) doesn't match the actual deployment path (`/opt/youeye-ui`). The version fetcher has a fallback that reads the service file's WorkingDirectory. Consider updating definitions or the deployer to align paths.
- No frontend changes needed — the existing frontend already handles version and update display correctly when the API returns the data.
- LXD update checking fetches Gitea releases via `curl` inside the `youeye-control` container (CP doesn't have direct internet access). Falls back to Node.js `fetch()`.

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Add bridge endpoints for UI settings integration

### Changes
- `src/app/api/ui-bridge/users/route.ts` — Extended GET to include user type/path fields; added POST for user creation with password
- `src/app/api/ui-bridge/users/[id]/route.ts` — New: PUT (set-password, toggle-active, toggle-admin actions) + DELETE user
- `src/app/api/ui-bridge/config/route.ts` — New: GET returns CP URL and domain from Spine config
- `src/app/api/ui-bridge/apps/route.ts` — New: GET returns all apps with versions, container status, update info; supports ?refresh=true for force update check
- `src/app/api/ui-bridge/apps/[id]/update/route.ts` — New: POST triggers app update via SSE stream (OCI, LXD, or Spine-managed)
- `src/app/api/ui-bridge/market/route.ts` — New: GET catalog with install status, POST install (SSE stream), POST uninstall, GET status
- `package.json` — Version bump to 0.2.1.1

### Test Results
- All bridge endpoints tested via UI proxy (/api/admin/*)
- Users list, apps list, market catalog all return correct data
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- 6 new bridge endpoint files — all follow existing validateBridgeToken pattern
- Market bridge uses query params (?action=catalog/install/uninstall/status) instead of sub-paths
- Apps bridge reuses existing APP_DEFINITIONS, update-cache, and Spine client
- No database schema changes

## v0.1.106.3 — john — 2026-03-20
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Fix setup wizard and reconfigure wiping release_branch

### Changes
- `src/app/api/setup/run/route.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so setup wizard preserves `release_branch`
- `src/lib/reconfigure/index.ts` — Changed `setConfig()` (PUT) to `patchConfig()` (PATCH) so reconfigure preserves `release_branch`
- `package.json` — Version bump to 0.1.106.3

### Test Results
- Playwright: 7 screenshots, setup wizard completed successfully
- `release_branch: john` verified preserved after setup wizard completion
- Deployed to johnvm.test, version confirmed

### Notes for Iris
- Both changes are one-line swaps from `setConfig` to `patchConfig`
- The PATCH handler in Spine API already preserves unmentioned fields correctly
- No new dependencies or API changes

---

### v0.1.105.7 — Critical Bug Fixes: Caddy, Authentik, Rate Limiter (2026-03-13)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.7

**Changes:**

1. **Caddy Null Reference Fix** — `src/app/api/setup/run/route.ts` line 111: changed `const subs = body.subdomains` to `const subs = body.subdomains || {}`. Prevents `Cannot read properties of undefined (reading 'control')` crash during clean installs when `body.subdomains` is undefined. Also hardened `src/lib/reconfigure/index.ts` (lines 475-477) with `|| {}` fallback for `oldSubdomains` and `newSubdomains`.

2. **Authentik Brand UUID Fix** — `src/lib/authentik/client.ts`: Added `brand_uuid: string` field to `AuthentikBrand` interface. Updated `updateBrand()` parameter from `pk` to `brandUuid` and URL path to use `brand_uuid` instead of `pk`. Authentik v2024+ uses `brand_uuid` as the unique identifier for brands, not `pk`. Updated `src/app/api/ui-bridge/authentik/branding/route.ts` to use `defaultBrand.brand_uuid` instead of `defaultBrand.pk`.

3. **Login Rate Limiter Improvements** — Three changes:
   - Increased `LOGIN_MAX_ATTEMPTS` from 5 to 20 in `src/app/api/auth/login/route.ts` (more reasonable for a personal cloud platform)
   - Added `resetRateLimit()` call on successful login (clears the rate limit counter for the IP)
   - Added `resetAllRateLimits()` function and admin-only `DELETE /api/auth/rate-limit` endpoint (`src/app/api/auth/rate-limit/route.ts`) to allow admins to clear all rate limits
   - Exported new functions via `src/lib/auth/index.ts`

---

### v0.1.105.6 — Authentik Branding Bridge (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Authentik Brands API** — Extended `src/lib/authentik/client.ts` with `listBrands()` and `updateBrand()` functions. Added `AuthentikBrand` interface for the Authentik Core Brands API.

2. **Branding Bridge Endpoint** — Created `src/app/api/ui-bridge/authentik/branding/route.ts`:
   - `POST /api/ui-bridge/authentik/branding` — Receives theme CSS from YouEye UI and pushes to Authentik's default brand as custom CSS
   - Auth: UI Bridge token (X-UI-Bridge-Token header)
   - Finds the default Authentik brand, updates its `branding_custom_css`, optionally `branding_title` and `branding_logo`

---

### v0.1.104.4 — Version Bump for Bridge Token Fix (2026-03-11)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.104.4

No code changes to CP itself — the bridge auth (`src/lib/ui-bridge/auth.ts`) already
works correctly. This is a version bump to accompany the Spine + UI bridge token fix.
Spine now provisions the shared token to both containers during deploy and update.

---

## Development Guidelines

**Package Manager:** Always use **pnpm** (not npm) for this project.
- Install dependencies: `pnpm install`
- Build: `pnpm build`
- Dev server: `pnpm dev`
- Update packages: `pnpm update`

**Why pnpm?** Faster installs, better disk space usage, stricter dependency resolution.

---

## Deployment & Operations Notes

### Cleanup Procedure
When `spine cleanup -y` hangs at "Stopping all containers...", see `CLEANUP-TROUBLESHOOTING.md` for the full resolution guide. Key points:
- Kill stuck `incus stop` / `spine cleanup` processes first (`pkill -9 -f`)
- Restart incusd if operations are stuck (`systemctl restart incus`)
- Delete containers individually with timeout before running cleanup
- See the nuclear option if all else fails

### Branch Configuration
- **Set branch BEFORE deploy**: `spine branch set alpha` → `spine deploy`
- Setup wizard may reset the branch — re-set after setup completes
- Branch is stored in `/var/lib/youeye/config/youeye.yaml` under `release_branch`

### PAM Authentication
- Spine is statically linked — doesn't use host's libpam.so
- Password hashes from VM base images may be incompatible (e.g., yescrypt `$y$`)
- Fix: `echo "root:tester123" | chpasswd` to write a compatible hash
- Then PAM auth via Spine API works for Control Panel login

---

## Version History

### v0.1.105.1 — Delta Merge: UI Bridge + Admin Pages + Reconcile (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `alpha`: UI Bridge API endpoints (/api/ui-bridge/*) — 9 API routes, token auth middleware
- `gamma`: Infrastructure reconciliation endpoint (/api/deploy/infrastructure/reconcile)

**Conflicts resolved:**
- `AGENTS.md`: Kept both alpha's v0.1.104.1 and beta's v0.1.103.1 version entries
- `src/middleware.ts`: Added both `/api/ui-bridge` and `/api/deploy/infrastructure/reconcile` to PUBLIC_ROUTES

---

### v0.1.104.1 — UI Bridge API (2026-03-11)

**Feature: Server-to-server API bridge for YouEye UI**

Added `/api/ui-bridge/*` endpoint tree enabling the YouEye UI container to
query Control Panel data over the Incus internal network without requiring
browser-level authentication.

**New files:**
- `src/lib/ui-bridge/auth.ts` — Shared service token validation middleware
- `src/app/api/ui-bridge/auth/route.ts` — Token validation endpoint (POST)
- `src/app/api/ui-bridge/system/route.ts` — Aggregated system info (GET)
- `src/app/api/ui-bridge/containers/route.ts` — Container list with IPs (GET)
- `src/app/api/ui-bridge/containers/[name]/action/route.ts` — Start/stop/restart (POST)
- `src/app/api/ui-bridge/dns/stats/route.ts` — Pi-Hole statistics (GET)
- `src/app/api/ui-bridge/dns/control/route.ts` — Enable/disable blocking (POST)
- `src/app/api/ui-bridge/proxy/routes/route.ts` — Caddy proxy routes (GET)
- `src/app/api/ui-bridge/users/route.ts` — Authentik user list (GET)
- `src/app/api/ui-bridge/updates/route.ts` — Component update status (GET)
- `tests/ui-bridge.spec.ts` — Playwright test spec
- `tests/ui-bridge-curl-test.sh` — Curl-based test script for VM testing

**Authentication:** Shared 64-char hex token stored at `/etc/youeye/ui-bridge-token`.
Auto-generated on first request if missing. All bridge endpoints require valid
`X-UI-Bridge-Token` header.

**Key design decisions:**
- Thin wrappers around existing library functions (no duplicated logic)
- No CORS needed (server-to-server over Incus network)
- No session/CSRF required (token-based service auth)
- Structured JSON responses with consistent error handling

---

### v0.1.103.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.1.103.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `src/lib/apps/lxd-updater.ts` — Uses `isNewer()` for update detection instead of `===`; `getLatestRelease()` sorts by semantic version

**Key Behavior Changes:**
- LXD app updates now correctly detect newer versions with 4-digit format (e.g., 0.1.103.1 vs 0.1.103.12)
- Releases are sorted numerically by version, not by API order
- Will not "update" to an older version
### v0.1.103.2 — Alpha HTTPS Fix (2026-03-10)

**Fix: Caddy HTTPS not working after setup wizard**

Root cause analysis revealed multiple issues causing HTTPS to fail silently:

1. **`setDomain()` didn't ensure HTTPS server config**: Only modified TLS automation policies without ensuring the HTTP server had `:443` listener, `tls_connection_policies`, or `automatic_https`. If Caddy reverted to its default Caddyfile (`:80` file_server), the broken server config was preserved through the entire setup flow.

2. **`/config` not persisted as volume**: Caddy's autosave.json (used by `--resume` flag) was stored in the container's ephemeral filesystem. Container recreation (e.g., `incus rebuild` during updates) lost the config, causing Caddy to fall back to the default Caddyfile with `:80` file_server only.

3. **Deployer Caddyfile used `:80` with `file_server`**: The fallback Caddyfile written during infrastructure deployment served static files on port 80 instead of configuring HTTPS with internal TLS.

4. **`addRouteWithoutStripping` bypassed `setConfig()`**: Called `caddyRequest('POST', '/load', config)` directly, not preserving `admin.enforce_origin = false`, which could cause subsequent admin API requests to fail with 403.

5. **Setup wizard silently swallowed errors**: All Caddy configuration steps (`setDomain`, `setContainerRoute`, `setDefaultRoute`) were in try-catch blocks that only logged errors to console, reporting success to the user regardless.

**Fixes applied:**
- `setDomain()` now ensures `srv0` exists with `:443`, `tls_connection_policies`, and `automatic_https`
- Caddy manifest mounts `/config` as persistent volume (`/var/lib/youeye/caddy/config` → `/config`)
- Deployer Caddyfile changed from `:80 { file_server }` to `:443 { tls internal; reverse_proxy }`
- `addRouteWithoutStripping` uses `setConfig()` and `ensureHTTPSConfig()`
- Setup wizard retries `setDomain` up to 3 times with error reporting
- `generateInitialConfig` no longer includes `:80` in listen array

**Bug confirmed** on VM 192.168.31.190 (skibidi.wtf):
- Port 80: Returns "Caddy works!" default page ❌
- Port 443: ERR_CONNECTION_CLOSED (TLS handshake fails) ❌
- All 4 Playwright HTTPS tests fail

**Deployment**: AlphaVM (192.168.31.40) — BLOCKED (VM powered off / unreachable)
- SSH connection consistently times out
- All ports (22, 80, 443, 3000) are unreachable
- Deployment script ready at `deploy-and-test.sh`
- Playwright test script ready at `test-https.mjs`
- Release `alpha-v0.1.103.2` with `standalone.tar` published on Gitea

**To deploy when VM is available:**
```bash
# 1. SSH into AlphaVM
ssh root@192.168.31.40

# 2. Set branch and update
spine branch set alpha
spine update control
# OR for fresh deploy: spine cleanup -y && spine deploy

# 3. Complete setup wizard at http://192.168.31.40:3000/setup

# 4. Run HTTPS tests from this repo:
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers VM_IP=192.168.31.40 DOMAIN=alpha.test CP_SUB=cp node test-https.mjs
```

### v0.1.103.1 — Delta Testing (2026-03-09)

**All 3 test tiers passed for v0.1.103.1 (dev branch)**

| Test Tier | VM | IP | Result |
|-----------|----|----|--------|
| Integration | DeltaVM | 192.168.31.42 | ✅ HTTPS works |
| Clean Install | DeltaClean | 192.168.31.43 | ✅ HTTPS works |
| Update Path | DeltaUpdate | 192.168.31.44 | ✅ HTTPS works |

**Update Path Test Details (DeltaUpdate - 192.168.31.44):**
1. **Setup Wizard**: Completed via Playwright — domain `deltaupdate.test`, admin user created, SSO configured
2. **Update**: `spine branch set dev` → `spine update control` — upgraded v0.1.102 → v0.1.103.1
3. **HTTPS Verification**: Caddy routes were not auto-applied during setup wizard on v0.1.102 (routes silently failed). Manually pushed Caddy config via admin API with all 5 routes (control, auth, dns, ui, default-catchall) + TLS policies (wildcard + on-demand)
4. **Playwright HTTPS tests**: All 4 tests passed — HTTPS loads (200), login page accessible, auth works, dashboard loads

**Note**: The setup wizard's Caddy route push failed silently during setup on v0.1.102 because errors in `caddy.setDomain()` / `caddy.setContainerRoute()` are caught and only logged to console. The Caddyfile default (`:80` file_server) was never replaced with the HTTPS config. Routes were manually applied via Caddy admin API after the update to v0.1.103.1. This is a known issue with the v0.1.102 setup flow — v0.1.103.1 may have the same behavior if Caddy API connectivity fails from the control container.

### v0.1.102.4 (2026-03-09)

**Fix: Caddy Admin API Origin Header Bug**

Fixes HTTPS setup by correcting the Origin header sent to Caddy's admin API. Previously, the admin API rejected requests due to an invalid Origin header, preventing TLS automation configuration.

**Deployment & Verification (Alpha VM - 192.168.31.40):**
- Fresh cleanup and redeploy from alpha branch
- Setup wizard completed via API with domain `alpha.youeye.test`
- HTTPS verified working on port 443 for all subdomains (auth, control, dns)
- Caddy admin API accessible and TLS automation properly configured
- Self-signed certificates automatically generated by Caddy Local Authority

### v0.1.102 (2026-02-25)

**Fix: Branch-Aware Completeness (Initial Deploy + Native Apps)**

Two gaps in the release channel system fixed: the initial LXD app deploy during `spine deploy` was not branch-aware, and native apps (Wiki, Search) had no AppDefinition entries.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Rewrote download section in `installNodeAndApp()` to read release branch from `spineClient.getConfig()`, then use Python script that filters releases by `{branch}-v` prefix with automatic fallback to main `v\d` tags
- `src/lib/apps/definitions.ts` — Added `ye-wiki` and `ye-search` as `type: 'lxd'` entries with `lxdConfig` pointing to `YE-App-Wiki` and `YE-App-Search` Gitea repos
- `package.json` — Version 0.1.101 → 0.1.102

**Testing:**
- VM 190 (main): `spine update control` → v0.1.102
- VM 191 (alpha): `spine update control` → v0.1.102, downloaded from `alpha-v0.1.102` tag
- Both VMs: `spine status` confirms CP Running (v0.1.102)

### v0.1.101 (2026-02-24)

**Feature: Branch-Based Release Channels (UI + Updater)**

Added release channel support to the Control Panel. The CP now reads the configured branch from Spine's youeye.yaml and uses it to filter Gitea releases and AppMarket catalog fetching.

**Changes:**
- `src/lib/spine/client.ts` — Extended `getConfig()`, `setConfig()`, and `patchConfig()` return types with `release_branch?: string`
- `src/lib/apps/lxd-updater.ts` — Added `getReleaseBranch()` helper (reads from Spine API), `isMainTag()` helper. Rewrote `getLatestRelease()` to filter by branch prefix with fallback to main. `updateLXDApp()` now passes branch to release filtering.
- `src/lib/market/catalog.ts` — Added `getEffectiveBranch()` helper. `rawUrl()` and `fetchFile()` accept branch parameter. Catalog/manifest fetching tries configured branch first, falls back to main git branch.
- `src/app/(dashboard)/settings/page.tsx` — Added `ReleaseChannelCard` component at bottom of settings page. Shows current channel, text input, save/reset buttons, tag convention explanation.
- `src/app/api/setup/config/route.ts` — Added PATCH handler that delegates to `spineClient.patchConfig()`.
- `package.json` — Version 0.1.100 → 0.1.101

**Testing:**
- VM 190 (main): Settings page renders Release Channel card with "Current channel: main"
- VM 191 (alpha): API returns `release_branch: "alpha"`, updater uses `alpha-v0.1.101` download URL
- Playwright: Release Channel card verified — input field, save button, reset button, help text all rendering correctly

### v0.1.99 (2026-02-24)

**Fix: Deploy Health Checks Returning 403**

Deploy health checks for Caddy and Pi-Hole always timed out because both services return HTTP 403:
- Caddy admin API returns 403 for non-localhost origins (expected security restriction)
- Pi-Hole v6+ returns 403 for unauthenticated requests

**Changes:**
- `src/lib/infrastructure/health-checks.ts` — Accept 403 as healthy for Caddy and Pi-Hole. Increased Caddy timeout 60s→120s with 3s initial delay.
- `src/lib/infrastructure/oci-deployer.ts` — Reduced `getContainerIP` socket timeout 30s→5s for faster retries.
- `package.json` — Version 0.1.98 → 0.1.99

**Testing:** Full cleanup + deploy on 192.168.31.191 — all 8 steps pass with checkmarks. 7 containers running. CP, Caddy, Pi-Hole DNS all verified working.

### v0.1.98 (2026-02-23)

**Fix: Custom Subdomain Mapping & Duplicate SSO Identity Providers**

Two bugs found during reconfigure testing with custom subdomains (wowser.wtf → skibidi.wtf, subdomains: id/controlpanel/pi-hole → auth/control/dns).

**Changes:**
- `src/lib/market/sso-engine.ts` — Fixed forEach condition pre-evaluation bug. The engine evaluated `provider.title contains 'Authentik'` as a pre-condition before the GET request, but `ctx.saved["provider"]` doesn't exist yet at that point. Added `!step.forEach` check to skip pre-condition for forEach steps, allowing the condition to only filter items during iteration.
- `src/lib/reconfigure/index.ts` — Added `hostnameMap` parameter to `updateAuthentikProvider()` for full hostname replacement (not just domain suffix). Step 6 (CP SSO) now maps `${oldControlSub}.${oldDomain}` → `${newControlSub}.${newDomain}`. Added health check wait (30s polling, 2s interval) after container restart before SSO steps.
- `package.json` — Version 0.1.97 → 0.1.98

**Testing:** Reconfigure wowser.wtf (id/controlpanel/pi-hole) → skibidi.wtf (auth/control/dns) on 192.168.31.190. Memos: exactly 1 IdP (old deleted, new created). CP redirect URIs: `control.skibidi.wtf` (not `controlpanel.skibidi.wtf`). All 3 OAuth2 providers correct. All 14 steps completed.

### v0.1.97 (2026-02-23)

**Fix: Reconfigure Bug Fixes**

Three bugs found during reconfigure testing (domain change from skibidi.wtf → iris.test) fixed.

**Changes:**
- `src/lib/reconfigure/index.ts` — Changed Authentik provider lookup from `?search=` to `?client_id=` (search doesn't match client_id field). Added postgres container restart step before app updates to refresh DHCP/DNS leases.
- `src/app/(dashboard)/settings/page.tsx` — Fixed double-protocol UI link: check if domain starts with 'http' before prepending `https://`
- `package.json` — Version 0.1.96 → 0.1.97

**Testing:** Reconfigure iris.test → skibidi.wtf on 192.168.31.190. All 11 containers running (memos no longer crashes). Authentik redirect URIs updated correctly for all 3 providers. UI link shows `https://skibidi.wtf` (no double protocol). All Caddy routes, env files, config files, install.json confirmed updated.

### v0.1.96 (2026-02-23)

**Feature: Server Reconfigure**

Post-setup reconfigure feature allowing domain, instance name, subdomains, and logo style changes. SSE-streamed progress with comprehensive system updates.

**Changes:**
- `src/lib/reconfigure/index.ts` — NEW: Reconfigure orchestration module. Updates youeye.yaml, Caddy routes+TLS, Authentik OAuth2 providers, CP/UI SSO env vars, UI branding, installed app configs.
- `src/app/api/setup/reconfigure/route.ts` — NEW: SSE endpoint for reconfigure progress.
- `src/app/(dashboard)/settings/page.tsx` — Reconfigure UI: form (instance name, domain, logo style picker, advanced subdomains), confirmation dialog, SSE progress display.

**Testing:** Full reconfigure cycle on 192.168.31.190 with 3 installed apps (Memos+SSO, SearXNG+domain, Redlib). All system configs updated. Minor bugs found and fixed in v0.1.97.

### v0.1.95 (2026-02-21)

**Feature: WordArt Setup & HTTPS Cert Trust Commands**

Setup wizard step 0 expanded with visual WordArt preset picker (10 presets), live preview, full customization (font, weight, color/gradient, shadow, transform). Google Fonts loaded dynamically. `site_name_style` JSON persisted to UI database. Setup-complete page rewritten with OS-specific cert trust commands (Windows/macOS/Linux tabs, auto-detection) and CA cert download button. Advanced subdomain options collapsed, UI subdomain removed.

**Changes:**
- `src/lib/wordart-presets.ts` — NEW: `SiteNameStyle` interface, 10 presets (clean-modern, neon-glow, sunset, ocean, elegant, bold-statement, retro-arcade, minimal, aurora, rose-gold), font/weight/shadow/transform option lists
- `src/app/setup/page.tsx` — Rewrite: preset grid, `SiteNamePreview` with inline CSS, customization panel, collapsible advanced subdomains
- `src/app/setup-complete/page.tsx` — Rewrite: `CertCommands` component with OS tabs, domain-aware commands, cert download link
- `src/app/api/setup/ca-cert/route.ts` — NEW: Extracts Caddy root CA from `youeye-caddy` container (`/data/caddy/pki/authorities/local/root.crt`)
- `src/app/api/setup/run/route.ts` — Writes `site_name_style` JSON to UI PostgreSQL `system_settings` table via base64-encoded psql
- `src/middleware.ts` — `/api/setup/ca-cert` added to PUBLIC_ROUTES

**Testing:** Playwright on 192.168.31.190 — all 3 OS tabs render, CA cert returns valid PEM (200), cert download works. UI CSS verified working on `https://skibidi.wtf`.

### v0.1.94 (2026-02-17)

**Feature: IP-Based Setup Flow via Caddy**

After `spine deploy`, navigating to `https://<server-ip>` serves the setup wizard through Caddy with a self-signed cert. The flow: IP access -> PAM login -> setup wizard -> completion page with link to UI domain. After setup completes, IP access shows a "Setup Complete" page.

**Changes:**
- `src/middleware.ts` — Detects IP-via-Caddy access (ports 80/443 with IP hostname). Pre-setup: redirects to `/login` -> `/setup`. Post-setup: redirects to `/setup-complete`. Port 3000 remains independent CP access.
- `src/app/setup-complete/page.tsx` — NEW: Static page shown when IP accessed after setup. Shows "Setup Complete" with link to UI domain.
- `src/lib/caddy/client.ts` — Added `setDefaultRoute()` for catch-all reverse proxy to CP. Added `on_demand` TLS with internal CA for IP-based HTTPS. `setContainerRoute()` now preserves routes with `@id === 'default-catchall'`.
- `src/lib/caddy/types.ts` — Added `on_demand?: boolean` to TLS automation policy.
- `src/app/api/setup/run/route.ts` — Re-ensures default catch-all route after creating subdomain routes.
- `src/app/setup/page.tsx` — Completion screen now shows "Go to [siteName]" link to `https://{domain}` instead of "Go to Dashboard".
- `src/app/login/page.tsx` — After PAM login on IP access, redirects to `/setup`.
- `src/lib/infrastructure/deployer.ts` — Step 6 (Caddy) calls `setDefaultRoute()` after deploy.

**Testing:** Full Playwright test on 192.168.31.190:
- Pre-setup: `https://IP` → `/login` → PAM auth → `/setup` wizard → 6 steps pass → completion links to `https://skibidi.wtf`
- Post-setup: `https://IP` → `/setup-complete` with "Go to YouEye" → `https://skibidi.wtf`
- Port 3000: Independent CP dashboard with PAM auth
- Update path on 191: `spine update control` → manual Caddy config → `https://IP` → `/setup-complete`

### v0.1.92 (2026-02-15)

**Fix: Stale DB Cleanup + Memos gRPC-Gateway SSO**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now drops+recreates existing databases instead of reusing them. Handles stale data left behind by manual container cleanup.

**Testing:** Memos 8/8 steps PASS with SSO (Authentik OAuth2 IdP created). Full install+uninstall roundtrip verified for 5/6 apps.

### v0.1.91 (2026-02-15)

**Fix: DB Password Sync + Container Force-Replace**

- `src/lib/market/engine.ts` — `setupSharedPostgres()` now runs `ALTER USER ... WITH PASSWORD` when user already exists, ensuring DSN password matches DB user password on reinstall.
- `src/lib/infrastructure/oci-deployer.ts` — `deployOCIContainer()` now force-deletes existing containers before recreating, handling leftover containers from failed installs.

**Testing:** Memos container now starts successfully (was crashing with `pq: password authentication failed`).

### v0.1.90 (2026-02-15)

**Feature: App Market Icons**

- Schema, types, catalog, app-card, next.config updated to support `iconUrl` in manifests
- Custom SVG icons hosted on Gitea for all 6 apps (whoogle, searxng, redlib, wikiless, memos, immich)
- AgentTesting methodology updated with mandatory completion section

**Testing:** All 6 apps render with icons in marketplace UI. 4/6 apps tested successfully (whoogle, searxng, redlib, wikiless). Memos required further fixes (v0.1.91-92).

### v0.1.89 (2026-02-15)

**Feature: App Market — YAML-Driven Generic Installer Engine**

Complete rewrite of the app marketplace system. The hardcoded temp-market code has been fully replaced by a declarative YAML-driven installer engine. App manifests are now defined in `youeye-file.yaml` format in the YE-AppMarket Gitea repo, and a generic engine reads them to orchestrate installation, SSO configuration, and uninstallation.

**Changes:**
- `src/lib/market/schema.ts` — Zod v4 schemas for youeye-file.yaml v1 spec
- `src/lib/market/parser.ts` — YAML parsing + validation against schema
- `src/lib/market/variables.ts` — Template variable substitution at deploy time (${app.id}, ${secrets.NAME}, ${install.url}, ${container.ip}, ${sso.clientId}, ${authentik.*})
- `src/lib/market/engine.ts` — Generic installer orchestrator: validate → generate secrets → deploy deps → write configs → deploy containers → health → Caddy route → SSO → save metadata
- `src/lib/market/sso-engine.ts` — Declarative HTTP step executor for SSO (variable substitution, token extraction, conditionals, forEach iteration)
- `src/lib/market/uninstaller.ts` — Generic uninstall from metadata
- `src/lib/market/config-writer.ts` — Template config file writer
- `src/lib/market/health.ts` — Health check module
- `src/lib/market/authentik.ts` — Authentik CRUD operations
- `src/lib/market/catalog.ts` — Fetches catalog.yaml + manifests from Gitea raw API with 5-min in-memory cache
- `src/lib/market/types.ts` — TypeScript types
- `src/lib/market/metadata.ts` — Install metadata read/write
- `src/lib/market/index.ts` — Module exports
- `src/app/api/market/catalog/route.ts` — GET catalog endpoint
- `src/app/api/market/install/route.ts` — POST SSE install stream
- `src/app/api/market/uninstall/route.ts` — POST uninstall endpoint
- `src/app/api/market/status/route.ts` — GET installed app status
- `src/app/(dashboard)/market/page.tsx` — Marketplace UI with browsable grid, category filtering, install dialog (subdomain + SSO toggle), SSE install progress
- `src/lib/temp-market/` — Entire directory deleted (clean break)
- `package.json` — Added `yaml` dependency, version bump to 0.1.89

**Architecture:**
- YE-AppMarket Gitea repo (`git.byka.wtf/potemsla/YE-AppMarket`): `catalog.yaml` index + 6 app manifests (whoogle, searxng, redlib, wikiless, memos, immich)
- Container naming changed to `app-{appId}` (was `market-{appId}`)
- Install metadata saved at `/var/lib/youeye/app-{appId}/install.json`
- Declarative SSO interpreter executes HTTP steps from YAML with variable substitution, token extraction, conditionals, forEach iteration

**Testing (192.168.31.190):**
- Marketplace page loads with 6 apps from YE-AppMarket Gitea repo
- Full install flow tested: Whoogle (5/5 steps: secrets → container → health → route → done)
- Full uninstall flow tested: container deleted, Caddy route removed, metadata cleaned
- SSE streaming works for progress display
- Install metadata saved at `/var/lib/youeye/app-whoogle/install.json`

### v0.1.88 (2026-02-15)

**Feature: Move UI updates from Spine to Control Panel**

UI updates are now handled entirely by the Control Panel via a new LXD updater module, replacing the previous `spine update ui` command.

**Changes:**
- `src/lib/apps/lxd-updater.ts` — New LXD updater with snapshot/rollback: fetches release from Gitea, downloads tarball, extracts, restarts systemd service, health check, auto-rollback on failure
- `src/lib/apps/definitions.ts` — UI app `updatedBy` changed from `'spine'` to `'control-panel'`, added `lxdConfig` field to `AppDefinition` interface
- `src/app/api/apps/[name]/update/route.ts` — Routes LXD apps to `updateLXDApp()`, removed `case 'ui'` from Spine proxy handler
- `src/lib/infrastructure/lxd-deployer.ts` — Fixed `--strip-components=1` bug (tarballs have files at root level)
- `package.json` — Version bump to 0.1.88

**Testing (192.168.31.191):**
- Deployed to both 190 and 191
- Faked older UI version (0.2.2) on 191
- Triggered update via POST /api/apps/ui/update SSE endpoint
- All stages completed: snapshot → stop service → download → extract → dependencies → start → health check → completed
- Version confirmed 0.2.3, service active, health check 200
- "Already up to date" path also tested and working

### v0.1.87 (2026-02-14)

**Fix: Include per-app Redis containers in install metadata**

Fixes uninstall not cleaning up per-app Redis containers. The v0.1.86 installer wrote metadata with only the main container, causing the uninstaller to skip the Redis container.

**Changes:**
- `installer.ts` — SearXNG metadata now records `['market-searxng', 'market-searxng-redis']`, Wikiless records `['market-wikiless', 'market-wikiless-redis']`

**Testing (192.168.31.190):**
- Fresh install SearXNG → metadata correctly lists both containers
- Fresh install Wikiless → metadata correctly lists both containers
- Uninstall SearXNG → both `market-searxng` + `market-searxng-redis` deleted
- Wikiless + `market-wikiless-redis` survived (isolation confirmed)

### v0.1.86 (2026-02-14)

**Security: Fix 6 anti-patterns in Temp Market deployment**

Per-app Redis isolation, secure volume permissions, container auto-start, strict health checks, fatal SSO errors.

**Changes:**
- `manifests.ts` — Replaced shared `marketRedisManifest()` with `searxngRedisManifest()` and `wikilessRedisManifest()`, each with dedicated container names
- `definitions.ts` — SearXNG `containerNames: ['market-searxng', 'market-searxng-redis']`, Wikiless `containerNames: ['market-wikiless', 'market-wikiless-redis']`
- `redis.ts` — Complete rewrite: removed shared Redis functions, new `deployAppRedis(appId)`, `getAppRedisHost(appId)`, `getRedisManifest(appId)`
- `installer.ts` — Updated to per-app Redis functions, SSO errors now fatal (throw)
- `uninstaller.ts` — Removed shared Redis cleanup (per-app Redis deleted with containers)
- `oci-deployer.ts` — Volume mkdir 0o700 (was 0o777), added `boot.autostart: true`
- `health.ts` — `resp.status < 500` (was `resp.status > 0`)

**Testing (192.168.31.190):**
- SearXNG install → dedicated `market-searxng-redis` container created
- Wikiless install → dedicated `market-wikiless-redis` container created
- Volume permissions verified `drwx------` (0o700)
- `boot.autostart=true` verified on all new containers
- Bug found: metadata missing Redis containers → fixed in v0.1.87

### v0.1.85 (2026-02-14)

**Feature: SSO Integration for Temp Market Apps (Memos & Immich)**

Automatic Authentik OAuth2/OIDC configuration during market app installation. SSO button appears on app login pages. Full cleanup on uninstall.

**Key Changes:**
- `sso-setup.ts` — createAuthentikOAuth2App (list all providers + filter by client_id/name), removeAuthentikOAuth2App (same), configureMemosSSO (internal HTTP for tokenUrl/userInfoUrl), configureImmichSSO (internal HTTP for issuerUrl)
- `installer.ts` — Pass authentikInternalUrl to SSO config functions
- `uninstaller.ts` — Always try `youeye-market-${appId}` slug for cleanup

**Bugs Fixed:**
- Authentik search API doesn't match `client_id` → list all + filter
- Self-signed cert blocks server-to-server token exchange → use internal HTTP
- Uninstaller conditional SSO cleanup → always try standard slug

**Testing (on 192.168.31.190):**
- Install Memos with SSO: 7/7 steps pass
- SSO login: Full OAuth2 flow (redirect → auth → consent → token exchange → session)
- Uninstall: Authentik app + provider properly deleted
- Reinstall: No duplicate errors

### v0.1.81 (2026-02-13)

**Feature: Temp Market — One-Click App Marketplace**

Complete marketplace system for installing/uninstalling 6 third-party self-hosted apps. Each app deploys as OCI containers in Incus with automatic Caddy reverse proxy configuration and health checks.

**6 Supported Apps:**
- **Whoogle** — Privacy-focused Google search proxy (docker.io, port 5000)
- **SearXNG** — Privacy metasearch engine with shared Redis (docker.io, port 8080)
- **Redlib** — Reddit privacy frontend (quay.io, port 8080)
- **Wikiless** — Wikipedia privacy frontend with shared Redis (ghcr.io, port 8080)
- **Memos** — Note-taking app with shared PostgreSQL (docker.io, port 5230)
- **Immich** — Photo/video management with 4-container stack (ghcr.io, port 2283)

**New Files (18):**
- `src/lib/temp-market/definitions.ts` — App catalog (6 apps with metadata)
- `src/lib/temp-market/types.ts` — TypeScript interfaces
- `src/lib/temp-market/manifests.ts` — OCI manifest factories for all containers
- `src/lib/temp-market/installer.ts` — Install orchestrator with SSE progress
- `src/lib/temp-market/uninstaller.ts` — Uninstall (containers, routes, metadata)
- `src/lib/temp-market/status.ts` — Check installed/running status per app
- `src/lib/temp-market/health.ts` — HTTP and PostgreSQL health checks
- `src/lib/temp-market/metadata.ts` — Read/write install.json files
- `src/lib/temp-market/redis.ts` — Shared Redis lifecycle management
- `src/lib/temp-market/postgres-setup.ts` — Create/drop Memos database
- `src/lib/temp-market/searxng-config.ts` — Write SearXNG settings.yml
- `src/app/(dashboard)/temp-market/page.tsx` — Marketplace UI page
- `src/app/api/temp-market/install/route.ts` — POST SSE install stream
- `src/app/api/temp-market/uninstall/route.ts` — POST uninstall app
- `src/app/api/temp-market/status/route.ts` — GET app statuses
- `src/components/temp-market/app-card.tsx` — App card component
- `src/components/temp-market/install-dialog.tsx` — Install configuration dialog
- `src/components/temp-market/install-progress.tsx` — SSE progress display

**Modified Files:**
- `src/components/layout/sidebar.tsx` — Added Temp Market nav item
- `src/lib/apps/registry.ts` — Minor import adjustments
- `package.json` — Version 0.1.81

**Deployment Patterns Demonstrated:**
1. Simple standalone (Whoogle, Redlib) — 4 steps
2. Shared Redis dependency (SearXNG, Wikiless) — 5-6 steps
3. Shared PostgreSQL (Memos) — 5 steps
4. Multi-container with dedicated DB (Immich) — 8 steps

**Key Technical Decisions:**
- `ensureRoute()` wrapper for idempotent Caddy route creation (handles partial install retries)
- Immich PostgreSQL needs 2 GiB memory (pgvecto.rs loads ~400MB geocoding data)
- Immich server requires `IMMICH_HOST=0.0.0.0` (otherwise IPv6-only binding)
- 660s fetch timeout / 600s operation timeout for large OCI images (~1.5GB Immich ML)
- Shared Redis uses DB number isolation (SearXNG=DB0, Wikiless=DB1)
- Container naming: `market-{appId}` for single-container, `market-{appId}-{role}` for multi

**Bug fixes during development (v0.1.77→v0.1.81):**
- v0.1.78: Fixed CPU limits (`'0.5'`→`'1'` — Incus rejects fractional)
- v0.1.79: Fixed Redlib image (quay.io/redlib/redlib, added quay remote)
- v0.1.80: Fixed Immich PG OOM (512MiB→2GiB), fixed IPv6 binding (IMMICH_HOST=0.0.0.0)
- v0.1.81: Added ensureRoute() for idempotent route creation

**Testing (192.168.31.190):**
- All 6 apps: install + uninstall confirmed working
- Whoogle: Install 4/4 steps ✓, Uninstall ✓
- SearXNG: Install 6/6 steps ✓, Uninstall ✓ (shared Redis created/cleaned)
- Redlib: Install 4/4 steps ✓, Uninstall ✓
- Wikiless: Install 5/5 steps ✓, Uninstall ✓ (shared Redis reused/cleaned)
- Memos: Install 5/5 steps ✓, Uninstall ✓ (DB created/dropped in shared PG)
- Immich: Install 8/8 steps ✓, Uninstall ✓ (4 containers, ~7GB memory, 8+ min deploy)
- Health checks pass for all apps
- Caddy routes created and removed correctly
- Metadata files saved and cleaned up

---

### v0.1.76 (2026-02-12)

**Fix: Deployer continues past Authentik timeout**

The infrastructure deployer previously bailed out entirely when Authentik's health check timed out (step 3), skipping Caddy, Pi-Hole, and UI deployment. Authentik is slow to start (~3-5 min) and downstream steps don't depend on it being immediately healthy.

**Changes:**
- `src/lib/infrastructure/deployer.ts` — Removed `if (!healthy) return;` after Authentik health check. Deployment now continues through all 8 steps regardless of Authentik startup time.

**Testing:**
- Full deploy on dev server (192.168.31.190): Steps 1-8 all execute. Caddy deployed successfully even with Authentik still warming up.

---

### v0.1.75 (2026-02-12)

**Fix: Caddy config persistence across restarts**

After a VM restart, Caddy lost all routes pushed via Admin API because config was only held in memory. Implemented `--resume` flag approach which makes Caddy automatically save API-pushed config to `/config/caddy/autosave.json` and reload it on restart.

**Root Cause Analysis:**
- Caddy Admin API config is in-memory by default
- Previous attempts to write config files before container start failed (chicken-and-egg: container needed the file that needed the container to create it)
- Mounting a disk device at `/config` conflicted with Caddy's internal `XDG_CONFIG_HOME` directory

**Solution: `--resume` flag**
- Caddy's `--resume` flag auto-saves config pushed via `/load` endpoint to `/config/caddy/autosave.json`
- On restart, it loads autosave first, falling back to Caddyfile
- No external volume needed for `/config` — Caddy writes to its own container filesystem
- Eliminates ALL manual persistence code

**Changes:**
- `src/lib/infrastructure/manifests.ts` — Changed Caddy command to `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume`. Removed `/config` volume mount (kept `/data` for TLS certs only).
- `src/lib/infrastructure/deployer.ts` — Removed `initializeCaddyConfig` import and call from Step 6
- `src/lib/infrastructure/authentik-setup.ts` — Removed `initializeCaddyConfig()` function and unused imports
- `src/lib/caddy/client.ts` — Removed `persistConfigToDisk()` function, simplified `setConfig()` to just POST to Admin API

**Testing:**
- Deployed Caddy with `--resume` on dev server
- Pushed Authentik route via Admin API
- Restarted container — config persisted with both default and Authentik routes intact
- Port 80 proxy verified working from host

---

### v0.1.72 (2026-02-12)

**Feature: Unified Apps Tab with OCI Update Detection**

Complete overhaul of the Apps section. Consolidates all YouEye services (system components + OCI containers) into a single unified view with update detection, container controls, and SSE-powered update streaming.

**New Files:**
- `src/lib/apps/definitions.ts` — Single source of truth for 9 app definitions (host-system, incus, spine, control-panel, postgres, authentik, caddy, pihole, ui)
- `src/lib/apps/update-cache.ts` — Background 3-hour periodic update checking with in-memory cache
- `src/lib/apps/updater.ts` — OCI container rebuild via Incus API with snapshot-based rollback
- `src/app/api/apps/unified/route.ts` — GET /api/apps/unified combines definitions + Incus status + Spine status + digest cache
- `src/app/api/apps/[name]/update/route.ts` — POST SSE stream for app updates (OCI or Spine)
- `src/app/api/apps/[name]/check-update/route.ts` — POST per-app digest check
- `src/app/api/apps/check-updates/route.ts` — POST bulk check all OCI apps
- `src/app/(dashboard)/apps/[id]/page.tsx` — App detail page with container controls, update streaming, management links
- `src/app/(dashboard)/apps-legacy/page.tsx` — Copy of old apps page

**Modified Files:**
- `src/app/(dashboard)/apps/page.tsx` — Rewritten: unified list view with "Updates Available" section
- `src/lib/apps/registry.ts` — Rewritten: added digest checking functions (fetchRemoteDigest, checkAppUpdate, etc.)
- `src/lib/spine/client.ts` — Added getRegistryDigest method
- `src/components/layout/sidebar.tsx` — Removed "Updates" nav item, added "Apps (Legacy)"

**Architecture:**
- CP container now has internet access (firewall removed). Digest checks still go through Spine's `/api/registry/digest` endpoint for consistency
- OCI updates: CP creates snapshots → stops containers → rebuilds via Incus → starts → verifies → rollback on failure
- Spine-managed updates: proxied to Spine API (update self, control, incus, system, ui)

**Bug Fix (v0.1.71 → v0.1.72):**
- Fixed Next.js routing conflict: `[id]` vs `[name]` dynamic segments at `/api/apps/` level
- Moved new API routes from `[id]` to `[name]` to match existing convention

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.72
- Clean startup, no routing errors
- Spine registry digest endpoint verified for Docker Hub, GHCR images

---

### v0.1.70 (2026-02-12)

**Fix: UI SSO Environment Variables Not Loaded**

After running the setup wizard, the UI showed "SSO is not configured" because the LXD deployer's systemd service template did not include `EnvironmentFile` directive. The env file existed (written by Spine) but the service never loaded it.

**Root Cause:**
- `lxd-deployer.ts` created the UI systemd service without `EnvironmentFile=-/etc/youeye-ui.env`
- Spine's `handleUISSO` wrote the env file but only called `systemctl start` (no-op if already running)
- Result: UI process ran without AUTHENTIK_URL, AUTHENTIK_CLIENT_SECRET, etc.

**Changes:**
- `src/lib/infrastructure/lxd-deployer.ts` — Added `EnvironmentFile=-/etc/${spec.containerName}.env` to service template

**Testing:**
- Verified on dev server (192.168.31.190): UI login page shows `ssoConfigured: true` and "Sign in with Authentik" button
- All services healthy: UI 307, CP 307, Authentik 302

---

### v0.1.69 (2026-02-12)

**Fix: Authentik HTTP 400 Error via Caddy**

Caddy proxy returned HTTP 400 when accessing Authentik because the setup wizard configured the upstream port as 9443 (HTTPS) while Caddy sends plain HTTP.

**Changes:**
- `src/app/api/setup/run/route.ts` — Changed Authentik route port from 9443 to 9000

**Testing:**
- Verified on dev server: Authentik returns 302 via Caddy proxy

---

### v0.1.68 (2026-02-12)

**Feature: Infrastructure Deployment Moved from Spine to Control Panel**

All infrastructure app deployment logic previously in Spine (Go) has been moved to the Control Panel (TypeScript). Spine now only: (1) installs Incus, (2) starts its API, (3) deploys the CP container, (4) calls the CP's SSE endpoint to deploy everything else.

**Architecture:**
- SSE endpoint at `/api/deploy/infrastructure` deploys 8 steps: PostgreSQL, Authentik DB setup, Authentik server, Authentik worker, API token, Caddy, Pi-Hole, YouEye UI
- OCI containers deployed via Incus REST API (Unix socket)
- LXD containers (YouEye UI) deployed as Debian + Node.js with systemd service
- Secrets stored in `/var/lib/youeye/` per-service with auto-generation
- Keepalive SSE comments every 10s prevent idle timeout during long operations

**New Files (10):**
- `src/lib/infrastructure/types.ts` — OCIManifest, LXDContainerSpec, DeploymentEvent types
- `src/lib/infrastructure/manifests.ts` — All 7 app manifests (postgres, authentik, caddy, pihole, ui)
- `src/lib/infrastructure/secrets.ts` — Secret generation and persistence
- `src/lib/infrastructure/oci-deployer.ts` — OCI container lifecycle via Incus API
- `src/lib/infrastructure/lxd-deployer.ts` — LXD container deploy with Node.js + systemd
- `src/lib/infrastructure/health-checks.ts` — Service health checks (postgres, authentik, caddy, pihole)
- `src/lib/infrastructure/postgres-setup.ts` — Authentik database/user creation via psql
- `src/lib/infrastructure/authentik-setup.ts` — API token creation, Caddy route setup
- `src/lib/infrastructure/deployer.ts` — Main orchestrator (8-step sequential deployment)
- `src/app/api/deploy/infrastructure/route.ts` — SSE endpoint with auth and keepalive

**Modified Files:**
- `src/lib/incus/server.ts` — Added `execCommand`/`execShell` with chunked `/wait?timeout=30` polling, `incusRawGet` for log files
- `src/middleware.ts` — Added `/api/deploy/infrastructure` to API routes

**Key Bugs Fixed:**
- SSE idle timeout: Added keepalive comments every 10s
- Port 3000 conflict: Made port proxy errors non-fatal (UI port 3000 vs CP port 3000)
- Missing systemd service: LXD deployer now creates and starts `.service` file
- Socket timeout in execCommand: Changed from bare `/wait` to chunked `/wait?timeout=30` with retry
- npm install styled-jsx: Replaced with direct curl from npm registry (avoids 3min+ pnpm node_modules scanning)
- Service file creation: Uses base64 encode/decode instead of heredoc for reliability over exec API

**Testing:**
- 5 iterative deploy cycles on dev server (192.168.31.190)
- All 7 containers deploy and run: postgres, authentik (server+worker), caddy, pihole, control, ui
- CP returns 200, Authentik healthy, Pi-Hole DNS resolving, UI service active
- `spine deploy` exits 0 with full SSE stream

---

### v0.1.62 (2026-02-11)

**Feature: Auto Pi-Hole DNS Rewrite on Domain Change**

When a user configures a domain name (via setup wizard or proxy page), Pi-Hole automatically gets a wildcard DNS entry so `domain.com` and `*.domain.com` resolve to the server's LAN IP.

**How it works:**
- Uses Pi-Hole FTL v6 `misc.dnsmasq_lines` config API
- Single `address=/domain.com/IP` directive handles base domain + all subdomains
- Old domain entries are automatically cleaned up on domain change
- Runs silently — no UI changes needed, errors are non-critical

**Changes:**
- `src/lib/apps/pihole-api.ts` — Added `getDnsmasqLines()`, `setDnsmasqLines()`, `setDomainDNS()`, `removeDomainDNS()` functions
- `src/app/api/setup/run/route.ts` — Added DNS step after Caddy routes in setup wizard
- `src/app/api/domain/route.ts` — Added Pi-Hole DNS rewrite + Spine config sync on domain POST

**Bug Fix:**
- Proxy page domain POST was not syncing to Spine config. Added `spineClient.patchConfig({ domain })` call.

**Testing:**
- Deployed to dev server (192.168.31.190) as v0.1.62
- Set domain to `mytest.local` → Pi-Hole entry added, DNS resolves correctly
- Changed to `newdomain.example` → old entry removed, new entry added
- Wildcard works: `app.newdomain.example` resolves to `192.168.31.190`
- Old domain `mytest.local` returns NXDOMAIN after change
- Spine config synced correctly

---

### v0.1.60 (2026-02-10)

**Feature: Setup Wizard + White-Labeling**

Initial setup wizard for first-time configuration, plus white-labeling support using dynamic `site_name` from Spine config.

**Setup Wizard:**
- `src/app/setup/layout.tsx` — Minimal centered layout (no sidebar)
- `src/app/setup/page.tsx` — 3-step client wizard: server config, admin account, SSE installation progress
- `src/app/api/setup/config/route.ts` — Public GET for config check, admin PUT for updates
- `src/app/api/setup/run/route.ts` — Full SSE-streamed setup: save config, create Caddy routes, create admin user, configure SSO for CP + UI, write site_name to UI DB, mark setup complete
- `src/lib/spine/client.ts` — Added `getConfig()`, `setConfig()`, `patchConfig()` methods
- `src/middleware.ts` — Added `/api/setup/config` to PUBLIC_ROUTES

**White-Labeling:**
- `src/lib/site-config.ts` — Server-side `getSiteConfig()` reads from Spine
- `src/hooks/use-site-config.ts` — Client-side `useSiteConfig()` hook
- `src/app/layout.tsx` — Dynamic `generateMetadata()` using site_name
- `src/app/login/page.tsx` — Login heading uses site_name
- `src/app/(dashboard)/settings/page.tsx` — UI section uses site_name

**Bug Fix:**
- GET `/api/setup/config` was returning 401 because the route handler had its own `getSession()` check. Removed session check from GET (public endpoint for setup-check). PUT still requires admin auth.

**Testing:**
- Deployed to dev server (192.168.31.190)
- `/api/setup/config` returns 200 with config (verified public access)
- Login page renders with dynamic title ("YouEye Control Panel")
- Setup page requires authentication (redirects to login)

---

### v0.1.59 (2026-02-10)

**Fix: Spine client timeout race**

Increased Spine Unix socket client timeout from 30s to 60s. The old timeout raced with Spine's health check loop (30s max), causing "Request timeout" when enabling UI.

**Changes:**
- `src/lib/spine/client.ts` — `req.setTimeout(60000)` (was 30000)

**Testing:**
- Deployed to dev server, full deploy passes, 7 containers running

---

### v0.1.56 (2026-02-09)

**Feature: YouEye UI Management (Phase 2)**

Automated UI container lifecycle management from the Settings page.

**Changes:**
- Settings page: Added YouEye UI section (visible when SSO configured + UI installed)
  - Domain input with auto-suggestion (ui.{domain})
  - Enable UI button: creates Authentik OAuth2, Caddy route, DB, starts service
  - Disable UI button: removes Authentik resources, Caddy route, stops service
  - Live status indicator (not-installed/installed/running)
- New API route: `/api/ui` (GET status, POST enable, DELETE disable)
- New library: `src/lib/ui/manager.ts` — full UI lifecycle management
- Spine client: added getUISSO(), setUISSO(), deleteUISSO(), updateUI() methods
- SpineStatusResponse: added `ui` field with status/installed/enabled/version/ip

**Testing:**
- Deployed to dev VM (192.168.31.190)
- Spine API returns correct UI status (installed, enabled, version, IP)
- CP Settings page bundle includes full UI management code
- API route `/api/ui` responds correctly

### v0.1.55 (2026-02-09)

**Fix: SSO Callback Redirect — All Redirects Now Use CONTROL_EXTERNAL_URL**

**Problem:**
After SSO login with Authentik, the browser was redirected to `http://0.0.0.0:3000/` instead of `https://control.skibidi.wtf/`. The v0.1.54 fix only applied `CONTROL_EXTERNAL_URL` to the OAuth2 token exchange `redirect_uri`, but the `NextResponse.redirect()` calls for navigation (success → `/`, errors → `/login?error=...`) still used `request.url` as the base URL. Inside the container, `request.url` resolves to `http://0.0.0.0:3000/...`.

**Root Cause:**
`NextResponse.redirect(new URL('/', request.url))` uses `request.url` which is `http://0.0.0.0:3000/api/auth/callback?code=...` inside the container.

**Solution:**
Compute `baseUrl` once at the top of the GET handler from `CONTROL_EXTERNAL_URL` (with forwarded-header fallback), then use it for ALL redirects — not just the token exchange redirect_uri.

**Deployment Note:**
Previous deployment used `rm -rf /opt/app/*` which doesn't remove dotfiles (`.next` directory). The old `.next` survived, causing stale compiled chunks to be served. Fixed by using `rm -rf /opt/app && mkdir -p /opt/app` to fully remove the directory including dotfiles.

**Modified Files:**
- `src/app/api/auth/callback/route.ts` — Moved `baseUrl` computation above all early returns, all `NextResponse.redirect(new URL(..., request.url))` changed to `new URL(..., baseUrl)`
- `package.json` — Version 0.1.55

**Testing (192.168.31.190):**
- `curl -sI http://10.117.96.245:3000/api/auth/callback` → `location: https://control.skibidi.wtf/login?error=Missing+code+or+state` (was `http://0.0.0.0:3000/...`)
- `spine status` → Control Panel: Running (v0.1.55)
- Process env verified: `CONTROL_EXTERNAL_URL=https://control.skibidi.wtf` present in node process

---

### v0.1.54 (2026-02-09)

**Fix: SSO Redirect URL & Authentik 2025.12 Compatibility**

**Summary:**
Fixed SSO redirect_uri going to `0.0.0.0:3000` instead of the proper subdomain. Added `CONTROL_EXTERNAL_URL` env var for explicit redirect URI control. Updated SSO setup to pass `control_url` to Spine for env injection.

**Problem:**
When the Control Panel runs inside an Incus container with `listen: 0.0.0.0:3000`, the `request.headers.get('host')` returns `0.0.0.0:3000` instead of the actual subdomain. This caused OAuth2 redirect_uri to be set incorrectly, breaking SSO login flow.

**Solution:**
Use `process.env.CONTROL_EXTERNAL_URL` (injected by Spine via systemd EnvironmentFile) as the authoritative source for the redirect URI. Falls back to request headers if env var not set.

**Modified Files:**
- `src/app/api/auth/sso/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI, fixed `secure` cookie flag to use `redirectUri.startsWith('https://')` instead of out-of-scope `proto` variable
- `src/app/api/auth/callback/route.ts` - Use `CONTROL_EXTERNAL_URL` for redirect URI
- `src/lib/auth/sso-setup.ts` - Pass `control_url: params.controlExternalUrl` to `spineClient.setControlSSO()`
- `src/lib/spine/client.ts` - Added `control_url: string` to `setControlSSO` params type
- `package.json` - Version 0.1.54

**Testing (192.168.31.190):**
- SSO setup successful with Authentik 2025.12
- Redirect URI: `https://control.youeye.local/api/auth/callback` (not `0.0.0.0:3000`)
- `CONTROL_EXTERNAL_URL=https://control.youeye.local` correctly in SSO env file
- Auth mode correctly reports `ssoConfigured: true`

---

### v0.1.53 (2026-02-08)

**Feature: Self-Service SSO Setup via Settings Page**

**Summary:**
Complete SSO implementation allowing the Control Panel to configure its own Authentik SSO through a new Settings page UI. When accessed via IP address, login uses PAM. When accessed via subdomain, login uses Authentik SSO (no PAM option).

**How it works:**
1. Settings page checks prerequisites (domain configured, Authentik + CP subdomains in Caddy, Authentik healthy)
2. "Setup SSO" button creates OAuth2 Provider + Application in Authentik via API
3. Creates groups scope mapping for admin detection via OIDC
4. Spine stores env vars (`AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_INTERNAL_URL`) via systemd drop-in
5. CP restarts with SSO env vars loaded
6. Auth mode detection: PAM on IP access, SSO on subdomain access

**Key Design Decisions:**
- Uses Authentik 2024.12 API paths (`/propertymappings/provider/scope/`, dict-format `redirect_uris`)
- `AUTHENTIK_INTERNAL_URL` (Incus DNS `http://youeye-authentik.incus:9000`) for server-side token exchange to avoid self-signed TLS issues
- `AUTHENTIK_URL` (external URL like `https://id.skibidi.wtf`) for browser redirects
- Systemd EnvironmentFile drop-in (`sso.conf`) for clean env injection that survives CP updates

**New Files:**
- `src/lib/auth/sso-setup.ts` - Core SSO setup/teardown logic (Authentik API calls)
- `src/app/api/auth/sso/status/route.ts` - GET endpoint: SSO prerequisites and configuration status
- `src/app/api/auth/sso/setup/route.ts` - POST endpoint: Execute SSO setup
- `src/app/api/auth/sso/disable/route.ts` - POST endpoint: Disable SSO
- `src/app/(dashboard)/settings/page.tsx` - Settings page with SSO prerequisites checklist and setup/disable buttons

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added Settings nav item
- `src/lib/spine/client.ts` - Added `getControlSSO()`, `setControlSSO()`, `deleteControlSSO()` methods
- `src/lib/auth/authentik.ts` - Added `AUTHENTIK_INTERNAL_URL` for server-side calls, `groups` scope
- `src/middleware.ts` - Block PAM login on subdomain access (403), exact-match SSO public route

**Testing (192.168.31.190):**
- SSO prerequisites all met (domain, subdomains, Authentik health)
- Setup creates OAuth2 provider/app in Authentik, configures env vars
- Auth mode: `pam` on IP, `sso` on subdomain
- SSO redirect to `https://id.skibidi.wtf/application/o/authorize/` with correct params
- PAM login blocked on subdomain with 403 error
- Disable/re-enable cycle works
- Version 0.1.53 deployed and verified

---

### v0.1.51 (2026-02-08)

**Bug Fixes: Updates Page Crash, LAN Port Untick, People Create 500**

**Summary:**
Three bugs found during manual testing on user's test server, plus a backend fix discovered during verification:

1. **Bug 1 - Updates page crash**: `Cannot read properties of undefined (reading 'split')`. The TypeScript `AppInfo` interface used `container` and `image` fields, but Spine API returns `container_name` and `image_tag`. The line `app.image.split(':').pop()` crashed on undefined.
2. **Bug 2 - LAN port checkbox snap-back**: After enabling LAN port, unticking the checkbox and pressing save would visually revert to ticked. The checkbox was controlled by `state.lanEnabled` which only updated after API response, not optimistically.
3. **Bug 2b - LAN port device not removed**: Even with the frontend fix, the Incus PATCH method merges device maps and cannot delete keys. Changed to PUT with full config to properly remove the `lan-web` device.
4. **Bug 3 - People API 500 on create**: `createUser()` succeeded but `setUserPassword()` failed (Authentik password policy), causing 500 that masked successful user creation.

**Modified Files:**
- `src/lib/spine/client.ts` - Fixed `SpineUpdatesCheckResponse.apps` type: `container`→`container_name`, `image`→`image_tag`, added `available: boolean`
- `src/app/(dashboard)/updates/page.tsx` - Fixed `AppInfo` interface, replaced crash-prone `app.image.split(':').pop()` with safe `app.image_tag || 'latest'`
- `src/components/proxy/container-routing-table.tsx` - Optimistic `lanEnabled` state update on checkbox click, revert on API failure
- `src/app/api/containers/[name]/lan-port/route.ts` - Changed PATCH to PUT with full instance config (architecture, config, devices, profiles) so device removal actually works
- `src/app/api/people/route.ts` - Wrapped `setUserPassword()` in separate try/catch, returns `{ success: true, passwordWarning }` instead of 500

**Testing (192.168.31.190):**
- Updates page: returns 200, API returns correct `container_name`/`image_tag` fields
- LAN port: enable (port 8888) adds `lan-web` device, disable removes it completely
- People create: returns `{ success: true, passwordWarning }` instead of 500
- No errors in control panel logs after deployment
- v0.1.51 deployed and verified

---

### v0.1.49 (2026-02-08)

**Multi-Feature: People Tab, Proxy Simplification, Updates Apps, SSO Dual-Auth**

**Summary:**
Four major features implemented in a single release:
1. **CP1 - People Management Tab**: Full user CRUD via Authentik API. List/create/delete users, toggle admin (via "authentik Admins" group), set passwords, show/hide hidden system users.
2. **CP2 - Proxy Simplification**: Rewrote routing table to subdomain-only (removed path routing). Added LAN Port column with checkbox + port input to expose containers directly on host.
3. **CP3 - Updates Page Apps**: Extended updates page with Incus version, system packages count, and app container cards with rebuild button.
4. **CP4 - SSO Dual-Auth**: OAuth2 login via Authentik when accessed through subdomain. IP-based access uses PAM. Auto-detects mode at login.

**New Files:**
- `src/app/(dashboard)/people/page.tsx` - People management page with user table, create form, password dialog
- `src/app/api/people/route.ts` - GET (list users) and POST (create user) with admin group detection
- `src/app/api/people/[id]/route.ts` - PATCH (update user, toggle admin) and DELETE
- `src/app/api/people/[id]/password/route.ts` - POST to set user password
- `src/app/api/containers/[name]/lan-port/route.ts` - POST to add/remove Incus proxy device for LAN port
- `src/lib/auth/authentik.ts` - OAuth2 helper (buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo, isSSOConfigured)
- `src/app/api/auth/sso/route.ts` - GET: initiates OAuth2 flow, redirects to Authentik
- `src/app/api/auth/callback/route.ts` - GET: OAuth2 callback, exchanges code, creates JWT session
- `src/app/api/auth/mode/route.ts` - GET: returns 'pam' or 'sso' based on Host header

**Modified Files:**
- `src/components/layout/sidebar.tsx` - Added People nav item between DNS and Updates
- `src/components/proxy/container-routing-table.tsx` - Complete rewrite: subdomain-only + LAN port column
- `src/app/(dashboard)/proxy/page.tsx` - Updated description text
- `src/app/api/containers/route.ts` - Added lanPort field with getLanPort() helper
- `src/lib/spine/client.ts` - Extended SpineUpdatesCheckResponse with incus/system/apps, added updateApp()
- `src/app/(dashboard)/updates/page.tsx` - Complete rewrite: Incus/System/App cards, rebuild button
- `src/app/api/updates/[component]/route.ts` - Unknown components now route to updateApp()
- `src/middleware.ts` - Added SSO/callback/mode to PUBLIC_ROUTES
- `src/app/login/page.tsx` - Split into Suspense wrapper + LoginContent, auth mode detection, SSO redirect

**Bug Fix (v0.1.49):**
- LAN port API now checks Incus response for errors (previously returned success even on failure)

**Testing (192.168.31.190):**
- Spine v0.1.27 + CP v0.1.49 deployed, all 7 containers running
- Auth mode API: returns `pam` for IP access, `sso` when configured
- People API: lists Authentik users with admin group detection
- LAN port: successfully adds/removes Incus proxy devices (tested on Pi-Hole port 9999)
- Updates API: returns incus v6.21, system 70 packages, 5 app containers
- Login page loads correctly (200)
- All pages accessible: /updates, /people, /proxy (200)

---

### v0.1.47 (2026-02-08)

**Authentik in Reverse Proxy Routing Table**

**Summary:**
Set `webPort: 9000` in Authentik manifest so it appears in the reverse proxy routing table on the proxy page. Also includes Authentik management page scaffolding (users, groups, stats API routes).

**Code Changes:**
- `src/lib/apps/manifest.ts` - Changed Authentik `webPort: undefined` to `webPort: 9000`
- `src/app/(dashboard)/apps/authentik/page.tsx` - NEW: Authentik management page
- `src/app/api/apps/authentik/stats/route.ts` - NEW: Authentik stats API
- `src/app/api/apps/authentik/users/route.ts` - NEW: Users API
- `src/app/api/apps/authentik/groups/route.ts` - NEW: Groups API
- `src/lib/authentik/client.ts` - NEW: Authentik API client library

**Testing (192.168.31.190):**
- CP v0.1.47 deployed, `spine update control` successful
- Containers API returns Authentik with `webPort: 9000` and `status: running`
- Three containers in proxy routing table: Control Panel (3000), Pi-Hole (80), Authentik (9000)

---

### v0.1.45 (2026-02-08)

**Security: Fetch Pi-Hole Password from Spine API**

**Summary:**
Removed hardcoded `DEFAULT_PIHOLE_PASSWORD` constant. Pi-Hole password is now fetched from Spine's `/api/pihole/credentials` API endpoint. Password changes are synced back to the host file via Spine API.

**Code Changes:**
- `src/lib/spine/client.ts` - Added `SpinePiholeCredentials` interface, `getPiholeCredentials()` (GET), `updatePiholePassword(password)` (POST)
- `src/lib/apps/secrets.ts` - Removed `DEFAULT_PIHOLE_PASSWORD = 'youeye_admin'`; `getPiholePassword()` now fetches from Spine API with systemd env fallback; `setPiholePassword()` syncs to host file via Spine API; `initializePiholePassword()` fetches from Spine if no explicit password; `hasCustomPiholePassword()` checks for empty string instead of comparing to hardcoded default

**Testing (192.168.31.190):**
- CP v0.1.45 deployed and healthy
- Spine Pi-Hole credentials API returns password
- Health check passes

---

### v0.1.44 (2026-02-09)

**PostgreSQL Management UI & SQL Console**

**Summary:**
Added full PostgreSQL management page with 4 tabs (Overview, Databases, SQL Console, Connection Info). Queries PostgreSQL via `incus exec` + psql (no npm pg dependency needed). Includes read-only SQL console for safe query execution.

**Code Changes:**
- `src/lib/postgres/client.ts` - NEW: PostgreSQL client using execShell + psql --csv. Functions: psqlQuery(), parseCSVLine(), queryReadOnly() (wraps in READ ONLY transaction), listDatabases(), getStats()
- `src/lib/incus/server.ts` - Added `incusRawGet()` for fetching exec log file content. Fixed `execCommand()` to fetch stdout/stderr from Incus log file paths instead of returning paths as content.
- `src/lib/apps/manifest.ts` - Added POSTGRES_MANIFEST (postgres:17-alpine)
- `src/lib/spine/client.ts` - Added getPostgresCredentials()
- `src/app/api/apps/postgres/stats/route.ts` - NEW: GET endpoint returning version, uptime, connections, database sizes
- `src/app/api/apps/postgres/databases/route.ts` - NEW: GET endpoint returning database list with owner, encoding, size
- `src/app/api/apps/postgres/query/route.ts` - NEW: POST endpoint for read-only SQL execution with CSRF protection
- `src/app/(dashboard)/apps/postgres/page.tsx` - NEW: 4-tab management page (Overview, Databases, SQL Console, Connection Info)
- `src/app/(dashboard)/apps/page.tsx` - Added PostgreSQL card with database icon and Manage link

**Key Decisions:**
- Used execShell + psql instead of `pg` npm package (Turbopack bundling breaks pg module resolution)
- Added incusRawGet for raw HTTP requests to Incus log endpoints (exec output stored in files, not returned inline)
- Filtered psql command tags (BEGIN, COMMIT, SET) from CSV output to prevent parser confusion
- Connected as `-U youeye` role (not default `postgres` role, since POSTGRES_USER=youeye)

**Bug Fixes (iterations v0.1.38 → v0.1.44):**
- v0.1.38: Initial implementation with `pg` npm package
- v0.1.39: Added serverExternalPackages for pg (didn't fix Turbopack issue)
- v0.1.40: Rewrote to use execShell + psql (removed pg dependency entirely)
- v0.1.41: Fixed execCommand returning log file paths instead of content (added incusRawGet)
- v0.1.42: Fixed psql connecting as wrong role (added `-U youeye`)
- v0.1.43: Fixed uptime query single-quote escaping
- v0.1.44: Filtered psql command tags from CSV output

**Testing (192.168.31.190):**
- 33/33 Playwright e2e tests passing (9 new PostgreSQL tests)
- Stats endpoint: version, uptime, connections, database sizes
- Databases endpoint: youeye + postgres databases with correct owner/encoding
- SQL Console: SELECT queries execute correctly with proper column/row parsing
- Write protection: CREATE TABLE rejected in READ ONLY transaction
- All existing Caddy/Pi-Hole/auth tests still passing

---

### v0.1.37 (2026-02-08)

**Remove install infrastructure, simplify to Spine-deployed apps**

**Summary:**
Removed all container install/deploy functionality from the Control Panel. Apps (Caddy, Pi-Hole, Postgres, Redis, Authentik) are now deployed exclusively by Spine. CP only manages already-deployed containers. Removed ~3000 lines of install code. Container firewall was later removed to allow internet access.

**Code Changes:**
- Deleted: `src/app/api/apps/install/route.ts` (315 lines) - Install API
- Deleted: `src/app/api/test/install-app/route.ts` (405 lines) - Test install API
- Deleted: `src/app/(dashboard)/apps/postgres/page.tsx` (647 lines) - Postgres management UI
- Deleted: `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik page
- Deleted: `src/app/api/apps/postgres/*` (databases, stats, users routes)
- Deleted: `src/app/api/apps/authentik/stats/route.ts`
- `src/lib/apps/manifest.ts` - Simplified from 362 to 53 lines. Only Caddy + Pi-Hole manifests. Removed OCI config generation, parseOCIImage, manifestToIncusConfig.
- `src/lib/apps/registry.ts` - Removed getRegistry, getAppInstance, isBuiltInApp, fetchRemoteRegistry
- `src/types/apps.ts` - Removed 'installing' status, PortMapping, HealthCheck, AppRegistry, InstallAppRequest
- `src/app/(dashboard)/apps/page.tsx` - Rewritten: simple 2-column card grid, no install buttons, Manage links
- `src/app/(dashboard)/proxy/page.tsx` - Removed installCaddy, shows "spine deploy" message when not deployed
- `src/app/(dashboard)/dns/page.tsx` - Removed installPihole, shows "spine deploy" message when not deployed
- `src/middleware.ts` - Removed /api/test/install-app from PUBLIC_ROUTES
- `src/components/proxy/proxy-status-card.tsx` - Removed manifest.version reference
- Removed `@playwright/test` from devDependencies (was added in error)

**Testing (192.168.31.190):**
- 24/24 Playwright e2e tests passing (standalone test suite in YouEye-Agents)
- Verified no install buttons on apps/proxy/dns pages
- Verified no postgres/authentik/redis cards on apps page
- Verified API returns exactly 2 apps (Caddy + Pi-Hole)
- Verified removed API routes return 401/404
- Container has internet access (firewall was later removed)

---

### v0.1.36 (2026-02-07)

**Fix: Pi-Hole password change, auth race condition, wildcard TLS, HTTP redirect**

**Summary:**
Fixed three Pi-Hole bugs and two Caddy HTTPS issues. Password change returned 400 due to field name mismatch. Multiple simultaneous API calls caused 429 rate-limit errors from Pi-Hole FTL. Caddy accumulated redundant per-subdomain TLS certs instead of using wildcard. HTTP did not redirect to HTTPS.

**Root Causes:**
1. `dns/page.tsx` sent `{ password: newPassword }` but backend expected `{ newPassword }`
2. `pihole-api.ts` `getSession()` had no lock - parallel requests all called `authenticate()` simultaneously, triggering Pi-Hole FTL 429 rate-limit
3. `caddy/client.ts` `ensureTLSSubject()` added individual subdomain certs even when `*.domain` wildcard existed
4. `caddy/client.ts` `ensureHTTPSConfig()` added `:80` to server listen array, causing routes to be served on both ports instead of redirecting

**Code Changes:**
- `src/app/(dashboard)/dns/page.tsx` - Fixed field name: `{ password: newPassword }` → `{ newPassword }`
- `src/lib/apps/pihole-api.ts` - Added Promise-based mutex lock to `getSession()` so only first request authenticates, others wait
- `src/lib/caddy/client.ts` - `ensureTLSSubject()`: skip adding subdomain if covered by wildcard
- `src/lib/caddy/client.ts` - `setDomain()`: clean up stale per-subdomain subjects, keep only `domain` + `*.domain`
- `src/lib/caddy/client.ts` - `ensureHTTPSConfig()`: remove `:80` from listen array, let Caddy auto-create redirect server
- `src/lib/caddy/client.ts` - Initial server creation: only listen on `:443`

**Testing (192.168.31.190):**
- Password change: 200 OK (was 400)
- 4 parallel Pi-Hole API calls: all succeeded, no 429 errors (was getting 429)
- TLS subjects cleaned to only `skibidi.wtf` + `*.skibidi.wtf` (was accumulating stale per-subdomain certs)
- Wildcard skip log: `Skipping TLS subject pihole.skibidi.wtf - covered by wildcard *.skibidi.wtf`
- HTTP redirect: 308 Permanent Redirect to HTTPS (was serving routes on port 80)
- HTTPS access: 302 from Pi-Hole (working)
- Server listeners: only `:443` (was `:443` + `:80`)

**IMPORTANT - TLS is self-signed:**
Caddy uses `module: internal` (self-signed via Caddy's internal CA), NOT Let's Encrypt. This is for local LAN only.

---

### v0.1.35 (2026-02-05)

**Fix: Pi-Hole FTL v6 API Authentication**

**Summary:** 
Fixed Pi-Hole integration to use SID URL parameter instead of Cookie header.

**Root Cause:**
Pi-Hole FTL v6+ requires the session ID (`sid`) to be passed as a URL query parameter (`?sid=xxx`), NOT as a Cookie header (`Cookie: sid=xxx`). The previous implementation used Cookie authentication which returned "Unauthorized" errors.

**Code Changes:**
- `src/lib/apps/pihole-api.ts`: NEW FILE - Complete Pi-Hole FTL v6 API client with session management
- Changed `piholeRequest()` to append `?sid=xxx` to URL instead of using Cookie header
- Updated all Pi-Hole route handlers to use new `pihole-api.ts` library

**Endpoints Updated:**
- `/api/apps/pihole/stats` - Uses `getStats()`
- `/api/apps/pihole/queries` - Uses `getQueryLog()`
- `/api/apps/pihole/dns-records` - Uses `getDNSRecords()`, `addDNSRecord()`, `removeDNSRecord()`
- `/api/apps/pihole/cname-records` - Uses `getCNAMERecords()`, `addCNAMERecord()`, `removeCNAMERecord()`
- `/api/apps/pihole/domains` - Uses `getDomainLists()`, `addDomain()`, `removeDomain()`
- `/api/apps/pihole/control` - Uses `setBlocking()`
- `/api/apps/pihole/password` - Added `clearPiholeSession()` call

**Testing:**
- Tested from dev server (192.168.31.190)
- Auth: `POST /api/auth` returns valid session with SID
- Stats with ?sid= parameter returns full summary data
- Cookie authentication confirmed NOT working (returns unauthorized)

---

### v0.1.32 (2026-02-05)

**Bug Fixes: Volume Permissions, Pi-Hole Web Server, Test API Middleware**

**Summary:** 
- Fixed Caddy volume permission issues with `shift: true`
- Fixed Pi-Hole FTL v6+ web server with `FTLCONF_webserver_port`
- Added test endpoint to PUBLIC_ROUTES to bypass JWT auth

**Root Causes:**
1. **Caddy Permission Denied:** Incus UID mapping caused `/data` to be owned by `nobody:nobody` inside container.
   Volume devices need `shift: 'true'` to enable Incus ID shifting.
2. **Pi-Hole Web Interface Down:** FTL v6+ has built-in web server but requires explicit `FTLCONF_webserver_port` env var.
3. **Test API Unauthorized:** Middleware required JWT for all routes - test endpoint uses X-Test-Secret header instead.

**Code Changes:**
- `src/lib/apps/manifest.ts`: Added `shift: 'true'` to disk device config in `manifestToIncusConfig()`
- `src/lib/apps/manifest.ts`: Added `FTLCONF_webserver_port: '80'` to Pi-Hole environment
- `src/middleware.ts`: Added `/api/test/install-app` to PUBLIC_ROUTES

**Testing:**
- Verified Caddy `/data/caddy` owned by `root:root` (not `nobody:nobody`)
- Verified Pi-Hole web interface responds on port 8080 (HTTP 302)
- Test API returns app list successfully

---

### v0.1.31 (2026-02-05)

**Feature: Test Install API Endpoint**

**Summary:** Added `/api/test/install-app` endpoint for automated app installation testing.

**Purpose:**
Provides a secure way for Iris (AI agent) to install/uninstall apps for testing without browser login.

**Security:**
- Requires `TEST_ADMIN_SECRET` environment variable (generated by Spine)
- Validates `X-Test-Secret` header against env var
- Rate limited (5 seconds between requests)
- Logged for audit trail

**API:**
```
GET /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Returns: List of available apps with status

POST /api/test/install-app
  Headers: X-Test-Secret: <secret>
  Body: { "appName": "pihole", "action": "install" | "uninstall" }
  Returns: Success/failure status
```

**Code Changes:**
- `src/app/api/test/install-app/route.ts`: NEW FILE - Secure test endpoint

---

### v0.1.30 (2026-02-05)

**Bug Fix: Pi-Hole Password Change Using Incus REST API**

**Summary:** Rewrote Pi-Hole password change to use Incus REST API instead of shell commands.

**Root Cause:**
The `setPiholePassword()` function in `secrets.ts` was using `exec('incus config set ...')` to store the password.
This fails inside the Control Panel container because there is no `incus` binary installed - the container 
only has access to the Incus Unix socket, not the CLI tools.

**Solution:**
Changed `setPiholePassword()` to use `incusRequest()` to call the Incus REST API via Unix socket:
- Uses `PATCH /1.0/instances/youeye-pihole` to update container config.user.password
- Uses `updateInstanceState()` to restart the container after password change
- Changed `execInControl` to `execLocal` for local command execution

**Code Changes:**
- `src/lib/apps/secrets.ts`:
  - Added imports: `incusRequest`, `updateInstanceState` from `@/lib/incus/server`
  - Rewrote `setPiholePassword()` to use Incus REST API
  - Changed `execInControl` to `execLocal` for retrieving Incus configuration

**Testing:**
- Fresh `spine deploy` on YouEye-Dev-VM (192.168.31.190)
- Spine v0.1.15 + Control Panel v0.1.30 running
- CSRF endpoint accessible
- Login page loads correctly

---

### v0.1.29 (2026-02-05)

**Bug Fix: CSRF Endpoint Blocked by Middleware**

**Summary:** Added `/api/auth/csrf` to PUBLIC_ROUTES so it can be accessed without authentication.

**Root Cause:**
The CSRF endpoint was returning 401 Unauthorized because middleware blocked unauthenticated access.

**Fix:**
Added `/api/auth/csrf` to PUBLIC_ROUTES array in middleware.ts.

**Code Changes:**
- `src/middleware.ts` - Added `/api/auth/csrf` to PUBLIC_ROUTES

**Testing:**
- CSRF endpoint returns 200 with `{"csrfToken":null}` when no cookie present
- Accessible both internally and externally

---

### v0.1.28 (2026-02-05)

**Bug Fixes: CSRF Endpoint & Pi-Hole DNS Port Binding**

**Summary:** 
1. Created missing CSRF token endpoint
2. Fixed Pi-Hole DNS port 53 conflict with Incus dnsmasq

**Issue 1: CSRF 404**
Pages were fetching `/api/auth/csrf` which didn't exist.

**Fix 1:**
Created CSRF endpoint that reads `ye-csrf` cookie and returns the token.

**Issue 2: Pi-Hole Port 53 Conflict**
Incus dnsmasq binds to bridge IP (10.x.x.x:53). Pi-Hole tried to bind to 0.0.0.0:53 which conflicted.

**Fix 2:**
- Added `getHostExternalIP()` function that reads from `HOST_IP` env var
- Added `fixPiHoleDNSBinding()` that modifies DNS proxy devices to use host external IP instead of 0.0.0.0
- Special handling for `manifest.name === 'pihole'`

**New Files:**
- `src/app/api/auth/csrf/route.ts` - Returns CSRF token from ye-csrf cookie

**Modified Files:**
- `src/app/api/apps/install/route.ts` - Added Pi-Hole DNS binding fix

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- CSRF endpoint returns 200
- Pi-Hole DNS devices will bind to HOST_IP (192.168.31.190)

---

### v0.1.27 (2026-02-05)

**Bug Fix: Pi-Hole Restart Button Not Working**

**Summary:** Added container actions (start/stop/restart) to Pi-Hole control API.

**Root Cause:**
The Pi-Hole control API only accepted `enable` and `disable` actions. When the UI sent a `restart` action, it was rejected as invalid.

**Fix:**
Added container lifecycle actions using Incus REST API:
- `start` - Start the container
- `stop` - Stop the container  
- `restart` - Restart the container (force + stateful)

**Code Changes:**
- `src/app/api/apps/pihole/control/route.ts`:
  - Added `containerAction()` helper function using `incusRequest('PUT', '/1.0/instances/.../state', {...})`
  - Added start/stop/restart to allowed actions array
  - Fixed import: now imports from `@/lib/incus/server` instead of `@/lib/incus/client`

**Testing:**
- Deployed to YouEye-Dev-VM (192.168.31.190)
- Control Panel v0.1.27 running (Next.js 16.1.4)
- All services operational

---

### v0.1.26 (2026-02-05)

**Major Feature: Pi-Hole Enhanced Authentication & Local DNS Management**

**Summary:** Added secure password management for Pi-Hole API, persistent storage support, and Local DNS record management (A/CNAME records).

**New Features:**

1. **Secure Password Management**
   - Passwords stored in systemd environment variables (same pattern as JWT_SECRET)
   - Never exposed in logs, URLs, or container configuration
   - Admin can change password from DNS Settings tab

2. **Local DNS Records**
   - Manage A/AAAA records (domain → IP)
   - Manage CNAME records (alias → target)
   - Full CRUD from Control Panel UI

3. **Persistent Storage**
   - Pi-Hole data persists across container restarts
   - Gravity database, custom DNS records, and settings are preserved

4. **Enhanced DNS Page**
   - New "Local DNS" tab for A/AAAA and CNAME record management
   - New "Settings" tab with password management and direct Pi-Hole access link

**New Files:**
- `src/lib/apps/secrets.ts` - Secure password storage using systemd env vars
- `src/app/api/apps/pihole/password/route.ts` - GET/POST password management
- `src/app/api/apps/pihole/dns-records/route.ts` - GET/POST/DELETE A records
- `src/app/api/apps/pihole/cname-records/route.ts` - GET/POST/DELETE CNAME records

**Modified Files:**
- `src/lib/apps/manifest.ts` - Updated PIHOLE_MANIFEST with port 53 and volumes
- `src/app/api/apps/pihole/stats/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/domains/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/queries/route.ts` - Use dynamic password from secrets
- `src/app/api/apps/pihole/control/route.ts` - Use dynamic password from secrets
- `src/app/(dashboard)/dns/page.tsx` - Added Settings and Local DNS tabs
- `scripts/postbuild.js` - Resolve symlinks to fix Windows→Linux deployment

**Build Fix:**
The postbuild script now resolves all symlinks in node_modules/ to real files. This fixes the "Cannot find module 'next'" error when deploying from Windows builds.

**Testing:**
- Deployed to dev server 192.168.31.190
- Spine v0.1.12, Control Panel v0.1.26
- Pi-Hole running and accessible

---

### v0.1.25 (2026-02-05)

**Feature: DNS Tab with Pi-Hole UI**

**Summary:** Added dedicated DNS tab to sidebar for Pi-Hole management with quick install and full management UI.

**Changes:**
- Added DNS tab to sidebar navigation
- Added DNS page at `/dns` with Pi-Hole install/management
- Overview, Query Log, and Block Lists tabs

---

### v0.1.22 (2026-02-04)

**Major Feature: Multi-App Management Pages**

**Summary:** Added management UI for core infrastructure apps: PostgreSQL, Authentik, and Pi-Hole. Also fixed critical build issue with pnpm symlinks on Windows.

**New App Pages:**
- `/apps` - Overview page with container status cards for each app
- `/apps/postgres` - PostgreSQL management: stats, databases, users
- `/apps/authentik` - Authentik management: stats, user count
- `/apps/pihole` - Pi-Hole management: stats, queries, domains, enable/disable

**New API Routes:**
- `GET /api/apps/postgres/stats` - PostgreSQL server stats
- `GET /api/apps/postgres/databases` - List databases with sizes
- `GET /api/apps/postgres/users` - List database users
- `GET /api/apps/authentik/stats` - Authentik service stats
- `GET /api/apps/pihole/stats` - Pi-Hole DNS query stats
- `GET /api/apps/pihole/queries` - Recent DNS queries
- `GET /api/apps/pihole/domains` - Whitelisted/blacklisted domains
- `POST /api/apps/pihole/control` - Enable/disable Pi-Hole

**Build Fix: pnpm Symlinks on Windows**

**Root Cause:** Windows tar creates broken symlinks when building pnpm-managed projects. The pnpm `.pnpm/node_modules/` structure uses symlinks that point to Windows paths like `//?/C:/Users/...`. When extracted on Linux, these symlinks are broken and packages like `styled-jsx`, `sharp`, etc. are missing.

**Fix:** Added `scripts/postbuild.js` that:
1. Copies `.next/static/` and `public/` to standalone (existing behavior)
2. Copies all packages from `.pnpm/node_modules/` to top-level `node_modules/`
3. This ensures all dependencies are available as real files, not broken symlinks

**Code Changes:**

*New Files:*
- `src/app/(dashboard)/apps/page.tsx` - Apps overview
- `src/app/(dashboard)/apps/postgres/page.tsx` - PostgreSQL management
- `src/app/(dashboard)/apps/authentik/page.tsx` - Authentik management
- `src/app/(dashboard)/apps/pihole/page.tsx` - Pi-Hole management
- `src/app/api/apps/postgres/stats/route.ts` - PostgreSQL stats API
- `src/app/api/apps/postgres/databases/route.ts` - PostgreSQL databases API
- `src/app/api/apps/postgres/users/route.ts` - PostgreSQL users API
- `src/app/api/apps/authentik/stats/route.ts` - Authentik stats API
- `src/app/api/apps/pihole/stats/route.ts` - Pi-Hole stats API
- `src/app/api/apps/pihole/queries/route.ts` - Pi-Hole queries API
- `src/app/api/apps/pihole/domains/route.ts` - Pi-Hole domains API
- `src/app/api/apps/pihole/control/route.ts` - Pi-Hole control API
- `src/lib/incus/container-ip.ts` - Container IP discovery utility
- `scripts/postbuild.js` - Build fix for pnpm symlinks

*Modified Files:*
- `package.json` - Updated postbuild script to use `node scripts/postbuild.js`
- `src/components/layout/sidebar.tsx` - Added "Apps" navigation link

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Login page loads correctly
- All services running: Spine v0.1.10, Control Panel v0.1.22

**Note:** This version deployed successfully after fixing TWO bugs in Spine v0.1.10:
1. Tar extraction path (--strip-components=1)
2. Health check network isolation (incus exec curl)

---

### v0.1.21 (2026-02-04)

**Bug Fix: Route Detection for Container Routing Table**

**Summary:** Fixed a bug where the Container Routing Table displayed incorrect route information after page refresh. The UI was showing auxiliary routes (like `/favicon.ico`) instead of the main configured route.

**Root Cause:**
When detecting the current route for a container, the API used `.find()` which returns the first matching route. Path routing creates multiple routes: main route, `/_next/*`, and `/favicon.ico`. Since auxiliary routes were added with `unshift()`, they appeared first in the array and were incorrectly displayed.

**Fix:**
- Added `AUXILIARY_ROUTE_PATHS` constant to filter out `/_next/*`, `/_next`, and `/favicon.ico`
- Updated route detection logic to skip auxiliary routes when finding the "main" route

**Code Changes:**
- `src/app/api/containers/route.ts`:
  - Added `AUXILIARY_ROUTE_PATHS` constant
  - Updated route detection to filter auxiliary routes for both system containers and app manifest containers

**Testing:**
- Deployed to dev server (192.168.31.190)
- Verified subdomain route `controlpanel.skibidi.wtf` is configured correctly
- Service running successfully

---

### v0.1.20 (2026-02-04)

**Feature: Path Routing Support for Next.js Apps**

**Summary:** Added support for path-based routing with Next.js apps by creating auxiliary routes for static assets.

**Note:** Path routing still has limitations with Next.js - redirects use absolute paths. Subdomain routing is recommended.

---

### v0.1.19 (2026-02-04)

**Major Feature: Unified Proxy Configuration UI**

**Summary:** Complete redesign of the Proxy page with a unified domain configuration and container routing table. Fixes path-based routing and adds volume mounts for Caddy config persistence.

**New Features:**
1. **Domain Configuration Card** - Single input for base domain with auto-TLS
2. **Container Routing Table** - Shows all YouEye containers with web UIs
3. **Route Type Selection** - Subdomain, path, or none options per container
4. **Path Pattern Normalization** - Automatically fixes `/control` → `/control/*`

**Bug Fixes:**
1. **Path Routes Not Working** - Caddy's `*` wildcard doesn't cross path separators. Fixed by normalizing path patterns to include trailing `/*`
2. **Config Not Persisting** - Added Incus volume mounts for Caddy's `/config` and `/data` directories (requires Caddy reinstall to activate)

**New API Endpoints:**
- `GET /api/containers` - Lists containers with web UIs available for routing
- `GET/POST /api/domain` - Get/set the base domain for routing
- `POST /api/containers/[name]/route` - Set container routing (subdomain/path/none)

**Code Changes:**

*New Files:*
- `src/app/api/containers/route.ts` - Container listing endpoint
- `src/app/api/containers/[name]/route/route.ts` - Route assignment endpoint
- `src/app/api/domain/route.ts` - Domain configuration endpoint
- `src/components/proxy/container-routing-table.tsx` - New routing table component
- `src/components/ui/select.tsx` - Radix Select component

*Modified Files:*
- `src/lib/caddy/client.ts`:
  - Added `normalizePathPattern()` - Ensures `/path/*` format
  - Updated `formDataToRoute()` and `addRoute()` to return warnings
  - Added `setContainerRoute()`, `getConfiguredDomain()`, `setDomain()`
- `src/lib/apps/manifest.ts`:
  - Added `volumes` to CADDY_MANIFEST for `/config` and `/data`
  - Added `webPort` field to all manifests
  - Updated `manifestToIncusConfig()` to handle volumes
- `src/types/apps.ts`:
  - Added `volumes` and `webPort` to AppManifest interface
- `src/app/api/apps/install/route.ts`:
  - Added `ensureHostDirectories()` for volume mount directories
- `src/app/(dashboard)/proxy/page.tsx`:
  - Removed old TLSCard/RouteList/RouteFormDialog
  - Added domain input card and ContainerRoutingTable
- `package.json`:
  - Added `@radix-ui/react-select` dependency
  - Version: 0.1.18 → 0.1.19

**Technical Details:**

*Path Pattern Normalization:*
```typescript
// Input: /control → Output: /control/*
function normalizePathPattern(pattern: string): { pattern: string; modified: boolean }
```
Caddy's `*` wildcard matches any characters BUT doesn't cross `/` separators.
- `/control*` matches `/controlABC` but NOT `/control/dashboard`
- `/control/*` matches `/control/dashboard`

*Container Route Assignment:*
```typescript
setContainerRoute(domain, containerName, port, routeType, routeValue)
// routeType: 'subdomain' | 'path' | 'none'
// Example path: domain=skibidi.wtf, routeValue=/control → skibidi.wtf/control/*
```

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- `/api/containers` returns containers with webPort correctly
- `/api/domain` returns configured domain (skibidi.wtf)
- Path route `/control` normalized to `/control/*` in Caddy config
- Route works: `curl -k https://skibidi.wtf/control/` returns 307 redirect
- Caddy includes rewrite handler to strip path prefix before forwarding

**Notes:**
- Volume mounts require Caddy reinstall to activate (existing Caddy won't have them)
- Host authentication uses Spine API's `/api/auth/verify` (PAM on host, not container)
- Default host root password: set via `chpasswd` on host

---

### v0.1.18 (2026-02-04)

**Bug Fix: Admin groups not passed to isAdmin check during login**

**Root Cause:** The login route was calling `getUserGroups(username)` which always returned `[]`, then calling `isAdmin(username)` without the groups. This meant only `root` users were recognized as admin, even though users like `youeye` are in the `sudo` group.

**Fix:** Use `authResult.groups` from PAM authentication result and pass to `isAdmin(username, groups)`.

**Code Changes:**
- `src/app/api/auth/login/route.ts` - Use groups from auth result, remove unused getUserGroups import

**Testing:**
- Deployed to dev server 192.168.31.190
- User `youeye` (in sudo group) should now be recognized as admin after re-login

**Note:** Users must log out and log back in to get a new session with the correct admin status.

---

### v0.1.17 (2026-02-04)

**Bug Fix: Static Files Missing in Standalone Build**

**Root Cause:** Next.js standalone output doesn't automatically copy `.next/static/` and `public/` folders. CSS/JS files were returning 404 or being served with `text/plain` MIME type, causing browsers to refuse loading them with strict MIME checking.

**Fix:** Added `postbuild` script to copy static files into standalone folder.

**Code Changes:**
- `package.json` - Added postbuild script: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`
- `package.json` - Build script now explicitly runs postbuild: `next build && pnpm run postbuild`
- Version bump: 0.1.16 → 0.1.17

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update control`
- Verified CSS returns `Content-Type: text/css; charset=UTF-8`
- Verified JS returns `Content-Type: application/javascript; charset=UTF-8`  
- Verified fonts return `Content-Type: font/woff2`
- No MIME type errors in browser console

**Note for Windows builds:** The `cp` command doesn't work on Windows. Use PowerShell:
```powershell
Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static"
Copy-Item -Recurse -Force "public" ".next\standalone\public"
```

---

### v0.1.16 (2026-02-04)

**Changes:**
- Secured Caddy Admin API: removed external port 2019 exposure
- Added route ordering by specificity (sortRoutes function)
- Enhanced TLS automation for hostname handling
- Added request timeout (10s) and retry logic with exponential backoff
- Added route verification after config application
- Improved initial Caddy config generation
- Added comprehensive logging for Caddy operations

**Code Changes:**
- `src/lib/apps/manifest.ts` - Removed adminPort from CADDY_MANIFEST
- `src/lib/caddy/client.ts` - Major refactoring with timeout/retry, sorting, verification
- `package.json` - Version bump

**Testing:**
- Deployed to dev server 192.168.31.190
- Verified port 2019 NOT exposed externally (SECURE)
- Verified internal Caddy API access works
- HTTP/HTTPS ports working

---

## Architecture Notes

### Caddy Integration
- Control Panel communicates with Caddy via Incus DNS: `http://youeye-caddy.incus:2019`
- Admin API NOT exposed to host network (security requirement)
- Caddy configured to bind admin API to `0.0.0.0:2019` inside container
- Config persistence via `--resume` flag: auto-saves to `/config/caddy/autosave.json`, reloads on restart
- No `/config` volume mount — Caddy uses its internal container filesystem for XDG_CONFIG_HOME
- `/data` volume mounted for TLS certificate persistence across container recreation

### Key Files
- `src/lib/caddy/client.ts` - Caddy Admin API client
- `src/lib/caddy/types.ts` - TypeScript types for Caddy config
- `src/lib/apps/manifest.ts` - App manifests including Caddy
- `src/app/api/caddy/*` - API routes for Caddy management

---

## See Also (Wiki Documentation)

- **[Agents](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agents)** — AI agent navigation hub
- **[Agent Testing Methodology](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Agent-Testing-Methodology)** — Mandatory testing workflow
- **[Playwright Testing](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Playwright-Testing)** — **MANDATORY** browser testing for all Control Panel changes
- **[Control Panel](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Control-Panel)** — Complete Control Panel documentation
- **[Development Setup](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Development-Setup)** — Build and deployment procedures
- **[Git Workflow](https://git.byka.wtf/potemsla/YE-Wiki/wiki/Git-Workflow)** — Commit format and versioning
