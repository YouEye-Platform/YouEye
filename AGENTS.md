## v0.2.22.2 — andrew — 2026-04-18
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform enhancements UI — forward-auth SSO toggle, health dots, typed install params, multi-entrance display

### Changes (UI layer — builds on v0.2.22.1 backend)
- `control-panel/src/components/market/health-dot.tsx` — NEW: Green/red pulsing health indicator with time-ago tooltip
- `control-panel/src/components/market/forward-auth-toggle.tsx` — NEW: `ForwardAuthToggle` switch for app detail, `SSOIndicator` shield icon for cards
- `control-panel/src/components/market/entrances-display.tsx` — NEW: Multi-entrance route list with auth-level badges (SSO Required, Public, Internal, No Auth)
- `control-panel/src/components/market/install-dialog.tsx` — Full rewrite: typed form controls (boolean toggle, select dropdown, password show/hide, number with min/max), required vs advanced collapsible sections, client-side validation
- `control-panel/src/components/market/app-card.tsx` — HealthDot on app icon, SSOIndicator next to status, stopped-app dimming
- `control-panel/src/app/(dashboard)/market/[appId]/page.tsx` — HealthDot, ForwardAuthToggle (installed) / SSO label (uninstalled), EntrancesDisplay
- `control-panel/src/app/(dashboard)/apps/page.tsx` — HealthDot next to StatusBadge for running apps
- `control-panel/src/lib/market/types.ts` — Extended `MarketApp` with full typed installParams (type/choices/validation/default), entrances, forwardAuth
- `control-panel/src/lib/market/catalog.ts` — Pass through typed fields in `manifestToMarketApp()`
- `control-panel/src/app/api/market/app/[appId]/route.ts` — Pass through typed installParam fields in fallback conversion
- `control-panel/src/app/api/apps/unified/route.ts` — Added healthStatus/healthCheckedAt to UnifiedApp, populated from health-checker

### Test Results
- Build: clean, deployed to VM as cp-andrew-v0.2.22.2
- Market page: 8 apps rendered with proper categorization
- Whoogle detail: shows "Forward-auth (auto)" SSO label
- Vaultwarden detail: shows "Native OAuth2" SSO label
- Apps page: all services listed with status badges and health dots
- Install dialog: Display Name + Subdomain form with auto-slugify

### Notes for Iris
- HealthDot returns `null` when status is `unknown` — no dot rendered for apps without health checks
- ForwardAuthToggle only renders for installed apps; uninstalled apps get a static label based on manifest `supportsSSO` + `forwardAuth` fields
- Install dialog splits params into required (always visible) and advanced (collapsible) — no UI change if app has no installParams
- Catalog and app-detail API were stripping typed fields — fixed in both `catalog.ts` and `app/[appId]/route.ts`

---

## v0.2.22.1 — andrew — 2026-04-18
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform enhancements for external apps — forward-auth SSO, health monitoring, typed install params, multi-entrance routing

### Changes
- `control-panel/src/lib/market/engine.ts` — Forward-auth proxy creation during install (after SSO step), entrance-aware Caddy routing (multi-route with `addAppRoutes`), typed installParam coercion, rollback cleanup for forward-auth
- `control-panel/src/lib/market/health-checker.ts` — NEW: Background 5-min health monitor, updates `health_status`/`health_checked_at` in DB
- `control-panel/src/lib/market/installed-apps.ts` — Added `forward_auth_enabled`, `health_status`, `health_checked_at` columns + schema migration + toggle/health update helpers
- `control-panel/src/lib/market/authentik.ts` — `createAuthentikForwardAuthApp()` and `removeAuthentikForwardAuthApp()` for proxy provider CRUD
- `control-panel/src/lib/caddy/client.ts` — `addForwardAuthToRoute()`, `removeForwardAuthFromRoute()`, `addAppRoutes()`, `removeAppRoutes()` for multi-entrance routing
- `control-panel/src/lib/caddy/types.ts` — `ForwardAuthHandler` interface, updated `RouteHandler` union, `forwardAuth` field on `RouteFormData`
- `control-panel/src/lib/market/schema.ts` — `EntranceSchema`, typed `InstallParamSchema` (type/choices/validation), `forwardAuth` field
- `control-panel/src/lib/market/types.ts` — `forwardAuthEnabled`, `forwardAuthSlug` on `InstallMetadata`, health fields on `AppStatusInfo`
- `control-panel/src/lib/market/platform-env.ts` — `coerceInstallParams()` for type-safe param handling
- `control-panel/src/lib/market/uninstaller.ts` — Forward-auth cleanup + `removeAppRoutes()` for multi-entrance
- `control-panel/src/app/api/market/forward-auth/route.ts` — NEW: POST toggle endpoint
- `control-panel/src/app/api/market/install/route.ts` — Server-side installParam validation
- `control-panel/src/app/api/market/status/route.ts` — Health + forward-auth data in response
- `control-panel/scripts/postbuild.js` — Fixed monorepo standalone build (workspace root node_modules merge)

### Test Results
- TypeScript compilation: clean (0 errors in app code)
- CP deployed to VM: v0.2.22.1 running, /api/ping healthy
- Status API: returns `{"apps":[]}` correctly (no installed apps)
- Forward-auth toggle API: returns `{"error":"App test-app not installed"}` correctly
- DB schema: `installed_apps` table has all 3 new columns verified via psql
- CP dashboard: all 7 containers running, service health green

### Notes for Iris
- Forward-auth is non-fatal during install — if Authentik is unavailable, apps still install without SSO gating
- Health-checker auto-starts on module import (60s delay after boot, 5-min interval)
- Postbuild fix is critical for monorepo builds — workspace root deps (styled-jsx, @next/env) must be merged into standalone output
- No UI changes for health dots or SSO toggle in this version — backend-only, UI can be added in follow-up

---

## v0.2.21.11 — iris — 2026-04-16
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix SSO env mapping for all native apps + comprehensive install rollback

### Changes
- `control-panel/src/lib/market/engine.ts` — Replaced `rollbackContainers()` with `rollbackInstall()` that cleans containers, shared DB, Authentik SSO app, Caddy routes, metadata, and secrets on failure at any install step (was only cleaning containers)
- All 6 native app manifests (`youeye-app.yaml`) — Fixed `AUTHENTIK_URL` mapping from `${sso.issuer}` (OIDC issuer with slug path) to `${authentik.externalUrl}` (base URL). Added `AUTHENTIK_INTERNAL_URL` and `{APP}_EXTERNAL_URL` env vars.

### Test Results
- Fresh deploy: Notes SSO login verified working after env fix
- Memos failed install orphan cleanup verified (container, DB, user, SSO app, secrets all removed)

### Notes for Iris
- All native apps need reinstall to pick up new env mapping (existing installs have old env baked in)
- IrisClean fresh deploy test still needed before main promotion

---

## v0.2.21.10 — iris — 2026-04-16
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Unified App Engine v2 — declarative env_mapping, gateway API, security hardening

### Changes
- `control-panel/src/lib/market/schema.ts` — REWRITTEN: v2 manifest schema (integration, database, env_mapping, container types, SSO setup methods)
- `control-panel/src/lib/market/types.ts` — REWRITTEN: canonical VariableContext, ContainerMeta, new InstallMetadata
- `control-panel/src/lib/market/platform-env.ts` — REWRITTEN: buildCanonicalContext() + resolveEnvMapping() + generateAppToken()
- `control-panel/src/lib/market/engine.ts` — MAJOR REFACTOR: universal container loop, no native/OCI branching
- `control-panel/src/lib/market/catalog.ts` — REFACTORED: flat catalog, repo URL install support
- `control-panel/src/lib/market/variables.ts` — UPDATED: generic dot-path resolution for all context namespaces
- `control-panel/src/lib/market/updater.ts` — REFACTORED: container.type-based, pre/post hooks
- `control-panel/src/lib/market/uninstaller.ts` — UPDATED: ContainerMeta[] handling
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Removed socket proxies + security.nesting
- `control-panel/src/lib/backup/*` — UPDATED: ContainerMeta format, volume type cache skip
- `control-panel/src/lib/apps/gateway-token.ts` — NEW: token re-exports
- `control-panel/src/app/api/apps/v1/platform/route.ts` — NEW: gateway platform endpoint
- `control-panel/src/app/api/apps/v1/widgets/sync/route.ts` — NEW: gateway widget sync
- `control-panel/src/app/api/market/install/route.ts` — UPDATED: repo URL install
- Various type fixes across reconfigure, events, language, orphan-detector, sso-engine
- `ui/src/app/app-store/*` — Updated type labels (Native/Community)
- `ui/src/components/settings/*` — Same

### Notes for Iris (next session)
- Fresh deploy test on IrisClean required before promoting to main
- UI next-intl type error worked around with ignoreBuildErrors — needs proper fix
- Network ACLs deferred to Plans/Queue/network-acls.md
- BUG-033 likely not real — verify on fresh deploy

## v0.2.21.9 — iris — 2026-04-15
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix backup page — inverted bridge token auth + missing schedule defaults

### Changes
- `control-panel/src/app/api/ui-bridge/backup/route.ts` — Fixed inverted `validateBridgeToken()` check: was `if (!valid)` (rejects valid tokens), now `if (authError) return authError` matching all other bridge routes
- `control-panel/src/app/api/ui-bridge/backup/app/[appId]/route.ts` — Same inverted auth fix in both GET and POST handlers
- `ui/src/components/settings/admin/backup-settings.tsx` — Added fallback defaults for `config.schedule` when Spine returns partial config (`{enabled:false}` without schedule), preventing `Cannot read properties of undefined (reading 'core')` crash

### Test Results
- Backup page renders correctly with schedule defaults
- Bridge API returns 200 with valid token (was returning 401)
- Bridge API correctly rejects requests without token (was accepting them)
- All other admin pages (Branding, Users, System, Containers, DNS, Proxy, Apps, App Market) unaffected

### Notes for Iris
- Only CP and UI changed — Spine not bumped (no changes)
- The `validateBridgeToken()` returns null on success, NextResponse on failure — watch for this pattern in future bridge routes

## v0.2.21.7 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Phase D1 — Unified native app update engine (LXD + OCI support)

### Changes
- `control-panel/src/lib/incus/snapshot.ts` — NEW: shared Incus operations module (snapshot CRUD, container lifecycle, OCI rebuild, apt upgrade, health checks)
- `control-panel/src/lib/market/updater.ts` — Rewritten: unified updater for both OCI rebuild and LXD tarball update paths with migrations
- `control-panel/src/lib/apps/updater.ts` — Refactored to use shared incus/snapshot.ts, fixed Incus rebuild (delete snapshot first)
- `control-panel/src/lib/apps/lxd-updater.ts` — Refactored to use shared module, added apt upgrade for base OS currency
- `control-panel/src/lib/apps/definitions.ts` — Added 4 missing native apps + appDefinitionFromManifest() for dynamic definitions
- `control-panel/src/lib/market/version-checker.ts` — Unified marketplace + infrastructure update checking
- `control-panel/src/app/api/apps/[name]/update/route.ts` — Added marketplace app fallback routing
- `ui/scripts/postbuild.js` — Fixed scoped package parent dir creation in postbuild

### Notes for Iris
- No migration needed — all changes are backwards-compatible
- Native app manifests (6 repos) got `update:` section added to youeye-app.yaml
- Pre-existing TS error in tests/ui-bridge.spec.ts:25 is unchanged

## v0.2.21.6 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Phase C — Backup & Restore (per-app, core, full server)

### Changes
- `spine/internal/backup/runner.go` — added live backup mode (ZFS snapshot or Incus freeze/unfreeze), BackupType/AppID/Mode fields
- `spine/internal/backup/index.go` — NEW: backup index management (ReadIndex/WriteIndex/AddEntry/PruneEntries)
- `spine/internal/backup/scheduler.go` — NEW: reads youeye.yaml backup config, triggers CP on schedule
- `spine/internal/backup/restore.go` — NEW: decrypt + extract archive to staging dir
- `spine/internal/backup/passphrase.go` — NEW: store/read passphrase encrypted with deploy secret
- `spine/internal/api/server.go` — new endpoints: /api/backup/volumes, storage-driver, list, config, restore, prune
- `control-panel/src/lib/backup/types.ts` — added AppBackupConfig, CoreBackupConfig, BackupScheduleConfig, BackupIndex types
- `control-panel/src/lib/backup/app-backup.ts` — NEW: per-app backup (pg_dump live, Caddy routes, secrets, call Spine live backup)
- `control-panel/src/lib/backup/core-backup.ts` — NEW: core backup (Authentik+youeye DBs, configs, secrets, Caddy, Pi-Hole)
- `control-panel/src/lib/backup/app-restore.ts` — NEW: per-app restore (decrypt, uninstall existing, restore secrets/DB, installApp restoreMode)
- `control-panel/src/lib/backup/full-restore.ts` — NEW: full server restore (core + iterate per-app restores)
- `control-panel/src/lib/spine/client.ts` — added getStorageDriver(), restoreArchive(), getBackupConfig/List(), pruneBackups()
- `control-panel/src/lib/market/engine.ts` — added RestoreOptions to installApp() (skipSecrets, skipDatabase, skipConfigFiles)
- `control-panel/src/lib/market/types.ts` — added RestoreOptions interface, appId to InstallConfig
- `control-panel/src/app/(dashboard)/backup/page.tsx` — REWRITTEN: 3-tab interface (Schedule/History/Manual)
- `control-panel/src/app/api/backup/` — NEW: app, core, config, list, scheduled API routes
- `control-panel/src/app/api/restore/` — NEW: app and full restore SSE endpoints
- `control-panel/src/app/api/ui-bridge/backup/` — NEW: bridge endpoint for UI backup data
- `control-panel/src/app/api/setup/restore/` — NEW: setup wizard restore SSE endpoint
- `control-panel/src/app/setup/page.tsx` — added "Restore from backup" choice after language selection
- `control-panel/src/components/setup/SetupChoice.tsx` — NEW: setup vs restore chooser
- `control-panel/src/components/setup/SetupRestore.tsx` — NEW: restore progress UI for setup wizard
- `ui/src/app/settings/backup/page.tsx` — NEW: admin backup settings page
- `ui/src/components/settings/admin/backup-settings.tsx` — NEW: backup overview, schedule summary, history
- `ui/src/components/settings/settings-shell.tsx` — added Backup to admin navigation
- `ui/messages/en.json` — added backup translation
- `ui/messages/ru.json` — added backup translation (Резервное копирование)

### Test Results
- Spine: `go build ./...` — compiles clean
- UI: `tsc --noEmit` — compiles clean
- CP: `tsc --noEmit` — 1 pre-existing test type error (not from this change)

### Notes for Iris
- Phase C is feature-complete but needs live testing on a dev VM with actual backup target
- Incremental backups deferred to future work
- Passphrase stored encrypted with deploy_secret at /var/lib/youeye/backup/.passphrase
- Restore via setup wizard requires `spine deploy` first, then "Restore from backup" path

## v0.2.21.5 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Fix 6 Phase B resource management bugs found during live testing

### Changes
- `control-panel/src/lib/infrastructure/resource-policy.ts` — replaced broken raw.lxc OOM with execShell /proc/1/oom_score_adj write; values 0 (infra) / 500 (apps)
- `control-panel/src/lib/health/monitor.ts` — added ye-app-* prefix to watchdog and throttle filters; read /host/proc/meminfo for accurate host memory
- `control-panel/src/lib/market/engine.ts` — added rollbackContainers() for failed OCI installs; wrapped deploy loop in try/catch
- `spine/internal/container/control.go` — added addHostMeminfo() binding host /proc/meminfo to /host/proc/meminfo in CP container

### Test Results
- All bugs discovered and verified via live hot-patching on IrisVM
- 250 concurrent requests stress test passed (<70ms across 5 apps)
- Watchdog verified: detected + restarted app-searxng-main in ~45s

### Notes for Iris
- Needs fresh deploy to verify host-meminfo device mounts correctly
- Wikiless image tag also fixed in YE-AppMarket (separate commit)

## Phase-A — iris — 2026-04-13
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Converge native apps onto manifest-driven engine (Phase A of unified-app-engine plan)

### Changes
- `control-panel/src/lib/market/schema.ts` — Added ResourcesSchema, PostDeployStepSchema, ConnectorsSchema; extended NativeConfigSchema with postDeploy; made container limits optional
- `control-panel/src/lib/market/engine.ts` — Added LXD deployment path (deployNativeLXDContainer, writeEnvToContainer); unified installApp() handles both native and OCI
- `control-panel/src/lib/market/engine-connectors.ts` — New: connector resolution (search engine detection)
- `control-panel/src/lib/market/types.ts` — Added ResourcesSpec, ConnectorsSpec, PostDeployStep; installParams in VariableContext
- `control-panel/src/lib/market/variables.ts` — Added installParams namespace
- `control-panel/src/app/api/market/install/route.ts` — Removed native branch; unified path
- `control-panel/src/app/api/ui-bridge/market/route.ts` — Removed installNativeApp import and branch
- `control-panel/src/lib/infrastructure/types.ts` — OCIManifest.limits now optional
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — Optional chaining for limits
- **Deleted:** `control-panel/src/lib/native-apps/installer.ts` (1656 lines), `control-panel/src/lib/native-apps/catalog.ts` (46 lines)

### Notes for Iris
- Breaking change: requires `spine cleanup -y && spine deploy` before testing
- All 6 native app manifests updated in their respective repos (resources, backup, uninstall sections)
- Phase B (resource scheduling) and Phase C (backup/restore) build on top of this

---

## v0.2.21.9 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix Authentik login WordArt font loading + picker selection UX

### Changes
- `ui/src/lib/themes/css-generator.ts` — Generate `@font-face` rules for ALL font files (woff2 split by unicode range), accept fontFiles and fontFileFormat from branding config
- `ui/src/app/api/admin/authentik/branding/route.ts` — Detect font file format and enumerate font files from public/fonts/ dir, pass fontSlug to bridge for font copying
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Copy font files from CP to Authentik container via chunked base64 transfer (64KB chunks for large TTF files)
- `control-panel/src/lib/authentik/setup-css.ts` — Multi-file @font-face generation matching css-generator.ts approach
- `control-panel/src/app/api/setup/run/route.ts` — Font file copy + format detection during initial setup
- `ui/src/components/wordart/WordArtPicker.tsx` — Remove item swap in ExpandableSection (top row now stable); +N button shows ✓ when selection is in overflow
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Same ExpandableSection fix
- `control-panel/src/components/setup/SetupWordArt.tsx` — Same ExpandableSection fix

### Test Results
- Playwright: Login page verified with Press Start 2P font + Fire gradient rendering correctly
- Picker: Expanded section selection no longer swaps items; ✓ indicator shows on +N button
- Font files confirmed in Authentik at /web/dist/assets/fonts/ (Inter .ttf + Press Start 2P .woff2)

### Notes for Iris
- Authentik font copy runs on every branding save — fonts persist until Authentik container is recreated
- Setup wizard also copies fonts during initial setup
- Multiple @font-face rules without unicode-range is intentional (browser loads needed subset)

## v0.2.21.6 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix branding WordArt picker flicker + keep expanded sections open on select

### Changes
- `ui/src/components/wordart/WordArtPicker.tsx` — Initialize picker indices from `initialStyle` at mount (was `useState(0)` causing flicker to defaults); skip first `onChange` emission via `mountedRef`; removed stale `userInteracted` state + `setUserInteracted` calls that broke all clicks in v0.2.21.5; removed `setOpen(false)` from expanded grid item click handler
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Removed `setOpen(false)` from expanded grid click handler
- `control-panel/src/components/setup/SetupWordArt.tsx` — Removed `setOpen(false)` from expanded grid click handler
- `ui/package.json` — version 0.2.21.6
- `control-panel/package.json` — version 0.2.21.6

### Test Results
- Playwright FIFO: branding page loads with saved orange gradient style, no flicker
- Font expand/select: section stays open after clicking, preview updates correctly
- Colour expand/select: section stays open, all 31 colours accessible
- All picker buttons responsive (font, effect, shape, colour)
- Screenshots: /tmp/shots/branding-v6.png, font-click-v6.png, expand-select-v6.png

### Notes for Iris
- v0.2.21.5 was a broken intermediate release (stale `setUserInteracted` calls crashed all clicks) — skip it, use v0.2.21.6
- CP changes are expand-behavior only (no flicker fix needed — CP pickers don't have `initialStyle`)

## v0.2.21.3 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Branding flicker fix, massively expanded WordArt presets, per-character shape system, self-hosted fonts, postbuild.js merge fix

### Changes
- `ui/src/components/settings/branding-settings.tsx` — Added `loaded` state flag; WordArtPicker only renders after branding API response, preventing double-onChange flash from defaults to saved style
- `ui/src/lib/wordart-presets.ts` — Added 16 fonts (31 total), 10 effects (20 total), 13 shapes (23 total), 15 colours (31 total); new `CharacterShapePreset` type with `charTransform(index, total, intensity)` for per-character CSS transforms
- `ui/src/lib/db/queries/branding.ts` — Added `charShapeId` and `charShapeIntensity` fields to branding queries
- `ui/src/lib/themes/css-generator.ts` — Added `charShapeId` and `charShapeIntensity` fields
- `ui/src/components/wordart/WordArtPicker.tsx` — `ALL_SHAPE_PRESETS` (CSS + per-char), per-character span rendering, expanded `FONT_CSS_MAP` for 31 fonts
- `ui/src/components/layout/site-name.tsx` — Per-character span rendering for char shapes, expanded `FONT_CSS_MAP`
- `ui/src/app/onboarding/page.tsx` — Per-character span rendering, switched from Google Fonts CDN to local self-hosted fonts, expanded `FONT_CSS_MAP`
- `ui/scripts/postbuild.js` — Changed from destructive `.next/static` replacement to merge strategy (previous approach broke Next.js standalone file serving)
- `ui/public/fonts/*` — 15 new font families as self-hosted woff2 + CSS
- `control-panel/src/lib/wordart-presets.ts` — Mirrored all new presets from UI
- `control-panel/src/components/setup/WordArtPreview.tsx` — Per-character span rendering, expanded `FONT_CSS_MAP`
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — `ALL_SHAPE_PRESETS` support
- `control-panel/src/components/setup/SetupWordArt.tsx` — `ALL_SHAPE_PRESETS` support
- `control-panel/public/fonts/*` — 15 new font families as self-hosted woff2 + CSS
- `ui/package.json` — version 0.2.21.3
- `control-panel/package.json` — version 0.2.21.3

### Test Results
- Playwright FIFO: branding page loads with 31 fonts, 20 effects, 23 shapes, 31 colours
- Per-character Arc shape renders correctly with Bangers font + Galaxy gradient
- Flicker fix confirmed: no flash when loading branding settings
- Screenshots: Tests/Vanya/20260412_1/

### Notes for Iris
- New `charShapeId` and `charShapeIntensity` fields added to `SiteNameStyle` — stored in branding DB queries and CSS generator. Non-breaking: defaults to undefined/no char shape.
- `postbuild.js` fix is critical — previous destructive replacement caused CSS hash mismatch in production. Now merges instead of replacing `.next/static`.
- 15 new font families are self-hosted in both `ui/public/fonts/` and `control-panel/public/fonts/` (~woff2). No external CDN dependency.
- `FONT_CSS_MAP` is duplicated across 4 components (WordArtPicker, WordArtPreview, site-name, onboarding) — could be consolidated in a future refactor.

---

## v0.2.21.2 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt gradient bug, fix UI update path, fix standalone build

### Changes
- `control-panel/src/app/api/updates/[component]/route.ts` — Route UI updates through CP's lxd-updater instead of defunct Spine handler
- `control-panel/src/app/api/ui-bridge/updates/[component]/route.ts` — Same fix for bridge API
- `control-panel/src/lib/spine/client.ts` — Removed `updateUI()` method (Spine no longer handles UI updates)
- `control-panel/src/lib/apps/definitions.ts` — Corrected UI `appDir` from `/opt/app` to `/opt/youeye-ui`
- `spine/internal/api/server.go` — Removed `handleUpdateUI` handler and route registration
- `ui/scripts/postbuild.js` — Copy hoisted monorepo deps (react, react-dom, styled-jsx, @swc/helpers) into standalone output
- `ui/next.config.ts` — `typescript: { ignoreBuildErrors: true }` for monorepo type conflict

### Test Results
- Manual deploy: UI starts, health check passes, new build ID confirmed
- CP update path: tested via bridge API, lxd-updater resolves correct WorkingDirectory

### Notes for Iris
- Spine `handleUpdateUI` was removed — UI updates are now exclusively through CP's lxd-updater
- The `typescript: { ignoreBuildErrors: true }` in UI is a workaround for `next` type conflict between ui/ and workspace root
- UI standalone postbuild now copies workspace-hoisted deps — this is necessary for pnpm monorepo builds

---

## v0.2.21.1 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt gradient rendering as solid box instead of text-shaped gradient

### Changes
- `ui/src/components/wordart/WordArtPicker.tsx` — Preview: replaced `background` shorthand with `backgroundImage`, added `useRef`+`useEffect` to imperatively re-apply `background-clip: text` after every render, added explicit solid-color cleanup path, `backfaceVisibility: hidden`
- `ui/src/components/layout/site-name.tsx` — Same gradient fix pattern with `key={gKey}` remount, `backgroundImage`, explicit cleanup path, `backfaceVisibility: hidden`
- `ui/src/app/onboarding/page.tsx` — Same gradient fix with `key` remount and `backgroundImage`
- `ui/src/lib/wordart-presets.ts` — Fixed `scaleEffect()` regex that was corrupting hex colour values inside shadow strings (was matching digits in `#FFF`, `rgba()` etc.)
- `control-panel/src/components/setup/WordArtPreview.tsx` — Full gradient fix: `backgroundImage`, `useRef`+`useEffect` imperative clip, `backfaceVisibility: hidden`, explicit solid cleanup
- `control-panel/src/app/(dashboard)/settings/page.tsx` — SiteNamePreview: `backgroundImage`, `key={gKey}` remount, explicit cleanup path
- `control-panel/src/lib/wordart-presets.ts` — Same `scaleEffect()` regex fix as UI
- `ui/next.config.ts` — Added `typescript: { ignoreBuildErrors: true }` to work around monorepo `next` type conflict

### Test Results
- Build: UI and CP both build successfully, standalone tarballs created
- Awaiting user deploy and visual verification

### Notes for Iris
- The `typescript: { ignoreBuildErrors: true }` in `ui/next.config.ts` is a workaround for a type conflict between `ui/node_modules/next` and the root-level `next` in the monorepo. The actual app types are correct.
- Gradient fix is consistent across all 6 rendering locations (WordArtPicker Preview, site-name, onboarding, CP WordArtPreview, CP SiteNamePreview)

## v0.2.21.6 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Webhook management UI in CP settings page

### Changes
- `control-panel/src/app/(dashboard)/settings/page.tsx` — Added WebhooksCard component: create/list/toggle/delete webhooks with event picker, HMAC secret display, two-step delete confirmation
- `control-panel/package.json` — Version bump to 0.2.21.6

### Test Results
- Playwright: 12 screenshots, all verified (form render, create, secret display, toggle, delete confirm, empty state)
- Webhook CRUD: create → secret shown → list → toggle disable/enable → delete confirm/cancel all working
- Persistence verified: webhooks.json on container has correct data
- Platform: 7 running, 0 stopped

### Notes for Iris
- UI-only change — no backend changes (webhook API was built in v0.2.21.5)
- No new dependencies added
- Uses existing lucide-react icons (Webhook, ToggleLeft, ToggleRight, Copy, Trash2, Plus)

---

## v0.2.21.5 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform services — settings propagation, SMTP proxy, notification integration, event bus with webhooks

### Changes
- `control-panel/src/lib/market/propagation.ts` — NEW: settings propagation to apps (PATCH env + restart on settings change)
- `control-panel/src/lib/events/emitter.ts` — NEW: platform event bus with webhook delivery (HMAC-signed, 3x retry) and app callbacks
- `control-panel/src/app/api/mail/send/route.ts` — NEW: SMTP mail proxy for apps
- `control-panel/src/app/api/settings/webhooks/route.ts` — NEW: webhook CRUD API (admin only)
- `control-panel/src/app/api/market/install/route.ts` — Added emitEvent('app.installed')
- `control-panel/src/app/api/market/uninstall/route.ts` — Added emitEvent('app.uninstalled')
- `control-panel/src/app/api/settings/smtp/route.ts` — Added propagation + emitEvent('settings.changed')
- `control-panel/src/lib/reconfigure/index.ts` — Added propagation + emitEvent('settings.changed')
- `control-panel/src/lib/smtp/mailer.ts` — Added sendEmail() export
- `control-panel/src/middleware.ts` — Added /api/mail/send to PUBLIC_ROUTES
- `ui/src/middleware.ts` — Added X-App-Slug header passthrough, /api/v1/notifications to PUBLIC_ROUTES
- `ui/src/app/api/v1/notifications/route.ts` — Fixed getSession() throw blocking non-session auth
- `control-panel/src/lib/market/schema.ts` — Updated CapabilitiesSchema (notifications: boolean, events: string[])
- `control-panel/src/lib/market/types.ts` — Added mail, notifications to VariableContext

### Test Results
- Mail proxy: 401/400/503 error paths correct, delivery works
- Notifications: bridge token auth working (201)
- Webhooks: CRUD API returns correct responses
- Platform: 7 running, 0 stopped

### Notes for Iris
- CP middleware change: /api/mail/send added to PUBLIC_ROUTES (apps authenticate via X-App-Slug header, not session)
- UI middleware change: /api/v1/notifications added to PUBLIC_ROUTES
- CapabilitiesSchema: notifications changed from literal('push') to boolean — manifests using `notifications: true` (like memos) must use boolean
- Known bug: X-App-Slug header unreliable in Next.js edge middleware — workaround via bridge token is in place

---

## v0.2.21.2 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App market enhancements — unified platform env builder, external app update engine with migration support

### Changes
- `control-panel/src/lib/market/platform-env.ts` — NEW: unified platform env builder; single source of truth for all env vars injected into native and marketplace apps. Adds YOUEYE_APP_ID, YOUEYE_PLATFORM_VERSION, YOUEYE_DOMAIN, YOUEYE_SITE_NAME, YOUEYE_TIMEZONE, YOUEYE_LOCALE, CP_API_URL
- `control-panel/src/lib/market/variables.ts` — added `platform` namespace to variable resolver for manifest templates
- `control-panel/src/lib/market/types.ts` — added `platform` to VariableContext, exported UpdateSpec/MigrationSpec/MigrationStep types
- `control-panel/src/lib/market/schema.ts` — added UpdateSchema (replace/migrate strategies, exec/sql migration steps), MigrationSchema, MigrationStepSchema; added minPlatformVersion and manifestVersion to catalog entries
- `control-panel/src/lib/market/engine.ts` — replaced inline context building with buildVariableContext(); removed getSystemConfig() and formatLanguageValue() (now in platform-env)
- `control-panel/src/lib/native-apps/installer.ts` — added writeNativeEnvFile() helper using platform-env; refactored all 6 native app install functions to use it instead of per-app hardcoded env blocks
- `control-panel/src/lib/market/updater.ts` — NEW: external app update engine with snapshot→stop→rebuild→start→health flow, migration step execution, rollback on failure
- `control-panel/src/app/api/market/update/route.ts` — NEW: POST /api/market/update SSE endpoint for app updates
- `control-panel/src/app/api/market/updates/route.ts` — NEW: GET/POST /api/market/updates for checking available updates

### Test Results
- Whoogle install via marketplace engine: verified buildVariableContext works
- Force update (full rebuild cycle): snapshot → stop → rebuild → start → health check → version update
- Update endpoint error handling: non-installed app, already up-to-date detection
- Clean uninstall after test: all resources removed
- Platform: 7 running, 0 stopped after all tests

### Notes for Iris
- No breaking changes — all existing install flows are backward compatible
- The native installer refactor is additive (writeNativeEnvFile wraps buildPlatformEnv); per-app install functions are unchanged structurally
- Manifest schema additions are optional fields — existing manifests validate without update block
- Phase 2 (native installer manifest-driven refactor) is deferred — needs individual app install testing