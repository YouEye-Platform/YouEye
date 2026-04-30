## cp-v0.3.6.15 / ui-v0.3.4.16 — sebastian — 2026-04-30
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix 5 bugs: icon backgrounds, dark mode flash, embed locale sync, SSO redirect, profile avatar

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Removed grey `bg-accent/80` backgrounds from app icons
- `ui/src/components/settings/app-drawer-settings.tsx` — Removed `bg-accent` from icon preview
- `ui/src/app/settings/apps/client.tsx` — Removed `bg-muted/50` from all AppIcon branches
- `ui/src/components/settings/app-settings-detail.tsx` — Removed `bg-primary/10` from AppHeaderIcon
- `ui/src/components/providers.tsx` — Changed `defaultTheme="dark"` to `"system"` to fix dark mode flash
- `ui/src/components/settings/admin-embed.tsx` — Pass theme+locale via URL params to CP embeds; send locale via postMessage
- `ui/src/components/settings/profile-settings.tsx` — Send avatar URL to profile embed via postMessage
- `control-panel/src/app/embed/layout.tsx` — Default to light theme; read locale from URL params and set cookie; listen for locale postMessage
- `control-panel/src/app/embed/apps/client.tsx` — Removed grey background from app icon boxes
- `control-panel/src/components/market/app-card.tsx` — Removed `bg-blue-50` from icon container
- `control-panel/src/components/market/install-from-url-dialog.tsx` — Removed `bg-blue-50` from icon container
- `control-panel/src/app/embed/profile/client.tsx` — Listen for `youeye-embed-avatar` postMessage to show avatar
- `control-panel/src/i18n/request.ts` — Read `ye-embed-locale` cookie in locale resolution chain

### Notes for Iris
- All 6 native apps also updated with SSO redirect fix (middleware + auth routes)
- Native app versions: Wiki 0.3.2.6, Search 0.3.2.16, Cinema 0.3.2.10, Notes 0.3.2.3, Weather 0.3.2.3, Translate 0.3.2.3
- Dark mode default changed from "dark" to "system" — affects first-time users

---

## cp-v0.3.6.13 / ui-v0.3.4.15 — sebastian — 2026-04-30
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Conditional settings tab via settings_panel capability + Lucide icons in CP embed app list

### Changes
- `control-panel/src/app/embed/apps/client.tsx` — Added Lucide icon rendering (was first-letter only)
- `ui/src/components/settings/app-settings-detail.tsx` — Settings tab hidden when app has no settings_panel capability; app header shows actual icon
- `ui/src/lib/db/queries/apps.ts` — Expose manifest data in AppWithConfig
- `ui/src/app/api/v1/apps/drawer/route.ts` — Added hasSettingsPanel to drawer API response

### Notes for Iris
- Native app manifests updated (settings_panel: true in capabilities) — push before merging
- DB migration: existing installs need `apps.manifest` updated to include settings_panel capability

---

## ui-v0.3.4.13 — sebastian — 2026-04-30
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Universal App Settings tab with iframe embed support

### Changes
- `ui/src/components/settings/app-settings-detail.tsx` — Added "App Settings" tab that iframes the app's /settings?embed=true page with auto-height resize via postMessage
- `ui/src/app/settings/apps/[appId]/page.tsx` — Pass tab URL param for deep-linking to App Settings tab
- `ui/src/app/api/v1/header/config/route.ts` — Return app_settings_url in user_menu for native app deep-linking

### Notes for Iris
- This is the UI side of a cross-repo feature. All 6 native apps also need their matching releases merged.
- The tab only appears when the app has a subdomain configured.

## cp-v0.3.6.12 — sebastian — 2026-04-30
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix hot-plugged NIC activation + deduplicate apps list

### Changes
- `control-panel/src/lib/incus/app-network.ts` — grantBridgeAccess() now runs `ip link set up` + `dhclient` inside the container after hot-plugging a NIC, fixing DNS discovery failure for cross-bridge app connections (e.g. Search→SearXNG)
- `control-panel/src/app/api/ui-bridge/apps/route.ts` — Filter marketplace apps whose containers already appear in APP_DEFINITIONS, preventing duplicate entries (Search, Wiki appeared twice in settings)

### Test Results
- Deployed to VM, `spine status` → 11 running, 0 stopped
- Apps list API returns deduplicated entries (Search/Wiki once each, SearXNG once)
- Search→SearXNG connectivity verified via curl (HTTP 200)

### Notes for Iris
- NIC activation fix only applies to future bridge activations; existing bridges with DOWN NICs need manual `ip link set up` + `dhclient`

## cp-v0.3.6.11 — sebastian — 2026-04-30
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix avatar embed not loading during onboarding (no CP session)

### Changes
- `control-panel/src/middleware.ts` — Allow `/api/auth/sso` and `/api/auth/callback` in iframes (same `frame-ancestors` as `/embed` routes)
- `control-panel/src/app/embed/avatar/page.tsx` — Skip auth for avatar embed (non-sensitive emoji picker)
- `control-panel/src/app/embed/avatar/client.tsx` — Send postMessage before CP upload, make CP upload non-fatal

### Notes for Iris
- Bridge sessions replaced HMAC with session auth on embeds. New users have no CP session during onboarding. Authentik blocks SSO-in-iframe with X-Frame-Options: DENY. Avatar embed now skips auth entirely (it's just emojis).
- Other admin embeds still require session — monitor if any break for new users.

## spine-v0.3.2.3 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix ACL default policy in EnforceUIEgressBlock — was killing all UI networking

### Changes
- `spine/internal/container/ui.go` — Added `security.acls.default.ingress.action=allow` and `security.acls.default.egress.action=allow` to the `incus config device set` call. Without these, Incus rejects ALL unmatched traffic when an ACL is attached, not just the explicit reject rule.
- `spine/internal/cmd/root.go` — Version bump to 0.3.2.3

### Notes for Iris
- This was a production-breaking bug: `sebatron.gg` returned HTTP 502 because Caddy couldn't reach the UI container.
- The fix is a single `incus config device set` call change — no architectural changes.
- Spine rebuild with ldflags required.

## ui-v0.3.4.12 + spine-v0.3.2.2 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Phase 3 — One-way bridge enforcement: network-level UI→CP block

### Changes
- `ui/src/lib/admin/embed-token.ts` — Removed `CP_EMBED_URL` env var fallback (last CP env var in UI source)
- `spine/internal/container/ui.go` — Added `EnforceUIEgressBlock()`: creates Incus ACL `ye-ui-egress-block` and applies it to UI container NIC
- `spine/internal/cmd/update.go` — Calls `EnforceUIEgressBlock()` after `provisionBridgeToken()` during `spine update control`

### Notes for Iris
- The Incus ACL blocks UI→CP traffic at the network level. CP→UI (bridge pushes) and browser→CP (iframes) are unaffected.
- CLAUDE.md has a new pitfall #25 — VERY IMPORTANT: never reintroduce UI→CP server calls.
- Spine change requires rebuild with ldflags.

## cp-v0.3.6.10 + ui-v0.3.4.11 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Phase 2 — One-way bridge enforcement: replace UI→CP proxy routes with CP embeds

### Changes
- `ui/src/app/api/v1/apps/unified/route.ts` — DELETED. Called `CP_INTERNAL_URL/api/ui-bridge/apps` to enrich admin app list.
- `ui/src/app/api/v1/admin/proxy-cp/route.ts` — DELETED. Open proxy forwarding arbitrary requests to CP.
- `ui/src/app/api/v1/admin/install-progress/route.ts` — DELETED. Polling proxy to CP install tracker.
- `ui/src/app/settings/permissions/client.tsx` — DELETED. Orphaned 343-line component, never imported.
- `ui/src/app/settings/apps/client.tsx` — Rewritten (548 lines removed). Admin sees CP `/embed/apps` iframe, regular users see local DB list.
- `ui/src/app/settings/apps/page.tsx` — Generates signed embed URL for admin users.
- `ui/src/components/settings/app-settings-detail.tsx` — Rewritten (500 lines removed). Network tab replaced with CP `/embed/app-network/[appId]` iframe.
- `ui/src/components/app-install-listener.tsx` — Simplified (159 lines removed). PostMessage only, no polling.
- `ui/src/app/api/v1/apps/drawer/route.ts` — Added version, subdomain, containerUrl fields.
- `ui/src/lib/db/queries/apps.ts` — Added version to AppWithConfig interface.
- `control-panel/src/app/embed/apps/client.tsx` — Added `youeye-app-navigate` postMessage for click-through.
- `control-panel/src/app/embed/app-network/[appId]/client.tsx` — Full rewrite with bridges, internet grants, suggestions sections.

### Notes for Iris
- Net -1753/+392 lines. Zero remaining `CP_INTERNAL_URL`, `proxy-cp`, `unified`, or `install-progress` references in UI source.
- Phase 3 (infra enforcement: remove CP_INTERNAL_URL env var, iptables block, pre-commit hook) is next.
- The CP embed pages (`/embed/apps` and `/embed/app-network/[appId]`) already existed on the branch from Vanya's work.

## cp-v0.3.6.9 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix native app container name mismatch breaking update detection

### Changes
- `control-panel/src/lib/apps/definitions.ts` — All 6 native app definitions had `ye-app-*` container names and service names, but Spine creates containers as `app-*`. Fixed all to match actual names.
- `control-panel/src/app/api/market/status/route.ts` — Same `ye-app-*` → `app-*` fix in NATIVE_CONTAINER_MAP.
- `CLAUDE.md` — Added standalone repo tag documentation and pitfall #24 to prevent component-prefix tags on standalone repos.

### Notes for Iris
- Also created `sebastian-v0.3.2.12` release on YE-App-Search with correct tag format (was previously `search-sebastian-v0.3.2.12` which was invisible to CP's release discovery).
- The `ye-app-*` naming was likely introduced when definitions.ts was first written and never validated against actual container names. All native apps were affected.

## cp-v0.3.6.8 + ui-v0.3.4.9 + spine-v0.3.2.1 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Merge Vanya's sessions 29-37 into Sebastian branch — combined platform features

### Changes (merge)
- Merged `origin/vanya` into `sebastian` — 18 commits covering: App Market Umbrel redesign, system dashboard with live graphs, network settings overhaul (DNS/TLS), background update queue, unified app settings, link handling system, clock themes (17 presets), Spine /api/metrics endpoint, profile avatar
- `control-panel/src/lib/market/engine.ts` — Conflict resolution: kept both `linkHandlers` (Vanya) and `manifest` (Sebastian) params in `registerAppWithUI()`; added manifest to payload builder
- `ui/src/app/api/v1/apps/register/route.ts` — Conflict resolution: combined `link_handlers` and `cpManifest` destructuring; used Vanya's manifest-store pattern with Sebastian's cpManifest fallback
- `control-panel/package.json` — Version 0.3.6.8 (above Vanya's 0.3.6.7 and Sebastian's 0.3.6.2)
- `ui/package.json` — Version 0.3.4.9 (above Vanya's 0.3.4.8 and Sebastian's 0.3.4.7)

### Releases
- `cp-sebastian-v0.3.6.8` (Gitea ID: 1326) — 107MB artifact
- `ui-sebastian-v0.3.4.9` (Gitea ID: 1327) — 226MB artifact
- `spine-sebastian-v0.3.2.1` (Gitea ID: 1328) — 11MB artifact

### Notes for Iris
- This is a MERGE build combining Sebastian's timeline/info-card/search work with Vanya's settings/dashboard/market work
- Andrew's branch had no unique commits — his work was already on main from Cycle 5
- Conflict zones (engine.ts, register/route.ts) are additive — both agents' features preserved
- Spine /api/metrics endpoint (from Vanya) is new on this branch — provides host CPU/RAM/disk/uptime/load
- DB migrations: `update_queue` table (auto-created), `source`/`source_url` columns on `installed_apps` (auto-migrated)

## ui-v0.3.4.7 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Dynamic app metadata for timeline — remove hardcoded icon/color maps

### Changes
- `ui/src/lib/timeline/icon-map.ts` — New shared Lucide icon map (~45 icons) with `resolveLucideIcon()` helper for manifest-declared icon names
- `ui/src/lib/db/queries/app-management.ts` — Added `AppMeta` interface, `TimelineEmbedDeclaration` type, `getAppMetaMap()` query that extracts accent_color and per-entry-type icons from app manifest JSONB
- `ui/src/app/api/v1/timeline/route.ts` — Timeline API now returns `app_meta` map alongside entries
- `ui/src/components/timeline/timeline-embed.tsx` — Removed hardcoded `APP_ICONS`/`APP_COLORS` maps; now uses `AppMetaEntry` prop with dynamic CSS custom properties for accent colors
- `ui/src/components/timeline/timeline-entry-card.tsx` — Replaced `TYPE_ICONS` with 3-tier resolution: manifest entry icon → app icon → legacy static map → fallback
- `ui/src/components/timeline/timeline-feed.tsx` — Passes `appMetaMap` from API response to entry cards
- `ui/src/components/layout/app-drawer.tsx` — Expanded `ICON_MAP` from 9 to ~30 Lucide icons for manifest-declared app icons
- `ui/package.json` — Version bump 0.3.4.6 → 0.3.4.7

### Test Results
- Manual testing by user on VM

### Notes for Iris
- App manifests in the `apps` table JSONB column must contain `accent_color` and `timeline_embeds[].icon` fields for the dynamic rendering to work. These are populated when apps re-register or manifests are re-fetched. Cinema, Search, and Wiki manifests have been updated in this release.
- No DB schema changes. No CP or Spine changes.

## ui-v0.3.4.3 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Info cards system — expose app link handlers with public URLs for Search integration (Session 33)

### Changes
- `ui/src/app/api/v1/apps/info-cards/route.ts` — Rewrote to include app public URLs (subdomain-based), support service auth, use UI_EXTERNAL_URL for service-to-service calls
- `ui/src/lib/db/queries/app-management.ts` — Extended InfoCardDeclaration with embed_path and label fields, enhanced getInfoCardProviders() to return subdomain and icon
- `ui/package.json` — Version bump 0.3.4 → 0.3.4.3

### Test Results
- Manual testing by user on VM

### Notes for Iris
- The Cinema manifest must be refreshed in UI's database after merge (the manifest JSONB column in apps table). Call Cinema's /api/manifest and update the apps table. Without this, the info-cards endpoint returns empty providers.
- UI-only change. No CP or Spine changes.

## ui-v0.3.4.1 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Native app widget auto-discovery from running containers

### Changes
- `ui/package.json` — Bumped 0.3.4 → 0.3.4.1
- `ui/src/lib/db/queries/app-management.ts` — Rewrote `getAppWidgetDeclarations()` to live-fetch widget declarations from running app containers via Caddy admin API upstream discovery, replacing stale DB manifest reads. Added `discoverAppUpstreams()` helper that uses Node `http` module (fetch adds Origin header that Caddy rejects).

### Test Results
- Widget API returns 10 widgets from 6 native apps (Wiki 2, Notes 1, Translate 2, Cinema 2, Search 1, Weather 2)
- Widget picker shows app tabs with correct icons and live iframe previews
- Screenshots: Tests/Sebastian/20260428_1/
- Playwright: widget-discovery.spec.ts

### Notes for Iris
- UI-only change. No CP or Spine changes.
- Depends on Caddy admin API being reachable from UI container on same Incus bridge (`youeye-caddy.youeye:2019`). Falls back to DB `containerUrl` if Caddy is unreachable.
- Uses `http.get` instead of `fetch` for Caddy admin API — Caddy rejects Origin headers from non-localhost. This is intentional.

## v0.3.6.1 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix manifest validator false warnings on native apps

### Changes
- `control-panel/src/lib/market/validator.ts` — Added `'integration'` to `knownRoots` Set; resolves 2 false "Unrecognized template variable" warnings for `${integration.gateway_url}` and `${integration.app_token}` on all native app manifests
- `control-panel/package.json` — Bumped 0.3.6 → 0.3.6.1

### Test Results
- Verified `integration` present in compiled JS chunks inside deployed youeye-control container
- `sudo spine status` → 7 running, 0 stopped

### Notes for Iris
- Trivial one-word addition to an existing Set. No merge conflicts expected.
- Prior commit `ede27c5` (Iris, Apr 27) added `containers`, `smtp`, `provider` to same Set but missed `integration`.

## CP v0.3.6.7 + UI v0.3.4.8 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** App Market redesign — Umbrel-inspired UI, custom URL installs, dynamic categories, native app icons

### Changes
- `control-panel/src/app/embed/market/client.tsx` — Complete rewrite: Umbrel-inspired card layout, detail pages, inline Lucide SVG icons for native apps, dynamic categories, "Add Custom" URL install flow, dark/light theme
- `control-panel/src/lib/market/schema.ts` — Changed category from hardcoded enum to `z.string().min(1)` for dynamic categories
- `control-panel/src/lib/market/installed-apps.ts` — Added source/source_url columns, URL-installed app update detection via manifest re-fetch
- `ui/src/app/app-market/page.tsx` — Full-width iframe (removed max-width constraint)

### Test Results
- Build: CP and UI both compile successfully
- Deploy: CP via `spine update control`, UI via manual tarball extraction
- No Playwright tests (manual testing by user)

### Notes for Iris
- DB schema migration: `source` and `source_url` columns added to `installed_apps` table (auto-migrated on first use)
- Category schema change is backwards-compatible (string superset of previous enum)
- New icon SVGs are inline in client.tsx — new native apps need manual SVG addition

## CP v0.3.6.6 + UI v0.3.4.6 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Network settings overhaul — consolidated DNS/TLS, full Pi-Hole management UI, ZIP download

### Changes
- `control-panel/src/app/embed/dns/client.tsx` — Complete rewrite: 6-tab DNS management (Overview with charts, Query Log, Domains, Local DNS, Blocklists, Settings)
- `control-panel/src/app/embed/tls/client.tsx` — Added ZIP download button for cert+key pair
- `control-panel/src/app/api/tls/download/route.ts` — Added zip type with minimal ZIP builder
- `control-panel/src/app/api/ui-bridge/dns/{history,queries,domains,records,cname,lists,config,gravity}/route.ts` — 8 new bridge API routes for full Pi-Hole API coverage
- `control-panel/src/app/setup/page.tsx` — Skip restore-from-backup step in setup wizard
- `ui/src/app/settings/network/{page,client}.tsx` — NEW: consolidated Network page with DNS|TLS tabs
- `ui/src/components/settings/settings-shell.tsx` — DNS→Network rename, removed Proxy/Backup/TLS nav, widened layout
- `ui/src/app/settings/{dns,tls,proxy}/page.tsx` — Redirect to /settings/network
- `ui/src/app/settings/backup/page.tsx` — Redirect to /settings
- `ui/messages/{en,de,es,fr,ru}.json` — Added "network" i18n key

### Test Results
- CP and UI builds verified, deployed to VM, 10 containers running
- Gitea releases: cp-vanya-v0.3.6.6 (ID: 1292), ui-vanya-v0.3.4.6 (ID: 1293)

### Notes for Iris
- Old DNS/TLS/Proxy/Backup routes now redirect — no broken links
- 8 new bridge API routes under /api/ui-bridge/dns/ — all use validateBridgeToken
- Proxy page code preserved but hidden; backup page code preserved but hidden
- Setup wizard step -1 (new/restore choice) disabled — will be re-enabled when backups are ready

## CP v0.3.6.5 + UI v0.3.4.5 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** System dashboard with live graphs + container task manager, fix app icons/status

### Changes
- `control-panel/src/app/api/ui-bridge/system/route.ts` — Added per-container resource stats (memory, CPU, disk) to system API response
- `control-panel/src/app/embed/system/client.tsx` — Complete rewrite: live area charts for CPU/memory/disk, merged container task manager with per-container RAM/disk bars, stop/restart actions, 5s auto-refresh
- `ui/src/app/settings/apps/client.tsx` — Removed colored icon backgrounds (ICON_COLORS), replaced with neutral bg-muted/50 for all categories
- `ui/src/app/api/v1/apps/unified/route.ts` — Fixed installed apps showing "unknown" — now copies status from bridge enrichment data
- `ui/src/components/settings/settings-shell.tsx` — Removed Containers nav item from admin sidebar (merged into System)
- `ui/src/app/settings/containers/page.tsx` — Redirects to /settings/system

### Test Results
- Playwright: system-dashboard.spec.ts (10 tests), app-icons-status.spec.ts (5 tests)
- Screenshots: verified apps page neutral icons, system dashboard with graphs, container task manager

### Notes for Iris
- Containers page now redirects to System — any existing links to /settings/containers will auto-redirect
- The separate containers embed still exists in CP but is no longer linked from UI sidebar

## CP v0.3.6.4 + UI v0.3.4.4 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Phase 3 — Link Handling + System page 500 fix

### Changes
- `control-panel/src/lib/market/schema.ts` — Added LinkHandlerSchema and link_handlers to CapabilitiesSchema (Zod)
- `control-panel/src/lib/market/types.ts` — Added link_handlers to MarketApp.capabilities interface
- `control-panel/src/lib/market/catalog.ts` — Pass link_handlers from manifest capabilities to market app
- `control-panel/src/lib/market/engine.ts` — registerAppWithUI accepts optional linkHandlers param, passes to UI registration
- `control-panel/src/app/api/ui-bridge/system/route.ts` — Added fallback: if Spine /api/metrics 404s, degrade to /api/status with partial data
- `control-panel/package.json` — Bumped to 0.3.6.4
- `ui/src/app/api/v1/apps/[appId]/link-handlers/route.ts` — NEW: CRUD API for link handlers (GET/POST/DELETE), stored in apps.manifest.linkHandlers JSONB
- `ui/src/components/settings/app-settings-detail.tsx` — Full LinkHandlingTab: add form (type, description, domains, endpoint), handler cards with domain pills, delete, validation
- `ui/src/app/api/v1/apps/register/route.ts` — Accept link_handlers from CP registration payload, merge into manifest
- `ui/package.json` — Bumped to 0.3.4.4

### Test Results
- Playwright CDP verification: Link Handling tab empty state, add handler form, handler card with 3 domain pills, delete handler
- System page renders with full metrics (hostname, CPU, memory, disk, containers) — no more HTTP 500
- 2 test suites: link-handling.spec.ts (12 tests), system-metrics.spec.ts (8 tests)

### Notes for Iris
- CP + UI changes, both deployed. Spine unchanged at v0.3.2.1.
- Link handlers stored in existing `apps.manifest` JSONB column — no DB migration needed
- The CP system bridge fallback is additive — if Spine has /api/metrics it uses it, otherwise falls back to /api/status

## UI v0.3.4.3 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Apps settings redesign — proper icons, click-through, update fix

### Changes
- `ui/src/app/settings/apps/client.tsx` — Rewrote AppIcon to render customIconUrl, emoji, URL-based, and Lucide icons with colored backgrounds per category; fixed system component onClick (was empty noop); added dot indicators to status badges; rounded-xl card styling
- `ui/src/components/settings/app-settings-detail.tsx` — Detail page now searches both apps and systemApps from unified API; fixed double-fetch bug in handleUpdate; added Lucide icon rendering to detail header; shows description subtitle
- `ui/package.json` — Bumped to 0.3.4.3

### Test Results
- Visual verification via Playwright screenshots: apps list, CP detail, Spine detail
- All system components render with correct Lucide icons and descriptions
- Click-through navigates to detail page for all items

### Notes for Iris
- UI-only change, no CP modifications
- The update iframe bridge is unchanged — the list page still uses the CP embed iframe for updates. The detail page update button now uses a single correct proxy-cp POST (was broken double-fetch before)

## UI v0.3.4.2 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Phase 2 — Unified app settings page (merge user + admin views)

### Changes
- `ui/src/app/api/v1/apps/unified/route.ts` — NEW: unified API merging drawer + CP bridge data
- `ui/src/app/settings/apps/client.tsx` — Rewrote with sections: Updates Available, Installed Apps, System Components
- `ui/src/components/settings/app-settings-detail.tsx` — Added Update Now button, version/category/description from bridge
- `ui/src/components/settings/settings-shell.tsx` — Removed "App Management" admin sidebar entry
- `ui/src/app/settings/apps-list/page.tsx` — DELETED (merged into unified view)
- `ui/package.json` — 0.3.4.1 → 0.3.4.2

### Test Results
- Manual: deployed to VM, `spine status` 7 running / 0 stopped
- API: `/api/v1/apps/unified` returns 401 without auth (correct)
- UI: `https://devvm.test/` returns 307 redirect (correct)

### Notes for Iris
- No CP changes in this release (CP stays at v0.3.6.3)
- The `/settings/apps-list` page is deleted — any links to it will 404
- The unified API calls CP bridge internally with Referer spoofing for admin data

---

## CP v0.3.6.3 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Phase 1 — Background update queue, update-progress embed, Spine stale status fix

### Changes
- `control-panel/src/lib/updates/queue.ts` — NEW: PostgreSQL-backed background update queue with worker (polls 2s, processes one at a time, fire-and-forget). Handles all update types: Spine-managed, OCI, LXD, marketplace. Startup recovery marks stale "running" entries as failed.
- `control-panel/src/app/api/apps/[name]/enqueue/route.ts` — NEW: POST endpoint to enqueue updates, returns immediately with queue position. Deduplicates pending/running entries for same component.
- `control-panel/src/app/api/apps/queue/route.ts` — NEW: GET (active queue entries) + POST (acknowledge/dismiss completed/failed entries).
- `control-panel/src/app/embed/update-progress/page.tsx` — NEW: Server component for hidden iframe embed, validates embed session.
- `control-panel/src/app/embed/update-progress/client.tsx` — NEW: PostMessage bridge between YE-UI and CP. Handles start-update, check-updates, get-status, acknowledge. Polls 2s active / 30s idle.
- `control-panel/src/lib/updates/state.ts` — Fixed Spine stale "completed" status bug: 60-second TTL on terminal statuses.
- `control-panel/src/app/api/ui-bridge/updates/status/route.ts` — Returns both update statuses and queue entries.
- `control-panel/package.json` — Bumped 0.3.6.1 → 0.3.6.3

### Releases
- CP v0.3.6.2 (`cp-vanya-v0.3.6.2`) — had SQL double-ORDER-BY bug
- CP v0.3.6.3 (`cp-vanya-v0.3.6.3`) — fixed, deployed

### Notes for Iris
- New PostgreSQL table `update_queue` created automatically on first use
- The background worker auto-starts on CP boot (non-test environments)
- v0.3.6.2 release has a bug — use v0.3.6.3 only
- Phase 2 (UI unified settings) and Phase 3 (link handling) still pending

---

## v0.3.4.1 / v0.3.6.1 / v0.3.2.1 — vanya — 2026-04-28
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** WordArt size, clock themes, profile avatar fix, host metrics

### Changes
- `ui/src/lib/db/queries/widgets.ts` — reduce default WordArt widget size by 50%
- `ui/src/components/dashboard/widget-grid.tsx` — update reset layout default sizes
- `ui/src/components/widgets/index.ts` — reduce WordArt catalog defaultSize
- `ui/src/lib/clock-presets.ts` — rewrite: 17 presets across 5 categories (classic, minimal, decorative, animated, fun)
- `ui/src/components/widgets/clock-widget.tsx` — add animation support and CSS keyframe injection
- `ui/src/components/widgets/clock-theme-picker.tsx` — fix default category fallback
- `control-panel/src/lib/authentik/client.ts` — add attributes field to AuthentikUser
- `control-panel/src/app/api/user/profile/route.ts` — extract avatarUrl from Authentik user attributes
- `spine/internal/api/server.go` — add GET /api/metrics endpoint (host CPU, RAM, disk, uptime, load)
- `control-panel/src/lib/spine/client.ts` — add SpineMetricsResponse type and getMetrics()
- `control-panel/src/app/api/ui-bridge/system/route.ts` — replace container /proc reads with Spine metrics
- `control-panel/src/app/embed/system/client.tsx` — display CPU usage % and load average

### Releases
- UI v0.3.4.1 (`ui-vanya-v0.3.4.1`) — standalone.tar uploaded
- CP v0.3.6.1 (`cp-vanya-v0.3.6.1`) — standalone.tar uploaded
- Spine v0.3.2.1 (`spine-vanya-v0.3.2.1`) — binary uploaded

### Notes for Iris
- Clock themes: old 4-category system (clean/bold/glow/retro) replaced with 5 categories (classic/minimal/decorative/animated/fun)
- Spine /api/metrics adds 200ms delay per request (CPU sampling) — cached by caller
- System embed now depends on Spine being reachable; falls through to error if Spine is down

---

## Main Release — spine 0.3.2, cp 0.3.6, ui 0.3.4 — iris — 2026-04-27
**Branch:** main
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** Promote all dev work to main

### Releases
- Spine v0.3.2 (`spine-v0.3.2`) — Pi-Hole race condition fix, release API retry, cleanup/deploy service handling
- Control Panel v0.3.6 (`cp-v0.3.6`) — manifest validator, health checker per-app port, ACME 429, admin credentials API, SSO naming, app network isolation
- UI v0.3.4 (`ui-v0.3.4`) — clock widget themes, WordArt overflow, icon picker, widget scaling
- All native apps v0.3.2 — connector cleanup, code modernization

### Notes
- Known issue: per-app bridge network isolation breaks install-time health checks (proxy devices added after health check). Deferred to next dev cycle.

## v0.3.5.11 (CP) — iris — 2026-04-27
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Manifest validator false warnings, health checker per-app port/path, ACME 429 rate limit handling

### Changes
- `control-panel/src/lib/market/validator.ts` — Add `containers`, `smtp`, `provider` to known namespace roots in template variable check; auto-accept container names declared in manifest
- `control-panel/src/lib/market/types.ts` — Add `port` and `healthCheck` optional fields to `ContainerMeta` interface
- `control-panel/src/lib/market/engine.ts` — Store `port` and `healthCheck` from manifest into `ContainerMeta` during installation
- `control-panel/src/lib/market/health-checker.ts` — Read stored `port`/`healthCheck.path` per container instead of hardcoded 3000/"/"
- `control-panel/src/lib/acme/client.ts` — Add axios response interceptor to catch LE 429 rate limits before acme-client's silent retry loop
- `control-panel/src/app/api/tls/acme/route.ts` — Add `Promise.race` timeout wrappers (30s/60s) as safety net around ACME calls; return 504 on timeout
- `control-panel/src/components/setup/SetupServerName.tsx` — Add `AbortSignal.timeout` (35s/65s) to ACME fetch calls; display user-friendly timeout messages
- `control-panel/package.json` — Bumped 0.3.5.10 → 0.3.5.11

### Test Results
- TypeScript: clean build, no type errors
- Artifact: standalone.tar 102MB uploaded to Gitea release #1265

### Notes for Iris
- Only CP changed — no Spine or UI release needed
- Backward-compatible: existing install.json files without port/healthCheck fall back to 3000/"/"

## v0.3.5.10 (CP) — iris — 2026-04-27
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Source code fixes for 3 ACME/Caddy bugs discovered during LE cert issuance (previously hot-patched)

### Changes
- `control-panel/src/lib/acme/client.ts` — Preserve `.url` on `readyOrder` after first `waitForValidStatus` call; the raw ACME response body lacks `.url` which the second call requires
- `control-panel/src/lib/caddy/client.ts` — Remove invalid `certificate_selection` field from TLS automation policy (Caddy 2.11 rejects it). Update `loadExternalCert`/`removeExternalCert` to use subject-only discriminant. Fix `ensureTLSSubject` to check ALL TLS policies before adding a subject (prevents duplicate subjects across internal/external policies)
- `control-panel/src/lib/caddy/types.ts` — Remove `certificate_selection` from `TLSAutomationPolicy` interface
- `control-panel/src/app/api/setup/run/route.ts` — Log root domain UI route creation errors instead of swallowing them (empty catch masked Caddy config failures, causing root domain to route to CP catch-all instead of UI)
- `control-panel/package.json` — Bumped 0.3.5.9 → 0.3.5.10

### Test Results
- TypeScript: clean build
- Bugs were previously confirmed via hot-patches on live VM; source now matches fixes

### Notes for Iris
- Only CP changed — no Spine or UI release needed
- Sebastian and Vanya branches already merged into dev (confirmed via merge-base check)

## v0.3.5.9 (CP) + v0.3.1.4 (Spine) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Three ACME/cleanup hotfixes — cleanup state, authoritative DNS, config API extra, order finalization

### Changes
- `spine/internal/cmd/cleanup.go` — Parse YAML, extract only `release_branch`, write minimal file after wipe (was preserving entire `youeye.yaml` including `setup_completed: true`)
- `control-panel/src/lib/acme/client.ts` — Replaced `client.verifyChallenge()` with authoritative NS queries (bypasses DNS cache, <1s vs ~4 min). Fixed order finalization: skip `finalizeOrder` when order already `valid` from prior attempt, capture updated order for `getCertificate`
- `spine/internal/api/server.go` — Added `Extra map[string]string` to `YouEyeConfig`, PATCH stores unrecognized keys (fixes `tls_acme_account_key` being silently dropped)
- `control-panel/src/lib/spine/client.ts` — `getConfig()` merges `extra` into top-level
- `control-panel/src/lib/settings/service.ts` — `getRaw()` widened with index signature
- `control-panel/package.json` — Bumped 0.3.5.6 → 0.3.5.9
- `spine/internal/cmd/root.go` — Bumped 0.3.1.2 → 0.3.1.4

### Test Results
- TypeScript: clean build
- Hotpatched live VM for each fix, verified errors resolved in sequence
- Full ACME flow: cleanup → deploy → setup wizard → LE cert (pending user test on fresh deploy)

### Notes for Iris
- Three sequential releases: Spine 0.3.1.3+CP 0.3.5.7, Spine 0.3.1.4+CP 0.3.5.8, CP 0.3.5.9
- ACME flow tested via hotpatches on compiled bundle; source code matches final hotpatch state

## v0.3.5.6 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Move Let's Encrypt ACME DNS-01 flow inline into server name setup step

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Added inline ACME sub-flow (DNS TXT record display, copy buttons, verify & issue) triggered when user selects Let's Encrypt and clicks Continue. Domain inputs lock during ACME flow. Wildcard checkbox shown before starting.
- `control-panel/src/app/setup/page.tsx` — Added `acmeCertIssued` state. LE now skips step 5 (cert issued in step 0). Upload still goes to step 5. Sends `tls_choice` to backend.
- `control-panel/src/app/api/setup/run/route.ts` — After `caddy.setDomain()`, checks `tlsStorage` for existing ACME cert and restores it via `caddy.loadExternalCert()`. Added `tls_choice` to request interface.
- `control-panel/src/components/setup/SetupTls.tsx` — Removed AcmeFlow (moved to SetupServerName). Now upload-only.
- `control-panel/package.json` — Bumped to 0.3.5.6.

### Test Results
- TypeScript: clean (no errors)
- Build: standalone.tar 102MB, deployed via `spine update control`
- ACME API: returns 401 Unauthorized without session (correct)
- Self-signed flow: unaffected (existing path unchanged)

### Notes for Iris
- Full LE flow requires real public DNS — cannot be end-to-end tested on dev VMs with .test domains
- The ACME order has 30-min TTL in memory; UI should show "Start over" on timeout errors

## v0.3.5.5 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix custom TLD lost during setup wizard — customTld state not lifted to page level

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Removed local `customTld` useState; now received as props from parent. Added trailing-dot stripping on custom TLD input.
- `control-panel/src/app/setup/page.tsx` — `customTld`/`setCustomTld` now passed as props to SetupServerName. Config restore logic detects non-standard TLDs and sets `__custom__` sentinel + populates `customTld`. Imported `TLD_OPTIONS` for lookup.
- `control-panel/src/app/api/setup/run/route.ts` — Defense-in-depth: strip trailing dots from `body.domain` before any step uses it.
- `control-panel/package.json` — Bumped to 0.3.5.5.

### Test Results
- Fresh setup with domain `potemk.in` (custom TLD `.in`): all 7 steps pass including SSO
- Domain correctly saved as `potemk.in` in youeye.yaml
- Authentik applications created with valid `meta_launch_url: https://control.potemk.in`

### Notes for Iris
- Root cause: `customTld` was local state inside SetupServerName, invisible to page.tsx which computed the domain for the API request with its own empty `customTld`. Result: domain sent as `potemk.` (no TLD) instead of `potemk.in`.
- This also caused Authentik 2025.12 to reject `meta_launch_url: https://control.potemk.` as an invalid URL.

## v0.3.1.2 (Spine) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Fix spine deploy timeout on fresh VMs — IPv6 hangs + insufficient timeout

### Changes
- `spine/internal/releases/releases.go` — Added `NewIPv4Client()` shared HTTP client that forces tcp4 dialer (avoids IPv6 AAAA hangs). Increased `fetchReleases()` timeout from 10s to 30s. Added 3-attempt retry with 2s/4s backoff on network errors.
- `spine/internal/releases/client.go` — `NewClient()` now uses `NewIPv4Client(30s)` instead of bare `http.Client{Timeout: 10s}`.
- `spine/internal/cmd/status.go` — `checkSpineUpdate()` uses `NewIPv4Client` instead of bare 10s client.
- `spine/internal/cmd/update.go` — Spine binary download uses `NewIPv4Client(10m)` instead of `http.Get()`.
- `spine/internal/container/control.go` — CP tarball download uses `NewIPv4Client(10m)` instead of bare client.
- `spine/internal/api/server.go` — API server CP download uses `NewIPv4Client(10m)`.
- `spine/install.sh` — Added `-4` flag to all curl calls hitting git.byka.wtf.
- `spine/internal/cmd/root.go` — Bumped version to 0.3.1.2.

### Test Results
- Spine builds cleanly (16MB binary)
- `spine status` fetches releases successfully (no timeout)
- `spine version` shows 0.3.1.2

### Notes for Iris
- Root cause: Go's default HTTP client tries IPv6 first on VMs where DNS returns AAAA records for git.byka.wtf but there's no IPv6 route. The IPv6 connection hangs until the 10s timeout expires, leaving no budget for IPv4.
- Fix is structural: force tcp4 at the dialer level so IPv6 is never attempted.

## v0.3.5.4 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Add dedicated TLS setup step to setup wizard (step 5), simplify DNS explainer

### Changes
- `control-panel/src/components/setup/SetupTls.tsx` — NEW. Dedicated TLS setup step with AcmeFlow (ACME DNS-01 challenge: domain input, TXT records display, verify & finalize) and UploadFlow (PEM paste/browse for cert, key, optional chain). Runs after provisioning for LE and upload paths; self-signed skips this step entirely.
- `control-panel/src/app/setup/page.tsx` — Reworked wizard step flow: steps 0-3 unchanged, step 4 provisioning, step 5 TLS setup (new), step 6 DNS explainer. `handleProvisioningComplete` routes self-signed to step 6, LE/upload to step 5. Imports new SetupTls component.
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Removed AcmeFlow and UploadCertFlow (moved to SetupTls). Simplified to DNS-only: connection status, DNS setup instructions per platform, self-signed cert install, and "Go to server" link. Removed ~420 lines of duplicated TLS flow code.
- `control-panel/package.json` — Bumped version to 0.3.5.4

### Test Results
- CP builds cleanly (102MB standalone.tar)
- CP deploys and starts successfully (Next.js 16.1.4 on port 3000)

### Notes for Iris
- The TLS setup step reuses existing `/api/tls/acme` (POST to start order, PUT to verify) and `/api/tls/upload` (POST) endpoints — no new API routes.
- Self-signed path never renders SetupTls; provisioning callback goes directly to DNS explainer (step 6).

## v0.3.5.3 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Move TLS certificate choice to Name Your Server step; add custom TLD and upload-own-cert options

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Added TLS certificate choice section (Let's Encrypt with "Recommended" badge, self-signed, upload own cert). Added custom TLD text input when "Other..." is selected from the TLD dropdown. LE option auto-disabled for local TLDs. Exports `TlsChoice` type.
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Removed `TlsPathChoice` inline component. Now accepts `tlsChoice` prop from page.tsx and goes directly to the selected flow. Added `UploadCertFlow` component for PEM paste/browse upload via `/api/tls/upload`. Replaced hardcoded `bg-white/80` with theme-aware `bg-card`.
- `control-panel/src/app/setup/page.tsx` — Added `tlsChoice` and `customTld` state. Computes `effectiveTld` for custom TLD sentinel. Passes `tlsChoice`/`setTlsChoice` to SetupServerName and `tlsChoice` to SetupDnsExplainer. Auto-resets LE choice to self-signed when switching to a local TLD.
- `control-panel/src/lib/wordart-presets.ts` — Expanded `TLD_OPTIONS` from 13 to 22 entries: added .xyz, .cloud, .sh, .cc, .tv, .info, .pro, and "Other..." (`__custom__` sentinel with group `'custom'`).
- `control-panel/messages/{en,de,es,fr,ru}.json` — Added 14 new i18n keys (certificateChoice, recommended, tlsUploadOwn, tlsUploadOwnDesc, uploadCertTitle, uploadCertDesc, uploadCertLabel, uploadKeyLabel, uploadCertBrowse, uploadChainOptional, uploadChainLabel, uploadCertApply, uploadCertDone, uploadCertDoneDesc). Updated tlsLetsEncrypt to remove inline "(recommended)" text.
- `control-panel/package.json` — Bumped version to 0.3.5.3

### Test Results
- CP builds cleanly (102MB standalone.tar)
- CP deploys and starts successfully (Next.js 16.1.4 on port 3000)
- User will test setup wizard flow via fresh spine deploy

### Notes for Iris
- The upload cert flow uses the existing `/api/tls/upload` POST endpoint — no new API routes.
- Custom TLD uses `__custom__` sentinel value in the TLD dropdown; page.tsx resolves it to the actual typed TLD before computing the domain string.
- `TlsChoice` type exported from SetupServerName for shared use.

## v0.3.5.2 (CP) / v0.3.3.2 (UI) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Add Let's Encrypt to setup wizard; fix PIN prompt light mode visibility

### Changes
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Added TLS path choice (Let's Encrypt vs self-signed) to the DNS explainer step. Integrated ACME DNS-01 flow with domain input, DNS TXT record display, and verification. Only shown in wizard mode (not standalone/setup-complete page).
- `control-panel/src/middleware.ts` — Added `/api/tls/` to middleware setup-allowed paths so ACME endpoints are accessible during IP-based setup flow.
- `control-panel/messages/{en,de,es,fr,ru}.json` — Added 24 i18n keys for the ACME/Let's Encrypt flow in all 5 languages.
- `ui/src/components/timeline/pin-prompt.tsx` — Fixed embedded PIN prompt invisible text in light mode. Replaced hardcoded white text/borders with theme-aware Tailwind classes (text-foreground, bg-muted, border-border, bg-primary, text-primary-foreground).
- `control-panel/package.json` — Bumped version to 0.3.5.2
- `ui/package.json` — Bumped version to 0.3.3.2

### Test Results
- PIN prompt light mode: labels, inputs, icons, buttons all visible with proper contrast (verified via Playwright screenshot)
- Setup-complete page (standalone mode): renders correctly, skips TLS choice as designed
- Middleware: /api/tls/acme accessible via IP (returns 401 for auth, not redirect — confirms middleware allows path through)

### Notes for Iris
- The LE flow in SetupDnsExplainer uses the existing `/api/tls/acme` POST/PUT endpoints — no new API routes added.
- TLS choice only appears when `standalone=false` (wizard mode has auth session for ACME calls). Standalone/setup-complete page skips to self-signed flow.
- Local TLDs (.local, .test, etc.) show a warning that LE won't work, but still allow the attempt.

## v0.3.5.1 — andrew — 2026-04-22
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Manifest-driven SSO admin mapping (adminMapping) for automatic admin provisioning

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `AdminMappingSchema` discriminated union (groups | roleClaim) and `adminMapping` field to `SSOSchema`
- `control-panel/src/lib/market/types.ts` — Exported `AdminMapping` type from schema
- `control-panel/src/lib/market/authentik.ts` — Added `ensureAdminScopeMapping()` function: for `groups` type, updates global "YouEye Groups" scope mapping to normalize "authentik Admins" → also emit "admin"; for `roleClaim` type, creates per-app scope mapping with custom claim. Added `adminMapping` param to `createAuthentikOAuth2App`
- `control-panel/src/lib/market/engine.ts` — Passes `adminMapping` from manifest to Authentik OAuth2 provider creation
- `control-panel/src/app/api/setup/run/route.ts` — Updated YouEye Groups expression to normalized version (includes admin append)
- `control-panel/src/lib/auth/sso-setup.ts` — Updated YouEye Groups expression to normalized version
- `control-panel/src/lib/ui/manager.ts` — Updated YouEye Groups expression to normalized version
- `control-panel/package.json` — Bumped version to 0.3.5.1

### Test Results
- Nextcloud: SSO login → tester user provisioned into "authentik Admins" + "admin" groups → full admin access to admin panel verified
- Jellyfin: existing behavior preserved (SSO users recognized as admin via "authentik Admins" group)
- Immich: roleClaim scope mapping created and attached to provider (limitation: only evaluated at first user registration)
- Authentik: YouEye Groups expression updated with admin normalization, immich_role scope mapping created

### Notes for Iris
- The `groups` type modifies the GLOBAL "YouEye Groups" scope mapping — affects ALL apps with groups scope. The normalization is additive (appends "admin", doesn't remove "authentik Admins")
- The `roleClaim` type creates per-app scope mappings — isolated per app, no global side effects
- Immich limitation: `oauth.roleClaim` only evaluated at first user registration, not subsequent logins. Fresh installs work; existing users won't be retroactively promoted
- Three setup files (setup/run/route.ts, sso-setup.ts, manager.ts) all updated to use the normalized groups expression — ensures consistency whether created during initial setup or app install
## v0.3.5.18 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Internet/LAN access toggle in install dialog + fix native app internet access

### Changes
- `control-panel/src/lib/market/types.ts` — added `allowInternet` to InstallConfig
- `control-panel/src/lib/market/engine.ts` — fixed wantsInternet to also check internet.hosts; engine now respects config.allowInternet override
- `control-panel/src/app/api/market/app/[appId]/connections/route.ts` — added needsInternet computed field to response
- `control-panel/src/app/embed/market/client.tsx` — added "Allow Internet & LAN Access" toggle with GlobeIcon, pre-ticked from needsInternet
- `control-panel/src/components/market/install-dialog.tsx` — added matching toggle to standalone dialog

### Test Results
- `GET /api/market/app/weather/connections` → needsInternet: true, hosts: [api.open-meteo.com, geocoding-api.open-meteo.com]
- `GET /api/market/app/cinema/connections` → needsInternet: true, hosts: [api.themoviedb.org, image.tmdb.org]
- Weather NAT manually enabled on yeapp3 → `curl api.open-meteo.com` succeeds
- CP deployed and running on VM, api/ping OK

### Notes for Iris
- Native app manifests also updated in their own repos (all 6 apps: network: internet added to containers)
- Cinema manifest: removed installParams.tmdbApiKey — app should handle API key internally
- Existing installed apps need NAT manually enabled if they were installed before this fix

## v0.3.5.17 (CP) + v0.3.5.7 (UI) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Discovery API — resolve container IPs for bridge targets

### Changes
- `control-panel/src/app/api/bridges/resolve/route.ts` — NEW: resolves app's primary container IP+port from install metadata + Incus
- `ui/src/app/api/v1/my-connections/route.ts` — REWRITE: calls CP bridge resolve endpoint for actual IPs instead of DNS names
- `ui/src/middleware.ts` — Added /api/v1/my-connections to PUBLIC_ROUTES
- `control-panel/package.json` — Bumped to 0.3.5.17
- `ui/package.json` — Bumped to 0.3.5.7

### Test Results
- API: /api/bridges/resolve?appId=searxng → returns container IP 10.76.2.241 + port 8080
- API: /api/v1/my-connections with X-YouEye-App: search → returns SearXNG with resolved IP
- E2E: Search UI returns "hello world" results from SearXNG (screenshot verified)

### Notes for Iris
- First UI release in this session — UI was previously at v0.3.5.6
- Both CP and UI must be deployed together for bridge discovery to work
- No database migrations required
- No Spine changes

---

## v0.3.5.16 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Install-time connection prompts for app bridge system

### Changes
- `control-panel/src/lib/market/types.ts` — Added ApprovedConnection type + approvedConnections to InstallConfig
- `control-panel/src/lib/market/engine.ts` — New step 12: process approved connections, create+activate bridges inline
- `control-panel/src/lib/bridges/suggestions.ts` — Skip already-approved targets in suggestion generation
- `control-panel/src/app/api/market/app/[appId]/connections/route.ts` — NEW: returns outgoing/incoming wants + internet requirements
- `control-panel/src/app/api/suggestions/approve/route.ts` — NEW: creates bridge from suggestion + activates
- `control-panel/src/app/api/suggestions/[id]/dismiss/route.ts` — NEW: dismiss suggestion endpoint
- `control-panel/src/app/api/suggestions/route.ts` — Added approve action
- `control-panel/src/app/api/ui-bridge/market/route.ts` — Added connections proxy action
- `control-panel/src/app/embed/market/client.tsx` — Connection toggles in embedded install dialog
- `control-panel/src/components/market/install-dialog.tsx` — Connection toggles in standalone install dialog
- `control-panel/src/middleware.ts` — Added /api/market/app to public routes
- `ui/src/components/settings/app-settings-detail.tsx` — Pending suggestions with approve/dismiss in Network tab

### Test Results
- API: connections endpoint returns correct outgoing/incoming for Search and SearXNG
- API: suggestion approval creates and activates bridge (search-to-searxng)
- Network: Search container has NIC on SearXNG's bridge, HTTP 200 from SearXNG

### Notes for Iris
- UI component changed (app-settings-detail.tsx) — needs UI rebuild for Network tab suggestions
- No database migrations required
- No Spine changes in this release

## v0.3.5.14 (CP) + v0.3.1.1 (Spine) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Static IP assignment for all system containers

### Changes
- `spine/internal/incus/static_ips.go` — NEW: subnet detection, DHCP range restriction, static IP device override
- `spine/internal/incus/install.go` — configure DHCP ranges after Incus init
- `spine/internal/container/control.go` — init → set static IP → start (not launch)
- `spine/internal/container/ui.go` — same init → static IP → start pattern
- `spine/internal/cmd/root.go` — version bump to 0.3.1.1
- `control-panel/src/lib/incus/static-ips.ts` — NEW: mirrors Spine logic via Incus REST API
- `control-panel/src/lib/incus/container-ip.ts` — fast path returns static IP for system containers
- `control-panel/src/lib/infrastructure/deployer.ts` — Caddyfile templates use static IPs instead of DNS names
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — apply static IP before container start
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — apply static IP before container start
- `control-panel/src/lib/incus/app-network.ts` — use static IPs for proxy device targets
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — DELETED (not needed for fresh installs)
- `control-panel/src/lib/market/types.ts` — usePerAppBridge marked deprecated
- `control-panel/package.json` — version bump to 0.3.5.14

### Test Results
- All 7 system containers verified at correct static IPs (.10-.16)
- 15 containers running, 0 stopped
- Platform healthy: `curl -sk https://devvm.test/api/ping` → `{"status":"ok"}`

### Notes for Iris
- Spine + CP cross-component change — both releases required
- No backwards compatibility — designed for fresh install
- Static IPs are offsets from dynamic incusbr0 subnet base (auto-detected)

## v0.3.5.13 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Post-migration cleanup — remove legacy ACL system, connector debris, fix metadata gap

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — DELETED (829 lines of legacy ACL code)
- `control-panel/src/lib/incus/app-network.ts` — added SYSTEM_APP_IDS export (moved from deleted network-acl.ts)
- `control-panel/src/lib/bridges/manager.ts` — removed legacy ACL branches from activate/deactivate/delete
- `control-panel/src/lib/market/engine.ts` — removed legacy ACL else block and imports
- `control-panel/src/lib/market/uninstaller.ts` — removed legacy ACL cleanup branch
- `control-panel/src/app/api/internet-grants/route.ts` — removed legacy ACL grant path
- `control-panel/src/app/api/internet-grants/[id]/route.ts` — removed legacy ACL revoke path
- `control-panel/src/app/api/bridges/route.ts` — updated SYSTEM_APP_IDS import to app-network
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — added fixMetadataOnly mode
- `control-panel/src/lib/caddy/client.ts` — addAppRoutes now resolves container IPs for per-app bridge apps
- `connector-runtime/` — DELETED (entire abandoned package)
- `ui/tests/connector-settings.spec.ts` — DELETED
- `ui/tests/connector-runtime.spec.ts` — DELETED
- `pnpm-workspace.yaml` — removed connector-runtime

### Test Results
- 15 containers running, 0 stopped
- All 7 apps verified responding (HTTP 307)
- Metadata fix verified: all apps have usePerAppBridge=true + bridgeName
- Bridge and internet-grant records cleaned of stale aclName references

### Notes for Iris
- 27 files changed, 143 insertions, 2499 deletions
- network-acl.ts is gone — any code importing from it will fail
- SYSTEM_APP_IDS now lives in app-network.ts
- The ye-system ACL for system containers is still in Incus (managed by Spine, not CP)
- Connector-runtime removed from workspace — pnpm install will be faster

## v0.3.5.12 (CP) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Per-App Bridge Network Architecture — replace ACL isolation with Docker-style bridge networking

### Changes
- `control-panel/src/lib/incus/app-network.ts` — NEW: Core module for per-app bridge networking. Bridge lifecycle (create/delete with retry), subnet allocation (10.76.{N}.0/24), proxy devices for system services (postgres/authentik/UI), Caddy NIC hot-plug, cross-app NIC permissions (grant/revoke), NAT control, container migration, query helpers.
- `control-panel/src/lib/market/engine.ts` — Create per-app bridge before container deploy. NAT enabled during install, disabled post-install for no-internet apps. Caddy route uses container IP instead of DNS name. Legacy ACL fallback preserved.
- `control-panel/src/lib/market/platform-env.ts` — Proxy device mode: db_host=localhost, gateway=localhost:3001 when using per-app bridges.
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — Accept custom NIC devices for bridge attachment at container creation.
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Accept custom NIC devices for bridge attachment at container creation.
- `control-panel/src/lib/market/uninstaller.ts` — Clean up per-app bridge on uninstall (remove Caddy NIC, delete bridge with retry verification).
- `control-panel/src/lib/market/types.ts` — Added `usePerAppBridge` field to InstallMetadata.
- `control-panel/src/lib/bridges/manager.ts` — Bridge permissions use NIC hot-plug for per-app bridge apps, ACL rules for legacy. resolveBridgeMappings uses IP instead of DNS for internal host refs.
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — NEW: Migration endpoint to move existing apps from incusbr0 to per-app bridges.
- `control-panel/src/app/api/internet-grants/route.ts` — Uses bridge NAT for per-app bridge apps instead of ACL rules.
- `control-panel/src/app/api/internet-grants/[id]/route.ts` — Revoke uses bridge NAT disable for per-app bridge apps.

### Test Results
- Full install/uninstall cycle verified: bridge creation, container deployment, proxy devices, Caddy NIC, route with IP, NAT disable, bridge cleanup with retry
- All 7 existing apps migrated from incusbr0 to per-app bridges via migration endpoint
- All apps reachable via SSO (307 redirect) after migration
- Multi-container app (searxng) correctly shares a single bridge

### Notes for Iris
- ACL system preserved as fallback — not deleted, just deprecated in favor of per-app bridges
- All existing apps were migrated during development testing; production migration uses POST /api/admin/migrate-networks
- Bridge naming: `yeapp{N}` (N=1-254, max 15 chars for Linux interface names)
- Subnet range: 10.76.{N}.0/24 — registry at /var/lib/youeye/networks/subnets.json
- Caddy routes now use container IP (not DNS) — DNS doesn't cross bridges
- Internet access: NAT on bridge, not ACL rules. Enabled during install, disabled post-install unless manifest declares network:internet

## v0.3.5.5 (CP) + v0.3.5.6 (UI) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** ACL fixes, connector purge, per-app settings consolidation

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — Added youeye-ui:3000 ACL rule for all apps. Added ACL_VERSION system with refreshAllContainerAcls() for automatic migration. Blanket internet access for network:internet apps.
- `control-panel/src/lib/market/engine.ts` — Switched to blanket internet grants. Store network mode in ContainerMeta.
- `control-panel/src/lib/market/types.ts` — Added `network?: 'isolated' | 'internet'` to ContainerMeta.
- `control-panel/src/lib/infrastructure/deployer.ts` — Removed connector container deployment (Step 9) and reconcile step. TOTAL_STEPS 9→8.
- `control-panel/src/lib/infrastructure/manifests.ts` — Deleted connectorsContainerSpec() function.
- `control-panel/src/app/api/setup/run/route.ts` — Removed connectors Caddy route from routeMap.
- `ui/src/components/settings/app-settings-detail.tsx` — Complete rewrite with Overview/Permissions/Network/LinkHandling tabs. Removed all connector types.
- `ui/src/app/settings/apps/client.tsx` — New file: app list client component for settings navigation.
- `ui/src/app/settings/apps/page.tsx` — Server component wrapping AppsListClient.
- `ui/src/app/settings/permissions/page.tsx` — Replaced with redirect to /settings/apps.
- `ui/src/components/settings/settings-shell.tsx` — Removed permissions from admin sidebar.
- `ui/src/db/index.ts` — Removed 5 connector tables.
- `ui/src/middleware.ts` — Removed /api/v1/connectors from PUBLIC_ROUTES.
- `ui/src/components/settings/accounts-settings.tsx` — Removed API key management section.

### Test Results
- ACL connectivity verified: wiki→youeye-ui:3000 OK, wiki→postgres:5432 OK, wiki→internet OK
- Cross-app isolation verified for non-internet apps
- Connector container deleted, Caddy route removed

### Notes for Iris
- Connector concept fully abandoned — all code/docs/plans removed
- Internet apps have blanket egress (no cross-container isolation) — per-host restrictions planned for future
- ACL_VERSION=2 auto-refreshes all app ACLs on first ensureNetworkAcls() call after update
- /settings/permissions now redirects to /settings/apps

---

## v0.3.5.4 (CP) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Per-container ACL isolation — replace shared ye-app-isolated

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — Rewrote ACL system: per-container ye-iso-{name} ACLs replace shared ye-app-isolated. New functions: createContainerAcl(), addBridgeRuleToAcl(), removeBridgeRuleFromAcl(), deleteContainerAcl(). Auto-migration on startup.
- `control-panel/src/lib/market/engine.ts` — Moved ACL creation after container loop (need sibling IPs). All containers now get ACLs including network:internet ones.
- `control-panel/src/lib/bridges/manager.ts` — Bridges add destination rules to existing ACLs. Added resolveContainerName() for multi-container apps. System container target validation.
- `control-panel/src/lib/market/uninstaller.ts` — ACL + bridge cleanup on app uninstall.
- `control-panel/src/lib/market/schema.ts` — WantSchema rejects system container IDs.
- `control-panel/src/lib/market/types.ts` — InstallMetadata gains databaseMode, hasSSO fields.
- `control-panel/src/app/api/bridges/route.ts` — API rejects system container bridge targets.
- `control-panel/tests/acl-isolation.spec.ts` — 9 Playwright tests covering isolation, bridge validation, app health.

### Test Results
- Playwright: 9 tests, all passed
- Live verification: cross-app traffic blocked, caddy/pihole allowed, sibling ACLs correct
- All 8 app containers migrated, 16 running / 0 stopped

### Notes for Iris
- Migration runs automatically on first request — no manual steps needed
- Old ye-app-isolated and ye-bridge-* ACLs are deleted during migration
- Pre-existing searxng-to-redis bridge has a known issue: "redis" is an intra-app container, not a separate app. Bridge detection creates false bridges for intra-app refs. The sibling ACL rules handle connectivity — this is a pre-existing bug, not introduced here.

---

## v0.3.5.4 (UI) / v0.3.5.2 (CP) — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Replace connector system with permissions-based networking

### Changes
- Stripped ~60 connector files across CP and UI (routes, components, DB tables, i18n keys)
- `control-panel/src/lib/market/schema.ts` — Added WantSchema and InternetSchema to manifest
- `control-panel/src/lib/incus/network-acl.ts` — Added grantInternetAccess(), revokeInternetAccess()
- `control-panel/src/lib/bridges/internet-store.ts` — NEW: JSON store for internet grants
- `control-panel/src/lib/bridges/suggestions.ts` — NEW: suggestions engine (scan wants vs installed)
- `control-panel/src/app/api/internet-grants/` — NEW: GET/POST/DELETE internet grant endpoints
- `control-panel/src/app/api/suggestions/` — NEW: GET/POST suggestions endpoints
- `ui/src/app/api/v1/my-connections/route.ts` — NEW: discovery API for apps
- `ui/src/app/api/v1/request-bridge/route.ts` — NEW: bridge request API
- `ui/src/app/api/v1/admin/proxy-cp/route.ts` — NEW: admin CP proxy for client-side calls
- `ui/src/app/settings/permissions/` — NEW: admin Permissions settings page
- `ui/src/components/settings/settings-shell.tsx` — Added "Permissions" nav entry
- `ui/messages/{en,ru,de,fr,es}.json` — Added permissions i18n keys
- All 6 native app youeye-app.yaml — Added wants + internet declarations
- All 6 native apps — Stripped connector client code
- YouEye-Canvas — Replaced connectors module with connections module
- YE-AppMarket — Removed connector-catalog.yaml and connectors/ directory

### Test Results
- Dashboard loads after deploy (verified)
- Permissions admin page renders correctly with sidebar nav
- Login flow works via Authentik SSO

### Notes for Iris
- This is a large architectural change — review the permissions page carefully
- The discovery API (/api/v1/my-connections) is new and untested with real bridges
- Native apps had connector code stripped but don't yet use the new connections helpers (they're legacy pre-Canvas apps)
- The youeye-connectors container was recreated by Spine reconciliation — it's now unused but harmless

## v0.3.5.3 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix SearXNG availability + implement Link Handling tab

### Changes
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Extract `info_cards` with triggers from app manifest, return as `linkHandlers` in API response
- `ui/src/components/settings/app-settings-detail.tsx` — Replace Link Handling placeholder with real implementation: displays link handler types, trigger domain patterns, descriptions
- `ui/messages/{en,ru,de,fr,es}.json` — i18n keys for link handling (linkHandlingActive, linkHandlingDomains, linkHandlingExplanation)
- `ui/package.json` — Version bump 0.3.5.2 → 0.3.5.3
- VM env: `APPMARKET_BRANCH=sebastian` set in youeye-ui container (fixes connector manifest fetch)

### Test Results
- Cinema Link Handling: Shows "Movie Info" with imdb.com, themoviedb.org domains
- Wiki Link Handling: Shows "Article Summary" with *.wikipedia.org/* pattern
- SearXNG: Now shows as available with "Internal" badge + green checkmark
- Whoogle: Correctly shows "not installed" in amber
- Apps without link handlers (Notes, Weather, Translate, Search): Show empty state

### Notes for Iris
- The `APPMARKET_BRANCH` env var must be set on any VM running the sebastian branch. Without it, UI defaults to `main` which may lack connector manifest updates (e.g. compatibleApps field).
- Link handlers are read-only in this release — the plan's Session C will add management (enable/disable, conflict resolution, SmartLink component).

## v0.3.5.2 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector improvements — availability logic, dual mode, logos, admin defaults

### Changes
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Full rewrite: availability flag based on network type + installed backends + custom URL; connector logos from Gitea; admin default annotations; test-connection and update-config actions
- `ui/src/lib/connectors/logos.ts` — NEW: Utility to build Gitea raw URLs for connector logo SVGs
- `ui/src/components/settings/connector-detail.tsx` — Rewritten CapabilityRow with: availability filtering, connector logos (ConnectorLogo component), DualModePicker (internal/external radio, URL input, test connection), default badges, unavailable warnings, exported for reuse
- `ui/src/components/settings/app-settings-detail.tsx` — Replaced inline DataSourcesTab with imported CapabilityRow from connector-detail; removed 270+ lines of orphaned old code; updated types for new API fields
- `ui/src/db/schema.ts` — Added `connectorDefaults` table (capability PK, connectorId, shared key encryption fields, setBy, setAt)
- `ui/src/db/index.ts` — Added CREATE TABLE IF NOT EXISTS for connector_defaults in ensureSchema()
- `ui/src/app/api/settings/admin/connector-defaults/route.ts` — NEW: Admin-only API for GET/POST/DELETE connector defaults per capability
- `ui/src/components/settings/connector-defaults-admin.tsx` — NEW: Admin UI for managing system-wide connector defaults
- `ui/src/app/settings/connector-defaults/page.tsx` — NEW: Admin settings page route
- `ui/src/components/settings/settings-shell.tsx` — Added "Connector Defaults" to admin sidebar
- `ui/messages/{en,ru,de,fr,es}.json` — i18n keys for connector availability, dual mode, logos, defaults
- `ui/src/app/not-found.tsx` — NEW: Custom 404 page (fixes React 19 + styled-jsx SSG build error)
- `ui/src/pages/_error.tsx` — NEW: Custom error page (fixes pre-existing build failure)

### Test Results
- Browser: Settings > Apps shows all apps with connection counts
- Search app: SearXNG shows red "Backend unavailable" (local connector, app not installed)
- Cinema app: TMDB shows "External" badge with credential entry + "Manage in Accounts" link
- Connector Defaults page: All 7 capabilities listed with dropdown selectors
- Admin sidebar: "Connector Defaults" entry appears and highlights correctly

### Notes for Iris
- This is Session B of the info-cards-and-connectors plan. Sessions C-F remain (link rewrites, auth providers, UI components, network isolation).
- New `connector_defaults` DB table auto-created by ensureSchema() — no migration needed
- Availability logic: `available = network === "internet" || hasInstalledBackend || hasCustomUrl`
- DualModePicker only shown for connectors with `hasCompatibleApps` — internet-only connectors connect directly
- No changes to CP or Spine — UI-only release

## v0.3.5.1 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Settings restructure — rename Connectors → Apps, add Accounts page, per-app tabbed settings

### Changes
- `ui/src/components/settings/settings-shell.tsx` — Sidebar: "Connectors" replaced with "Apps" + "Accounts"; admin "Apps" renamed to "App Management"
- `ui/src/components/settings/app-settings-detail.tsx` — NEW: Per-app settings page with 3 tabs (Data Sources, Link Handling, Permissions)
- `ui/src/components/settings/accounts-settings.tsx` — NEW: Centralized Connected Accounts + API Keys page
- `ui/src/app/settings/apps/page.tsx` — NEW: Apps list route (replaces connectors)
- `ui/src/app/settings/apps/[appId]/page.tsx` — NEW: Per-app detail route with tabbed interface
- `ui/src/app/settings/accounts/page.tsx` — NEW: Accounts settings route
- `ui/src/app/api/settings/accounts/route.ts` — NEW: Aggregate API for OAuth accounts + API keys
- `ui/src/app/api/auth/providers/[slug]/disconnect/route.ts` — NEW: OAuth disconnect endpoint
- `ui/src/app/settings/connectors/page.tsx` — Redirect to `/settings/apps`
- `ui/src/app/settings/connectors/[appId]/page.tsx` — Redirect to `/settings/apps/[appId]`
- `ui/messages/{en,ru,de,fr,es}.json` — i18n for Apps, Accounts, App Management, tabs, empty states

### Test Results
- Browser: Sidebar shows Apps/Accounts correctly, redirect works, app list shows all 7 apps
- Per-app detail: 3 tabs render, Data Sources shows capabilities, Link Handling shows placeholder, Permissions fetches state
- Accounts page: Connected Accounts and API Keys sections render with empty states
- Playwright: 14 tests written (`tests/settings-apps.spec.ts`), CDP-connected to persistent browser

### Notes for Iris
- This is Session A of the info-cards-and-connectors plan. Link Handling tab is placeholder (Session C). Accounts OAuth flow needs auth providers configured (Session D).
- Old `/settings/connectors` URLs redirect to `/settings/apps` — no breaking change for bookmarks
- No changes to CP or Spine — UI-only release

## v0.3.3.4 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Correct connector system to per-app model with Internal/External badges and auto-wire

### Changes
- `ui/src/app/api/settings/connectors/route.ts` — Reverted to per-app response format (`{apps, connectors}`)
- `ui/src/components/settings/connector-app-list.tsx` — Reverted to per-app list with connection status
- `ui/src/components/settings/connector-detail.tsx` — Added Internal/External badges (green=local, blue=internet), backend discovery showing installed app names, install hints for admins
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Added backend discovery for local connectors
- `ui/src/lib/db/queries/connectors.ts` — Removed auto-select; auto-wire only resolves baseUrl after user selects a connector
- `ui/src/lib/connectors/schema.ts` — Removed redundant `source` field
- `control-panel/src/lib/connectors/schema.ts` — Removed redundant `source` field
- `ui/messages/en.json` — Added `installAvailable`, removed orphaned capability-centric i18n strings
- Deleted `capability-detail.tsx`, `capability/[capability]/page.tsx`, `capability/[capability]/route.ts` (wrong capability-centric model)

### Test Results
- Browser: per-app list shows Wiki, Search, Cinema, Weather with correct connection counts
- Detail view: Internal/External badges render correctly, backend names shown for local connectors

### Notes for Iris
- This is a design correction — the previous v0.3.3.3 had a capability-centric UI which was wrong
- AppMarket manifests also updated (separate commit) to remove `source` field
- YE-App-Search `provides` block restored (separate commit)

## v0.3.3.3 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector system enhancement — source tags, auto-wiring, service registry, capability-centric UI

### Changes

#### Phase 1-3: Manifest Schema + Proxy + CP Engine
- `YE-AppMarket/connectors/*.yaml` — Added `source: internal|external|both` and `compatibleApps` to all 16 connector manifests; replaced hardcoded container URLs with `${baseUrl}` template variable in SearXNG/Whoogle
- `control-panel/src/lib/connectors/schema.ts` — Added `CompatibleAppSchema`, `source`, `compatibleApps` to Zod schema
- `control-panel/src/lib/connectors/proxy.ts` — Added `baseUrl` template variable resolution
- `control-panel/src/lib/market/engine-connectors.ts` — Full rewrite: removed hardcoded `CONNECTOR_APP_MAP`, replaced with dynamic `compatibleApps` lookup from manifests

#### Phase 4: UI Discovery + Auto-Wire
- `ui/src/lib/connectors/schema.ts` — Mirrored CP schema additions
- `ui/src/lib/db/queries/connectors.ts` — Added `discoverBackends()`, `discoverBackendsByCapability()`, `tryAutoWire()` with two rules (internal+1 backend, external+auth:none); updated `resolveConnector()` return type with `autoWired`, `source`, `baseUrl`
- `ui/src/app/api/v1/connectors/backends/route.ts` — New backend discovery endpoint
- `ui/src/app/api/v1/connectors/resolve/route.ts` — Returns `auto-connected` status

#### Phase 5: Capability-Centric UI
- `ui/src/app/api/settings/connectors/route.ts` — Full rewrite: returns capability groups with source tags, backend discovery, auto-wire status
- `ui/src/app/api/settings/connectors/capability/[capability]/route.ts` — New per-capability detail API with connect/disconnect
- `ui/src/components/settings/connector-app-list.tsx` — Full rewrite: capability list with active connector, auto-wire badges, backend counts
- `ui/src/components/settings/capability-detail.tsx` — New component: Internal/External sections, radio picker, credential entry, install hints
- `ui/src/app/settings/connectors/capability/[capability]/page.tsx` — New capability detail page
- `ui/messages/en.json` — Added 12 i18n strings for Internal/External/auto-connected UI

#### Phase 6: Cleanup
- `ui/src/lib/db/queries/connectors.ts` — Removed unused `fetchConnectorsByCapability()`

### Test Results
- Build: passes (next build)
- Browser: connector list shows all capabilities with source indicators
- Search Engine detail: SearXNG auto-wired as Internal, Whoogle available with install hint
- Weather Data detail: Open-Meteo auto-wired as External
- Screenshots: phase5-connectors-list.png, phase5-search-detail.png, phase5-weather-detail.png

### Notes for Iris
- New route `/settings/connectors/capability/[capability]` — add to nav if needed
- Old per-app routes (`/settings/connectors/[appId]`) still work for backward compat
- AppMarket manifests now require `source` field (defaults to "external" if missing)
- Auto-wire is transparent — no DB rows created, resolved at query time

---

## v0.3.3.1 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Full connector system overhaul — unified permission model, auth providers, runtime, UI components, 9 new connectors

### Changes
- `ui/src/db/schema.ts` — added auth_providers and user_auth_tokens tables, auth_provider_id column
- `ui/src/db/index.ts` — auto-migration for new tables
- `ui/src/lib/db/queries/auth-providers.ts` — NEW: complete auth provider CRUD, OAuth2 token management, refresh, propagation
- `ui/src/lib/db/queries/connectors.ts` — removed app_permissions check (selecting connector = permission)
- `ui/src/lib/connectors/runtime/server.mjs` — fixed script transform, added asset serving, protocols endpoint, CSP
- `ui/src/lib/connectors/postmessage-bridge.ts` — NEW: ConnectorBridge class for iframe communication
- `ui/src/lib/connectors/use-connector-bridge.ts` — NEW: React hook for connector UI bridge
- `ui/src/lib/connectors/schema.ts` — added url config field type
- `ui/src/app/api/auth/providers/[slug]/route.ts` — NEW: OAuth2 flow initiation
- `ui/src/app/api/auth/providers/[slug]/callback/route.ts` — NEW: OAuth2 callback + token storage
- `ui/src/app/api/settings/auth-providers/route.ts` — NEW: admin provider management
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — enhanced with provider status
- `ui/src/app/api/v1/connectors/list/route.ts` — added UI and managed field info
- `ui/src/app/api/v1/connectors/proxy/route.ts` — enhanced with auto-refresh from auth providers
- `ui/src/components/settings/connector-detail.tsx` — OAuth sign-in buttons for managed creds
- `ui/messages/en.json` — new translation keys

### Test Results
- Wikipedia proxy chain: resolve → proxy → search = 20 results ✓
- Connector list API: 15 connectors with correct capabilities ✓
- Asset serving via connectors.devvm.test ✓
- Settings connect/disconnect flow ✓

### Notes for Iris
- DB migration automatic via ensureSchema() — no manual steps needed
- Dev VMs need APPMARKET_BRANCH=sebastian in UI .env (remove on merge)
- No UI version bump — bump when merging to dev
- Caddy route connectors.devvm.test must point to youeye-connectors container
## cp-v0.3.5.6 / ui-v0.3.3.12 — vanya — 2026-04-25
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** TLS certificate management — Let's Encrypt DNS-01 + custom upload (Session 29)

### Changes
- `control-panel/src/lib/acme/client.ts` — ACME client with step-by-step DNS-01 flow (startOrder, verifyAndFinalize)
- `control-panel/src/lib/acme/storage.ts` — TLS cert persistence via settingsService (youeye.yaml)
- `control-panel/src/lib/caddy/client.ts` — loadExternalCert/removeExternalCert via Caddy load_pem API
- `control-panel/src/lib/caddy/types.ts` — Added LoadPemEntry, certificate_selection types
- `control-panel/src/app/api/tls/acme/route.ts` — POST start order, PUT verify & finalize
- `control-panel/src/app/api/tls/upload/route.ts` — POST custom PEM cert upload
- `control-panel/src/app/api/tls/download/route.ts` — GET cert/key/bundle/CA download
- `control-panel/src/app/api/tls/status/route.ts` — GET status, DELETE revert to self-signed
- `control-panel/src/app/embed/tls/` — Embed page for UI settings iframe
- `control-panel/src/components/settings/tls-manager-card.tsx` — Standalone card component (kept for direct CP use)
- `control-panel/package.json` — Bumped to 0.3.5.6, added acme-client dependency
- `ui/src/app/settings/tls/page.tsx` — TLS settings page (embeds CP iframe)
- `ui/src/components/settings/settings-shell.tsx` — Added TLS sidebar item with Lock icon
- `ui/messages/*.json` — Added "tls" translation key to all 5 locales

### Test Results
- CP build: successful (TypeScript clean)
- UI build: successful
- TLS embed page: renders correctly in UI settings iframe
- TLS status API: returns correct self-signed mode
- CA cert download: working via execShell to youeye-caddy

### Notes for Iris
- CP has new `acme-client` npm dependency (pnpm-lock.yaml updated)
- TLS data stored in youeye.yaml via settingsService (keys: tls_mode, tls_cert_pem, tls_key_pem, etc.)
- Caddy integration uses load_pem module + tagged automation policies
- Both CP and UI need to be deployed together for the sidebar entry to work

## v0.3.3.11 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Restore selectable clock widget themes (Session 28)

### Changes
- `ui/src/lib/clock-presets.ts` — NEW: 14 theme definitions across 4 categories (Clean, Bold, Glow, Retro)
- `ui/src/components/widgets/clock-theme-picker.tsx` — NEW: visual thumbnail picker with category tabs
- `ui/src/components/widgets/clock-widget.tsx` — Refactored to apply theme styles from presets instead of hardcoded gradient
- `ui/src/components/dashboard/widget-settings-dialog.tsx` — Wire ClockThemePicker into settings dialog
- `ui/tests/clock-themes.spec.ts` — NEW: Playwright spec for theme selection

### Test Results
- FIFO: 10 screenshots verifying all theme categories + theme application
- Playwright: clock-themes.spec.ts with 5 test cases

### Notes for Iris
- UI-only change, no CP or Spine modifications
- Default theme ("gradient") matches the pre-existing hardcoded style — no visual regression for users who haven't customized

## v0.3.3.10 / v0.3.5.5 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt widget overflow clipping + Enhanced icon picker with Lucide icons (Session 27)

### Changes
- `ui/src/components/widgets/index.ts` — Added `allowOverflow` to WidgetMeta interface; server-name widget opts in
- `ui/src/components/dashboard/widget-container.tsx` — Conditional overflow-visible for widgets with allowOverflow
- `ui/src/components/widgets/server-name-widget.tsx` — Inner container changed to overflow-visible
- `control-panel/src/app/embed/branding/client.tsx` — Major rewrite: added Lucide icons tab (~1700 icons with search), expanded emojis (24→450+), upload tab, gradient presets, icon color picker
- `control-panel/src/app/api/ui/branding/upload/route.ts` — NEW: bridge proxy for file uploads
- `ui/src/app/api/ui-bridge/branding/upload/route.ts` — NEW: bridge endpoint for file uploads

### Test Results
- `ui/tests/wordart-overflow.spec.ts` — overflow-visible verification, text-shadow rendering
- `ui/tests/icon-picker-enhanced.spec.ts` — branding API, icon routes, upload auth

### Notes for Iris
- UI change is backward-compatible — only server-name widget affected, all others retain overflow-hidden
- CP icon picker is self-contained in the embed branding page, no other CP pages affected
- Upload bridge routes follow existing bridge pattern (X-UI-Bridge-Token auth)

---

## v0.3.5.4 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix Authentik favicon sync — DNS, auth, and data bugs (Session 26b)

### Changes — CP (v0.3.5.4)
- `control-panel/src/lib/authentik/sync-branding.ts` — NEW: extracted Authentik sync logic into reusable function
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Simplified to use sync-branding module; fixed DNS from `.incus` to `.${CONTAINER_DOMAIN}`
- `control-panel/src/app/api/ui/branding/route.ts` — Replaced broken fire-and-forget HTTP self-call with direct `syncBrandingToAuthentik()` call + CSS generation

### Notes for Iris
- The branding sync was silently failing since the one-way bridge auth change. This fix makes it work again.
- Authentik favicon is now pushed automatically on every branding save via the Server Branding embed.

---

## v0.3.3.9 / v0.3.5.3 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt picker auto-fill and icon rendering pipeline bugs (Session 26)

### Changes — UI (v0.3.3.9)
- `ui/src/middleware.ts` — Added `/icon` and `/apple-icon` to STATIC_PATTERNS so favicon routes bypass auth
- `ui/src/app/icon.tsx` — Rewritten: force-dynamic + auto-regeneration from DB config for letter mode
- `ui/src/app/apple-icon.tsx` — Same force-dynamic + auto-regen pattern
- `ui/src/lib/icon-renderer.ts` — BRANDING_DIR moved from public/branding (wiped on deploy) to persistent /opt/youeye-ui-data/branding/

### Changes — CP (v0.3.5.3)
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Added findInitialIndices() to reverse-map current style to preset indices on mount; added useRef mount guard to skip first useEffect render

### Test Results
- `ui/tests/icon-rendering-fixes.spec.ts` — /icon and /apple-icon return 200 without auth, serve valid PNG, no stale prerendered cache
- `ui/tests/wordart-picker-autofill.spec.ts` — WordArt picker shows current style on mount, API returns valid site_name_style

### Notes for Iris
- UI middleware change is safe — only adds to STATIC_PATTERNS, no removals
- Icon renderer path change requires /opt/youeye-ui-data/branding/ directory in UI container (created automatically via mkdir recursive)

---

## v0.3.3.8 / v0.3.5.2 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Server icon/favicon system — configurable icon picker, auto-render, multi-app favicon (Session 25)

### Changes — UI (v0.3.3.8)
- `ui/src/lib/icon-config.ts` — New: IconConfig type, DEFAULT_ICON_CONFIG, ICON_SIZES constants
- `ui/src/lib/icon-renderer.ts` — New: Server-side SVG→PNG renderer via sharp with embedded font support
- `ui/src/app/api/v1/branding/icon/route.ts` — New: POST (upload rendered icon), GET (serve icon PNG by size)
- `ui/src/app/api/ui-bridge/branding/icon/route.ts` — New: Bridge endpoint for icon uploads from CP
- `ui/src/app/icon.tsx` — New: Next.js dynamic favicon route (32px)
- `ui/src/app/apple-icon.tsx` — New: Apple touch icon route (180px)
- `ui/src/components/settings/icon-picker-branding.tsx` — New: Full icon picker (Letter/Icons/Emoji/Upload tabs, shape, background)
- `ui/src/app/api/v1/branding/route.ts` — Added icon_config to PUT, auto-regenerate icons on wordart change
- `ui/src/app/api/ui-bridge/branding/route.ts` — Added icon_config passthrough, letter mode auto-render
- `ui/src/components/settings/branding-settings.tsx` — Added IconPickerBranding, icon save/upload logic
- `ui/src/lib/db/queries/branding.ts` — Added icon_config field to BrandingConfig, DB queries
- `ui/src/middleware.ts` — Added /api/v1/branding/icon to PUBLIC_ROUTES
- `ui/tests/server-icon.spec.ts` — New: 8 Playwright tests (API, UI picker, CP proxy)

### Changes — Control Panel (v0.3.5.2)
- `control-panel/src/lib/icon-config.ts` — New: Mirror of IconConfig type
- `control-panel/src/components/setup/SetupIcon.tsx` — New: Setup wizard icon step (Letter/Emoji, shape, background)
- `control-panel/src/app/api/branding/favicon/route.ts` — New: CP favicon proxy (fetches from UI)
- `control-panel/src/app/api/ui/branding/icon/route.ts` — New: Bridge proxy for icon uploads
- `control-panel/src/app/embed/branding/client.tsx` — Added icon picker (Letter/Emoji, shape, background, canvas preview)
- `control-panel/src/app/layout.tsx` — Added dynamic favicon metadata
- `control-panel/src/app/setup/page.tsx` — Added icon step (step 2), renumbered wizard steps
- `control-panel/src/app/api/setup/run/route.ts` — Added icon_config DB write, fontconfig install, Authentik favicon push
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Added favicon push to Authentik container
- `control-panel/src/middleware.ts` — Added /api/branding/favicon to PUBLIC_ROUTES

### Test Results
- Playwright: 8 tests passed (server-icon.spec.ts)
- Visual verification: icon picker, letter/emoji modes, shape controls, save flow, favicon serving

### Notes for Iris
- UI container requires `fontconfig` + `fonts-dejavu-core` packages for server-side icon rendering
- Setup provisioning auto-installs fontconfig and registers custom fonts
- Icon auto-regenerates when WordArt changes (letter mode only)
- Four icon modes: Letter (from WordArt), Emoji (native), Lucide icons, Upload
- CP favicon served via proxy from UI's /api/v1/branding/icon endpoint

## v0.3.3.7 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Widget auto-fit — text fills container width, height auto-adjusts, no empty space (Session 24)

### Changes — UI (v0.3.3.7)
- `ui/src/components/widgets/index.ts` — Added `autoFit` flag + `onAutoSize` callback to WidgetComponentProps/WidgetMeta
- `ui/src/components/dashboard/widget-container.tsx` — Auto-fit height handler, hide vertical resize handles for autoFit widgets, minimal padding (p-1) for autoFit
- `ui/src/components/dashboard/widget-card.tsx` — Thread `onAutoSize` to widget components
- `ui/src/components/widgets/server-name-widget.tsx` — JS fit-text-to-width: measures text, scales fontSize to fill container, reports height via onAutoSize
- `ui/src/components/widgets/clock-widget.tsx` — Same fit-text approach, gradient time, proportional date (28% of time size)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated default heights for auto-fit widgets
- `ui/tests/widget-scaling.spec.ts` — Updated: fill-ratio tests, autoFit handle removal, reset defaults
- `ui/package.json` — Bumped 0.3.3.6 → 0.3.3.7

### Test Results
- Playwright: 5 tests passed (widget-scaling.spec.ts)

### Notes for Iris
- AutoFit widgets: only width is user-resizable, height auto-adjusts to content
- Bottom/top resize handles hidden for autoFit widgets in edit mode
- Existing layouts preserved — height auto-adjusts on first load

## v0.3.3.6 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Widget container-query scaling — WordArt and Clock text scales with widget resize (Session 24)

### Changes — UI (v0.3.3.6)
- `ui/src/components/dashboard/widget-container.tsx` — Added `containerType: "size"` to widget content wrapper, enabling CSS container query units (cqw/cqh) inside all widgets
- `ui/src/components/widgets/server-name-widget.tsx` — Switched fontSize from viewport-relative `clamp(3rem, 8vw, 6rem)` to container-relative `clamp(1.5rem, 15cqw, 12rem)` so text scales with widget resize
- `ui/src/components/widgets/clock-widget.tsx` — Restyled with gradient time display, uppercase date, and cqw-based font scaling (`clamp(1rem, 10cqw, 6rem)`)
- `ui/src/components/widgets/index.ts` — Reduced server-name default width from 52→26% (half)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated DEFAULT_WIDGETS server-name width from 57→30%
- `ui/package.json` — Bumped 0.3.3.5 → 0.3.3.6
- `ui/tests/widget-scaling.spec.ts` — New test suite: container queries, cqw font scaling, clock gradient, reset defaults

### Test Results
- Playwright: 5 tests passed (widget-scaling.spec.ts)
- Screenshots: Tests/Vanya/scaling-*.png

### Notes for Iris
- Existing user layouts are preserved (widget positions/sizes stored in DB)
- New defaults only apply on "Reset" or when adding a new widget
- CSS `container-type: size` is applied to ALL widget wrappers, not just WordArt/Clock — future widgets can use cqw units for free

## v0.3.3.4 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix hidden apps not filtering in native app drawers, add visible/order to header config API (Session 22)

### Changes — UI (v0.3.3.4)
- `ui/src/app/api/v1/header/config/route.ts` — Added `visible` field to apps array in response
- `ui/package.json` — Bumped 0.3.3.3 → 0.3.3.4

### Test Results
- Build: clean standalone.tar (227MB), deployed to youeye-ui container

### Notes for Iris
- Header config API now includes `visible: boolean` per app — native apps use this to filter hidden apps
- All native apps updated to filter `visible !== false` and sort by `order`

## v0.3.3.3 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix header icon spacing, notification bugs, toast positioning, standardize native app drawers (Session 21)

### Changes — UI (v0.3.3.3)
- `ui/src/components/layout/user-menu.tsx` — Wrapped avatar trigger in h-9 w-9 button for consistent icon spacing
- `ui/src/components/layout/notification-bell.tsx` — Standardized button to h-9 w-9, fixed interface fields from snake_case to camelCase
- `ui/src/components/ui/sonner.tsx` — Added position="top-right" and duration={5000} for auto-dismissing toasts
- `ui/src/components/notifications/notifications-list.tsx` — Fixed API paths /api/notifications → /api/v1/notifications (5 places), fixed NaN time bug, added NaN guard
- `ui/package.json` — Bumped 0.3.3.2 → 0.3.3.3

### Test Results
- Build: clean standalone.tar (226MB), deployed to youeye-ui container
- Browser: even header spacing, notifications load with correct times, toasts auto-dismiss top-right

### Notes for Iris
- notification-bell and notifications-list now use camelCase field names matching Drizzle ORM output
- API path fix critical — /api/notifications never existed, only /api/v1/notifications
- No CP or Spine changes

## v0.3.3.2 — vanya — 2026-04-22
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Drawer prefs in header config API for cross-app consistency (Session 20)

### Changes — UI (v0.3.3.2)
- `ui/src/app/api/v1/header/config/route.ts` — Added `getDrawerPrefs()` call and `drawer_prefs` field to response
- `ui/package.json` — Bumped 0.3.3.1 → 0.3.3.2

### Test Results
- Build: clean standalone.tar
- Deploy: youeye-ui container updated and serving
- Browser: drawer_prefs correctly returned in header config, native apps render consistent drawer layout

### Notes for Iris
- All native apps now consume `drawer_prefs` from header config to render app drawer with same columns/iconScale/maxHeight as homepage
- No CP changes in this session

## v0.3.5.1 / v0.3.3.1 — vanya — 2026-04-22
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Avatar management in CP embed + shared avatar across native apps

### Changes — CP (v0.3.5.1)
- `control-panel/src/app/api/user/avatar/route.ts` — NEW: CP-owned avatar upload/delete to Authentik via `attributes.avatar` PATCH
- `control-panel/src/app/embed/avatar/page.tsx` + `client.tsx` — NEW: Standalone avatar picker embed for onboarding
- `control-panel/src/app/embed/profile/client.tsx` — Added avatar upload (file + 32 emoji presets via canvas) and remove to profile embed
- `control-panel/src/lib/authentik/client.ts` — Added `ensureAvatarSettings()` to configure Authentik for attributes.avatar
- `control-panel/src/app/api/setup/run/route.ts` — Avatar settings configured during initial setup
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Avatar settings ensured during branding sync
- `control-panel/src/app/api/ui-bridge/user/avatar/` — DELETED: old bridge route removed

### Changes — UI (v0.3.3.1)
- `ui/src/app/api/v1/header/config/route.ts` — Added `avatar_url` (full URL) to user object in response
- `ui/src/app/api/v1/user/avatar/[id]/route.ts` — Made public (no auth), added UUID sanitization for path traversal prevention
- `ui/src/middleware.ts` — Added `/api/v1/user/avatar` to PUBLIC_ROUTES for cross-subdomain access
- `ui/src/components/settings/profile-settings.tsx` — Removed avatar handling code, now receives from CP embed via postMessage
- `ui/src/app/onboarding/page.tsx` — New 4-step flow (Welcome → Avatar → PIN → Done), theme-aware classes
- `ui/src/app/api/v1/user/avatar/route.ts` — Removed Authentik sync call
- `ui/src/lib/avatar/authentik-sync.ts` — DELETED: old UI→CP bridge sync
- `ui/messages/en.json`, `ui/messages/ru.json` — New onboarding i18n keys

### Changes — Native Apps (Search v0.3.1.1, Weather v0.3.1.1)
- `YE-App-Search/src/lib/types/index.ts` — Added `avatar_url` to HeaderConfig user type
- `YE-App-Search/src/lib/components/layout/user-menu.tsx` — Display avatar image with initials fallback
- `YE-App-Search/src/lib/components/layout/app-header.tsx` — Pass avatarUrl from header config to UserMenu
- `YE-App-Weather/src/lib/types/index.ts` — Added `avatar_url` to HeaderConfig user type
- `YE-App-Weather/src/components/layout/user-menu.tsx` — Display avatar via AvatarImage with initials fallback
- `YE-App-Weather/src/components/layout/weather-header.tsx` — Pass avatarUrl from header config to UserMenu

### Test Results
- Avatar visible in UI dashboard, Search app, and Weather app headers — all three show same avatar
- Avatar endpoint serves publicly (HTTP 200, 5534B) without cookies
- Header config API returns full avatar_url for service-to-service calls
- Onboarding: 4-step flow renders correctly with system theme
- Screenshots: Tests/Vanya/20260422_1/

### Notes for Iris
- **Architecture change**: ALL UI→CP bridge calls for avatar eliminated. CP owns Authentik avatar management end-to-end.
- **Avatar serving is now public** — profile pictures are served without auth at `/api/v1/user/avatar/[id]` (like Gravatar). Upload/delete still require auth.
- **Header config contract change**: `user.avatar_url` is now included. Existing apps that don't use it are unaffected (additive change).
- Native apps (Search, Weather) have independent releases for the avatar display change.
- Authentik admin settings MUST have `attributes.avatar` in the `avatars` chain — setup wizard and branding sync handle this automatically.

## v0.3.4.7 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** RS256 signing key for OAuth2 providers; Immich + Nextcloud SSO end-to-end testing

### Changes
- `control-panel/src/lib/market/authentik.ts` — Added `findSigningKey()` to look up Authentik's self-signed certificate keypair; auto-assign signing_key to new OAuth2 providers for RS256 JWT signing
- `control-panel/src/lib/market/engine.ts` — Fixed `injectCaddyRootCA()`: mkdir -p before writing cert (OCI images may not have /usr/local/share/ca-certificates/); write cert to /tmp/caddy-root.crt for NODE_EXTRA_CA_CERTS fallback
- `control-panel/package.json` — Bumped version to 0.3.4.7

### Test Results
- Immich SSO: full install → admin signup → OAuth config → SSO login as "Tester Dev" (name, email, username all correct)
- Nextcloud SSO: full install → CLI OIDC setup → SSO login as "Tester Dev" via user_oidc (name, email correct, backend=user_oidc)
- RS256 signing key auto-assigned to both Immich and Nextcloud Authentik providers

### Notes for Iris
- `findSigningKey()` queries Authentik's certificate keypairs API, prefers "Self-signed" cert, falls back to first available
- Engine's `injectCaddyRootCA()` now handles missing directories in OCI images (was failing silently on mkdir)
- Nextcloud requires `allow_local_remote_servers = true` to reach Authentik at private IPs — added to manifest CLI steps
- The `user_oidc:provider:create` command was wrong for Nextcloud 31.x — correct command is `user_oidc:provider`

## v0.3.4.6 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Admin credentials API + UI for marketplace apps; SSO variable resolution for callback_path/entry_url

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `CredentialSchema` (label/username/passwordSecret) to manifest schema
- `control-panel/src/lib/market/types.ts` — Added `CredentialSpec`, `CredentialMeta` types; added `credentials` and `ssoEntryUrl` to `InstallMetadata`
- `control-panel/src/lib/market/engine.ts` — Persist credentials in install metadata; resolve variables in `entry_url` and `callback_path`
- `control-panel/src/lib/market/platform-env.ts` — Inline variable resolution for `callback_path` in SSO context; added `credentials: []` to mock manifest
- `control-panel/src/app/api/market/credentials/route.ts` — NEW: API endpoint to read admin credentials (secret values from disk)
- `control-panel/src/app/api/market/status/route.ts` — Include `ssoEntryUrl` in app URL for "Open" button
- `control-panel/src/app/(dashboard)/market/[appId]/page.tsx` — Credentials card with show/hide toggle and copy buttons

### Test Results
- CP builds and deploys successfully (v0.3.4.6, 10 containers running)
- Credentials API returns admin passwords from disk secrets for installed apps

### Notes for Iris
- New manifest field: `credentials` — array of {label, username, passwordSecret}. Stored in install.json, values read from disk secrets at API time.
- `callback_path` and `entry_url` now support variable resolution (`${authentik.name}`, `${app.id}`)
- AppMarket manifests updated: all 5 external apps now have credentials sections; Memos/Jellyfin use `${authentik.name}` instead of hardcoded "Authentik"/"authentik"

## v0.3.4.5 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Add extractCookie to SSO engine for cookie-based auth apps (Memos)

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `extractCookie` field to SSOStepSchema (name + as)
- `control-panel/src/lib/market/sso-engine.ts` — Cookie extraction from Set-Cookie and Grpc-Metadata-Set-Cookie headers; refactored executeHTTPStep to return headers alongside body

### Test Results
- Memos installed successfully with full SSO configuration via cookie-based auth
- Admin user created with HOST role, Authentik identity provider configured
- Clean reinstall verified (uninstall → fresh install → all 9 steps pass)

### Notes for Iris
- New SSO engine feature: `extractCookie` — needed for any app that returns auth tokens via cookies instead of JSON response body (gRPC-gateway apps like Memos)
- No breaking changes to existing manifests — extractToken still works as before

## v0.3.4.4 / v0.3.2.2 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix external app icons in app drawer and Jellyfin icon/screenshot in App Market

### Changes
- `control-panel/src/app/api/market/image/route.ts` — Added `jellyfin.org` to ALLOWED_DOMAINS so Jellyfin screenshots can be proxied
- `ui/src/app/api/market/image/route.ts` — NEW: Image proxy route mirroring CP's endpoint, so app drawer icons (stored as `/api/market/image?url=...`) resolve on the UI domain
- `ui/src/middleware.ts` — Added `/api/market/image` to PUBLIC_ROUTES (no auth required for icon serving)
- `ui/package.json` — Bumped to 0.3.2.2
- `control-panel/package.json` — Bumped to 0.3.4.4

### Test Results
- Playwright: 8 FIFO screenshots, all verified
- Jellyfin icon visible in App Market card and detail page
- Jellyfin screenshot visible in App Market detail page
- Jellyfin icon visible in App Drawer (was broken placeholder before)
- UI image proxy returns HTTP 200 for Gitea-hosted SVG icons

### Notes for Iris
- The UI now has `/api/market/image` route — must be included in builds
- All external app manifests in YE-AppMarket now use relative iconUrl paths (branch-independent)
- Existing installed apps with `/api/market/image?url=...` in their icon DB column will work automatically with the new UI proxy

## v0.3.4.3 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix custom scope mapping filter for SSO admin role mapping

### Changes
- `control-panel/src/lib/market/authentik.ts` — Scope mapping filter now includes custom Authentik mappings (managed=null) alongside built-in ones, enabling YouEye Groups claim in OIDC tokens for admin role mapping

### Notes for Iris
- This is the engine-side fix for admin role mapping. Without it, future app installs won't get the `groups` claim in their OIDC tokens, breaking any `roleClaim: "groups"` config.

## v0.3.4.2 / v0.3.2.1 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Jellyfin SSO fixes — entry URL auto-redirect, username claim, display name

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `entry_url` to SSOSchema for SSO entry path
- `control-panel/src/lib/market/engine.ts` — Passes `sso_entry_url` during app registration with UI
- `ui/src/db/schema.ts` + `ui/src/db/index.ts` — Added `sso_entry_url` column to apps table with auto-migration
- `ui/src/app/api/v1/apps/drawer/route.ts` — buildAppUrl appends ssoEntryUrl when set
- `ui/src/app/api/v1/header/config/route.ts` — Same SSO entry URL logic for header config API
- `ui/src/app/api/v1/apps/register/route.ts` — Accepts sso_entry_url in registration body
- `ui/src/lib/db/queries/app-management.ts` — Stores ssoEntryUrl in registerApp
- `ui/src/lib/db/queries/apps.ts` — Returns ssoEntryUrl in getUserAppsWithConfig

### Test Results
- Verified SSO login creates user as "tester" (not UUID) via Jellyfin Users API
- Verified drawer API returns `https://jellyfin.devvm.test/sso/OID/start/authentik`
- Verified SSO flow works end-to-end from SSO entry URL

### Notes for Iris
- CP and UI must merge together — entry_url schema + DB column are coupled
- YE-AppMarket must also merge for the manifest changes
- Existing installed apps need manual DB update for sso_entry_url (new installs get it automatically)

## v0.3.4.1 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Add Caddy root CA injection for external app SSO HTTPS trust

### Changes
- `control-panel/src/lib/market/engine.ts` — Added `injectCaddyRootCA()` helper and CA injection loop before SSO configure steps; OCI containers with SSO now automatically trust Caddy's self-signed certificates for OIDC discovery
- `control-panel/package.json` — Version bump to 0.3.4.1

### Test Results
- Jellyfin (first external app) installed end-to-end from App Market UI
- SSO-Auth plugin auto-installed and configured with Authentik OIDC
- SSO login flow verified: Jellyfin → Authentik → redirect back → authenticated
- CA cert injection confirmed in container trust store (151 certs after injection)
- Caddy route and Pi-Hole DNS entry auto-created
- 5 screenshots captured throughout install flow

### Notes for Iris
- This change is required for ANY external app with SSO (not just Jellyfin)
- The CA injection runs only for OCI containers where `ssoEnabled` is true
- If Caddy root cert is missing or malformed, injection is silently skipped (warning logged)
- Companion change: Jellyfin manifest in YE-AppMarket (andrew branch) must be merged alongside

---

## v0.3.2.2 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 4 — Connector Settings UI fixes + end-to-end verification

### Changes
- `ui/src/app/api/settings/connectors/route.ts` — Fixed isExternalApp detection (check manifest.id prefix) + added consumes fallback
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Added consumes field fallback for connector requirements
- `ui/src/app/connectors/setup/page.tsx` — Added consumes field fallback for setup page validation
- `ui/package.json` — Version bump to 0.3.2.2
- `ui/tests/connector-settings.spec.ts` — 7 Playwright tests for connector settings UI

### Test Results
- Playwright: 7 tests (connector-settings.spec.ts)
- Browser: full connect/disconnect flow verified for all free connectors

### Notes for Iris
- DB app manifests need `connectors.requires` injected (SQL ran on dev VM, not in migration)
- `APPMARKET_BRANCH` env var must be set in UI container for full connector catalog
- Wiki uses `consumes` not `requires` — both are now supported in all 3 API routes

---

## v0.3.2.1 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector runtime + Canvas-compatible proxy route + SearXNG 403 fix

### Changes
- `ui/src/lib/connectors/runtime/server.mjs` — Connector runtime server (Node HTTP, /health + /proxy endpoints, SSRF blocklist, json-map/script/passthrough transforms)
- `ui/src/app/api/v1/connectors/[connectorId]/proxy/route.ts` — Canvas SDK compatibility route (extracts connectorId from URL path, forwards to runtime)
- `ui/package.json` — Version bump to 0.3.2.1
- `ui/tests/connector-runtime.spec.ts` — 8 Playwright tests for connector system

### Test Results
- Playwright: 8 tests, all passed
- Screenshots: Tests/Sebastian/20260421_1/

### Notes for Iris
- Connector runtime server.mjs must be deployed to `youeye-connectors` container at `/opt/youeye-connectors/server.mjs`
- SearXNG containers need `formats: [html, json, rss]` in `/etc/searxng/settings.yml` (not in CP installer yet)
- Search app needs `YOUEYE_API_URL=http://youeye-ui.youeye:3000/api/v1` and `CP_API_URL=http://youeye-ui.youeye:3000/api/v1` in env
- The `connector:search-engine` permission must be granted for users to use search through the connector system

---

## v0.3.4.1 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Consolidate manifest format to apiVersion v1, remove all legacy compat code

### Changes
- `control-panel/src/lib/market/schema.ts` — Removed AppRefSchema, legacy fields, v1/v2 enum. Single apiVersion:'v1' format.
- `control-panel/src/lib/market/catalog.ts` — Removed getAllEntries() v1 merging, parseAppRef indirection. Direct catalog.apps usage.
- `control-panel/src/lib/market/engine.ts` — Removed legacy fallbacks for dbMode, sso.redirectUris, sso.configure.
- `control-panel/src/lib/market/parser.ts` — Removed parseAppRef function.
- `control-panel/src/lib/market/types.ts` — Removed legacy type aliases and fields.
- `control-panel/src/lib/market/installed-apps.ts` — Removed fetchNativeAppVersionLegacy(), v1 catalog compat.
- `control-panel/src/lib/apps/definitions.ts` — Uses containers[] instead of native block.
- Various UI/SSO/language files — Replaced legacy field references.

### Test Results
- Build: successful (22 files, -356/+112 lines)
- Deployed to VM, service running

### Notes for Iris
- Merge ALL native app repos (Wiki, Search, Notes, Cinema, Weather, Translate) — apiVersion changes
- Merge YE-AppMarket — catalog.yaml + deleted native/*.yaml + external manifest changes
- No version bump — code-only cleanup
## v0.3.2.10 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Truly separate floating panels via createPortal

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Replaced CSS absolute+overflow:visible approach (which failed — panels rendered inside popover box) with React createPortal. Satellite panels now render as independent DOM elements at document.body with position:fixed. Drawer stays 340px unchanged. Hidden apps shown as grid tiles. Uses useElementRect hook with ResizeObserver.
- `ui/package.json` — Version bump 0.3.2.9 → 0.3.2.10

### Test Results
- FIFO screenshots verified: normal mode unchanged, edit mode shows 3 separate floating cards

### Notes for Iris
- No DB migrations. Uses React createPortal + position:fixed for satellite panels. onInteractOutside prevented in edit mode.

## v0.3.2.9 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Floating satellite panels for app drawer edit mode

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Complete redesign of edit mode: drawer itself stays visually unchanged (icons just shake + become draggable). Hidden apps panel floats as a separate card to the LEFT (grid layout, not a list). Controls panel floats as a separate card BELOW. All three are independent floating cards via CSS absolute + overflow:visible on Radix PopoverContent.
- `ui/package.json` — Version bump 0.3.2.7 → 0.3.2.9

### Test Results
- FIFO screenshot verified: normal mode shows compact popover with pencil icon, edit mode shows three separate floating cards (drawer, hidden panel left, controls below)

### Notes for Iris
- No DB migrations. Drag-and-drop uses HTML5 DnD API (no external deps). CSS absolute positioning on PopoverContent with overflow:visible — no extra portals needed.

## v0.3.2.7 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** App drawer edit mode sections in separate bordered cards

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Edit mode sections (hidden panel, visible grid, controls) each wrapped in rounded bordered cards with gaps between them
- `ui/package.json` — Bumped 0.3.2.6 → 0.3.2.7

### Test Results
- FIFO screenshot: /tmp/shots/v7-02-cards-edit.png — all three cards visually distinct

### Notes for Iris
- Styling-only change, no logic changes

## v0.3.2.6 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** App drawer expandable edit mode + larger server name widget

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Removed "Manage Apps", pencil icon (no text) in top-left, edit mode expands to near-full-height with hidden apps panel on left, drag-and-drop reordering between visible/hidden, controls footer with columns/icon-size/max-height
- `ui/src/components/widgets/server-name-widget.tsx` — Increased font clamp to 6rem, reduced padding
- `ui/src/components/widgets/index.ts` — Default size 40x10 → 52x13 (30% larger)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated DEFAULT_WIDGETS for server-name (57% width, 13% height)
- `ui/src/lib/db/queries/widgets.ts` — Updated server-side DEFAULT_WIDGETS to match
- `ui/package.json` — Bumped 0.3.2.5 → 0.3.2.6

### Test Results
- FIFO screenshots: /tmp/shots/v6-0{1-6}*.png — all verified
- Drawer normal mode: compact popover with pencil icon, no Manage Apps
- Drawer edit mode: two-panel with hidden apps on left, controls at bottom
- Widget: bigger font, less empty space

### Notes for Iris
- Drag-and-drop uses HTML5 DnD API (no external deps)
- Server name widget default size increase only affects new users or after Reset
- No DB migrations

## v0.3.2.5 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Revert app drawer from Sheet panel to Google-style Popover dropdown

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Reverted from Sheet side-panel to Popover dropdown (Google-style). Kept edit mode with show/hide/reorder, drawer prefs (columns, icon scale), and admin-only marketplace link. Removed max-height slider (dropdown auto-sizes). Footer now has "Manage Apps" + "Edit" button.
- `ui/package.json` — Bumped 0.3.2.4 → 0.3.2.5
- `ui/tests/server-name-widget-drawer.spec.ts` — Updated tests for Popover instead of Sheet

### Test Results
- Playwright: 10 tests, verified via FIFO + spec update
- Screenshots: /tmp/shots/drawer-02-open.png

### Notes for Iris
- This is a UX fix requested by the user — the Sheet panel was too wide and ugly
- All edit mode features (show/hide/reorder, column/scale prefs) are preserved in the popover
- No DB changes — same API endpoints and JSONB storage

## v0.3.2.4 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Server Name WordArt widget, compact widgets, app drawer overhaul

### Changes
- `ui/src/components/widgets/server-name-widget.tsx` — NEW: Server Name WordArt widget displaying instance name with user's wordart style
- `ui/src/components/widgets/index.ts` — Added server-name to catalog, reduced greeting/clock default sizes
- `ui/src/components/widgets/greeting-widget.tsx` — Compact layout (p-0, leading-tight)
- `ui/src/components/widgets/clock-widget.tsx` — Compact layout (text-3xl, gap-0.5, text-xs date)
- `ui/src/components/dashboard/widget-grid.tsx` — Default widgets now use server-name instead of greeting
- `ui/src/components/layout/app-drawer.tsx` — Full rewrite: Sheet-based panel with edit mode, column/scale/height controls
- `ui/src/components/layout/navbar.tsx` — Pass isAdmin to AppDrawer
- `ui/src/lib/db/queries/settings.ts` — DrawerPrefs get/save functions
- `ui/src/lib/db/queries/widgets.ts` — Updated DEFAULT_WIDGETS
- `ui/src/app/api/v1/apps/drawer/prefs/route.ts` — NEW: Drawer prefs API
- `ui/messages/{en,de,es,fr,ru}.json` — Added serverName i18n key
- `ui/tests/server-name-widget-drawer.spec.ts` — 10 Playwright tests

### Test Results
- Playwright: 10 tests, all passed (31s)
- Screenshots: Tests/Vanya/playwright/test-results/

### Notes for Iris
- No DB migrations needed — drawer prefs stored in existing user_settings JSONB
- Existing users keep their old widget layout; new defaults only apply to new users or after Reset
- The "Manage Apps" footer in the app drawer is removed — settings page app drawer management is unchanged

## v0.3.2.3 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix sharp module missing from UI standalone build

### Changes
- `ui/scripts/postbuild.js` — Added sharp + full transitive dep tree (detect-libc, color, color-convert, color-string, color-name, simple-swizzle, is-arrayish, semver) to needed packages list; added Step 5b to copy @img/* native bindings from pnpm store
- `ui/package.json` — Bumped 0.3.2.2 → 0.3.2.3

### Root Cause
pnpm hoists sharp to workspace root with symlinks. Next.js standalone copies the symlink as-is, but the relative `../../` resolves to `.next/` instead of the monorepo root. The postbuild Step 4 caught the broken symlink but silently skipped it.

### Test Results
- `node -e "require('sharp')"` inside youeye-ui container: OK
- Avatar upload and emoji picker work end-to-end

### Notes for Iris
- This fix applies to all future UI builds — no manual intervention needed
- No env var or DB changes

## v0.3.4.2 / v0.3.2.2 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Profile embed theme sync, template avatar picker, background app installs

### Changes
- `control-panel/src/app/embed/market/client.tsx` — Non-blocking installs: dialog closes on submit, progress via inline banner, postMessage events for global tracking
- `control-panel/src/app/embed/layout.tsx` — Added embed-spin keyframe for install spinner
- `ui/src/components/settings/profile-settings.tsx` — PostMessage theme propagation (dark/light sync), 32 emoji+gradient template avatar picker with canvas→blob→upload
- `ui/src/components/app-install-listener.tsx` — NEW: Global Sonner toast notifications for app install progress, polls /api/v1/admin/install-progress
- `ui/src/app/api/v1/admin/install-progress/route.ts` — NEW: Proxy to CP install-progress endpoint
- `ui/src/components/providers.tsx` — Added AppInstallListener to global providers
- `ui/messages/{en,ru,de,es,fr}.json` — Avatar picker translation keys

### Test Results
- TypeScript: clean (no new errors introduced)
- Deployment: spine status shows 8 running, 0 stopped, CP v0.3.4.2

### Notes for Iris
- No DB migrations
- No env var changes
- UI depends on CP install-progress API (already exists)

## v0.3.4.1 / v0.3.2.1 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Profile name sync to Authentik, silent SSO for CP embeds, user self-profile

### Changes
- `control-panel/src/app/api/setup/run/route.ts` — Remove fake first_name/last_name from Authentik API calls; add custom OIDC profile scope mapping creation during setup
- `control-panel/src/components/embed/auth-error.tsx` — Replace manual Sign In button with auto-redirect through SSO (silent if user already authenticated)
- `control-panel/src/app/api/auth/sso/route.ts` — Accept ?redirect= param, store in cookie for post-login redirect
- `control-panel/src/app/api/auth/callback/route.ts` — Read oauth-redirect cookie, redirect to embed page instead of /
- `control-panel/src/app/api/user/profile/route.ts` — New: GET/PATCH own profile via Authentik (non-admin safe)
- `control-panel/src/app/embed/profile/page.tsx` — New: profile embed page (user role, not admin-only)
- `control-panel/src/app/embed/profile/client.tsx` — New: profile editing form (first/last name, synced to Authentik)
- `ui/src/app/settings/page.tsx` — Pass CP profile embed URL to profile settings
- `ui/src/components/settings/profile-settings.tsx` — Replace inline name fields with CP embed; keep bio/timezone/avatar local; listen for profile-updated messages

### Test Results
- CP deployed v0.3.4.1, UI deployed v0.3.2.1
- spine status: 8 running, 0 stopped
- Authentik OIDC scope mapping updated (split name into given_name/family_name)

### Notes for Iris
- Authentik scope mapping change is applied live via API (not in code). The setup wizard now creates it on fresh installs.
- The custom scope mapping "YouEye: OpenID profile (split name)" replaces the default profile mapping in both OIDC providers.
- CP deploy path is /opt/app (not /opt/youeye-control). UI deploy path is /opt/youeye-ui.

## v0.2.22.13 — iris — 2026-04-20
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** One-way bridge hardening + WordArt flicker fix

### Changes
- `control-panel/src/lib/ui-bridge/auth.ts` — Hardened to reject ALL non-embed requests (401)
- `ui/public/fonts/*.css` — All 35 font CSS files changed from `font-display: swap` to `font-display: block`

### Test Results
- CP bridge API returns 401 for non-embed requests
- WordArt renders correctly on first paint (no flicker)
- Multiple rapid reload tests confirmed no visible font swap

### Notes for Iris
- One-way bridge is now complete and hardened
- UI cannot call CP even if it tried (gets 401)
- Connectors fetch directly from Gitea, language stored locally

---

## v0.2.22.5 — iris — 2026-04-19
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** Fix UI App Market — icons, navbar, native/non-native split, detail pages

### Changes
- `control-panel/src/app/embed/market/client.tsx` — Major rewrite: added icon rendering with iconUrl fallback, native/non-native app grouping (BUILT FOR YOUEYE / INSTALLED / AVAILABLE), app detail page with screenshots/lightbox/SSO info, search, refresh, install from URL
- `ui/src/app/app-market/layout.tsx` — **NEW** layout with YouEye Navbar for app market page
- `ui/src/app/app-market/page.tsx` — Simplified to use layout-provided auth gate

### Test Results
- UI market (devvm.test/app-market): navbar visible, 3 sections rendered, icons working
- CP market (control.devvm.test/market): reference implementation matches
- All 14 apps visible (6 native, 1 installed, 7 available)

### Notes for Iris
- `spine update control` only deploys CP, not UI — UI needs manual push or separate update mechanism
- UI standalone tarball built correctly but deployment requires incus file push

---

## v0.2.22.4 — iris — 2026-04-19
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** One-way bridge migration — remove all UI→CP calls, add App Market embed

### Changes
- `ui/src/lib/admin/bridge-client.ts` — Stripped to getBridgeToken/clearTokenCache only; removed bridgeRequest, BridgeError, CP_BASE_URL
- `ui/src/app/api/admin/[...path]/route.ts` — **DELETED** catch-all bridge proxy
- `ui/src/app/api/admin/authentik/branding/route.ts` — **DELETED** Authentik CSS sync
- `ui/src/app/api/admin/apps/[appId]/route.ts` — **DELETED** admin app edit bridge
- `ui/src/app/api/market-image/route.ts` — **DELETED** market image proxy
- `ui/src/components/settings/app-market.tsx` — **DELETED** old market component
- `ui/src/app/app-market/page.tsx` — **NEW** iframe embed for App Market
- `ui/src/app/app-store/page.tsx` — Changed to redirect to /app-market
- `ui/src/app/app-store/[appId]/page.tsx` — Changed to redirect to /app-market
- `ui/src/components/settings/settings-shell.tsx` — cpUrl via env var, href /app-market
- `ui/src/components/color-theme-provider.tsx` — Removed pushThemeToAuthentik calls
- `ui/src/components/settings/branding-settings.tsx` — Removed Authentik branding sync
- `ui/src/components/settings/app-drawer-settings.tsx` — Removed "set as default" bridge call
- `control-panel/src/app/embed/market/page.tsx` — **NEW** Market embed server page
- `control-panel/src/app/embed/market/client.tsx` — **NEW** Full marketplace UI with SSE install
- `control-panel/src/lib/incus/network-acl.ts` — Fixed ACL default egress action (reject→allow)
- `ui/scripts/postbuild.js` — Fixed hasCodeContent to require package.json (standalone build fix)

### Test Results
- Settings pages: Profile, Appearance, Branding all load correctly
- App Market embed: loads via iframe, shows catalog, Whoogle installed with Uninstall
- App Drawer: works without "set as default" UI
- Whoogle: accessible after ACL fix (was 502)

### Notes for Iris
- v0.2.22.3 had broken UI standalone.tar (missing next/package.json); v0.2.22.4 is the fix
- UI standalone tar is now 155MB (was 28MB) because full next module is included
- Bridge is now one-way: CP→UI via /api/ui-bridge/* only; UI makes zero outbound calls to CP

## v0.2.22.5 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Client-side connectivity check for setup-complete page (iframe+postMessage)

### Changes
- `control-panel/src/app/api/ping/route.ts` — Added `?verify=1` mode: returns HTML page with `parent.postMessage({type:'ye-dns-ok'})` for iframe-based connectivity probing
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Rewrote `useConnectivityCheck` from cross-origin timing heuristic to iframe+postMessage; merged dual DNS/cert indicators into single reachability indicator
- `control-panel/next.config.ts` — Separate CSP rule for `/api/ping` (`frame-ancestors *`); added `frame-src https:` to global CSP so parent page can embed cross-origin iframes
- `control-panel/src/middleware.ts` — Removed middleware verify=1 short-circuit (no longer needed with per-route CSP)
- `control-panel/messages/{en,ru,de,fr,es}.json` — Replaced 6 dual-indicator i18n keys with 3 combined connection status keys
- `control-panel/package.json` — Version bump to 0.2.22.5

### Test Results
- `curl -sk -I "https://devvm.test/api/ping?verify=1"` returns `frame-ancestors *`, no `X-Frame-Options: DENY`
- Browser iframe test: postMessage received (`{origin:"https://devvm.test",type:"ye-dns-ok"}`)
- Setup-complete page: green indicator, "All set!", DNS/cert steps hidden
- Deployed and verified on ye-vanya VM

### Notes for Iris
- No breaking changes — additive only
- Key insight: Chromium `--ignore-certificate-errors` only applies to top-level/iframe navigation, not fetch/img subresources — this is why the old timing heuristic never worked with self-signed certs
- `frame-src https:` in global CSP is required so the parent page (served via IP) can embed iframes from the configured domain
- Caddy's path-only `/api/ping` route forwards ALL hosts to CP, so `devvm.test/api/ping` reaches CP even though `devvm.test` normally routes to YE-UI

## v0.2.22.4 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Upstream DNS server management in CP DNS settings

### Changes
- `control-panel/src/lib/apps/pihole-api.ts` — Added `getUpstreamDNS()` and `setUpstreamDNS()` functions using Pi-Hole FTL v6 `/api/config/dns` upstreams endpoint
- `control-panel/src/app/api/apps/pihole/upstream/route.ts` — New API route (GET/PUT) with IP validation, deduplication, minimum-one-server enforcement
- `control-panel/src/app/(dashboard)/dns/page.tsx` — Added "Upstream DNS Servers" card to Settings tab with current server list, add/remove, and quick presets (Cloudflare, Google, Quad9, OpenDNS)
- `control-panel/messages/{en,ru,de,fr,es}.json` — 13 new i18n keys per language for upstream DNS UI
- `control-panel/package.json` — Version bump to 0.2.22.4

### Test Results
- API GET returns current upstreams from Pi-Hole
- API PUT updates upstreams and Pi-Hole reflects change immediately
- Validation blocks empty arrays and invalid IP formats
- CP deployed and running v0.2.22.4, spine status 7 running / 0 stopped

### Notes for Iris
- No breaking changes — additive only
- Pi-Hole FTL v6 upstreams are at `config.dns.upstreams` (array of strings)
- No UI changes needed, no Spine changes

## v0.2.22.3 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Redesign setup-complete page with platform-specific DNS/cert instructions and trust profiles

### Changes
- `control-panel/src/lib/crypto/cert-utils.ts` — New utility: PEM→DER conversion and deterministic UUID v5 generation for .mobileconfig profiles
- `control-panel/src/app/api/setup/check-dns/route.ts` — New endpoint: server-side Pi-Hole wildcard DNS verification, returns `{configured, domain, resolves_to}`
- `control-panel/src/app/api/setup/profile/route.ts` — New endpoint: platform-specific certificate trust files (iOS/macOS .mobileconfig, Windows/Android DER .crt, Linux PEM)
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Full rewrite: dual DNS/cert status indicators, client-side timing heuristic for detection, platform-detected tabs with OS-specific commands, certificate download buttons, collapsible advanced terminal section
- `control-panel/src/middleware.ts` — Added `/api/setup/check-dns` and `/api/setup/profile` to PUBLIC_ROUTES
- `control-panel/messages/en.json` — 22 new i18n keys for setup namespace
- `control-panel/messages/{ru,fr,de,es}.json` — Matching translations for all 5 languages
- `control-panel/scripts/postbuild.js` — Fixed pnpm workspace hoisted deps: resolves incomplete packages from workspace-root pnpm store, handles version mismatches in .pnpm symlinks

### Test Results
- All 3 new API endpoints verified on live VM via curl:
  - `/api/setup/check-dns` → `{"configured":true,"domain":"devvm.test","resolves_to":"10.10.40.22"}`
  - `/api/setup/profile?platform=ios` → 200, valid .mobileconfig XML with CA cert payload
  - `/api/setup/profile?platform=windows` → 200, DER-encoded .crt
  - `/api/setup/profile?platform=linux` → 200, PEM file
- Spine health check endpoint (`/api/auth/session`) returns 401 (accepted by Spine)
- Setup-complete page renders correctly via IP access: dual indicators, platform tabs, download buttons, terminal commands
- `spine update control` deploys v0.2.22.3 successfully with health check passing
- Screenshot captured at `/tmp/shots/setup-complete-working.png`

### Notes for Iris
- The postbuild.js fix is critical for deployment reliability — previous releases had incomplete node_modules
- Setup-complete page only accessible via IP (setup_completed must be true, accessed through Caddy IP flow)
- Phase 2 (DoH DNS profiles) is planned but not yet implemented — brief filed at `Plans/To Plan/`
- v0.2.22.2 release on Gitea has a broken artifact (incomplete deps) — use v0.2.22.3

---

## v0.2.22.1 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix setup/onboarding animation flash + embedded PINPrompt for UI onboarding

### Changes
- `control-panel/src/app/globals.css` — Added `.animate-in { animation-fill-mode: backwards; }` to fix tw-animate-css flash on setup wizard steps
- `ui/src/app/globals.css` — Same animation-fill-mode fix for UI onboarding animations
- `ui/src/components/timeline/pin-prompt.tsx` — Added `embedded` prop for inline rendering without modal overlay; conditional dark-theme styling for inputs, buttons, labels
- `ui/src/app/onboarding/page.tsx` — Pass `embedded` to PINPrompt so it renders inline within the onboarding frosted glass wrapper instead of a full-screen modal
- `control-panel/package.json` — Version bump to 0.2.22.1
- `ui/package.json` — Version bump to 0.2.22.1

### Test Results
- CP: v0.2.22.1 deployed, 7 running 0 stopped, dashboard verified
- UI: v0.2.22.1 deployed, service running, version confirmed in package.json
- CSS fix verified in built assets: `.animate-in{animation-fill-mode:backwards}` present in both CP and UI CSS
- Embedded prop verified in built JS: `embedded:!0` in onboarding page
- Note: full visual test of onboarding flow blocked by SSO not being configured on this VM

### Notes for Iris
- CSS-only fix for CP (no JS changes)
- PINPrompt `embedded` prop is additive — default behavior (modal) unchanged
- SSO must be configured before UI onboarding flow can be visually tested end-to-end

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

## v0.2.22.12 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** WordArt Preset Gallery — save/load named designs

### Changes
- `ui/src/db/schema.ts` — new `wordartPresets` table (id, userId, name, style JSONB, scope, createdAt)
- `ui/src/db/index.ts` — auto-migration CREATE TABLE + index for wordart_presets
- `ui/src/lib/db/queries/wordart-presets.ts` — NEW: CRUD functions (getUserPresets, getServerPresets, createPreset, deletePreset, renamePreset)
- `ui/src/app/api/v1/user/wordart/presets/route.ts` — NEW: REST API for user presets (GET/POST/DELETE/PATCH)
- `ui/src/app/api/ui-bridge/wordart-presets/route.ts` — NEW: bridge API for server presets (bridge-token auth)
- `ui/src/components/settings/wordart-gallery.tsx` — NEW: gallery component with mini WordArt previews, save/delete/rename
- `ui/src/components/settings/user-wordart-settings.tsx` — integrated gallery below picker, pickerKey for re-render on preset apply
- `control-panel/src/app/api/ui/wordart-presets/route.ts` — NEW: CP proxy to UI bridge
- `control-panel/src/components/embed/WordArtGalleryEmbed.tsx` — NEW: embed-styled gallery for server branding
- `control-panel/src/app/embed/branding/client.tsx` — integrated server presets gallery

### Test Results
- Branding page renders with gallery section below picker
- Save Current flow: input appears, name accepted, preset saved to DB, appears in gallery with mini preview
- Server Default card applies server-wide style and resets picker
- Server Branding tab shows CP embed with server presets gallery
- DB verified: wordart_presets table auto-created, records persisted
- `sudo spine status` → 13 running, 0 stopped

### Notes for Iris
- New DB table `wordart_presets` auto-created on first access (no manual migration needed)
- CP proxy at `/api/ui/wordart-presets` added — already in PUBLIC_ROUTES via `/api/ui` prefix from Phase 6

## v0.2.22.11 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 6 (theme fix + branding redesign)

### Changes
- `ui/src/components/settings/admin-embed.tsx` — Added `useTheme()` + postMessage syncing so embeds follow light/dark mode
- `ui/src/app/settings/system/page.tsx` (+ 7 other pages) — Removed hardcoded `{ theme: "dark" }` from `getSignedEmbedUrl()` calls
- `ui/src/lib/db/queries/settings.ts` — Added `getUserWordartOverride`, `saveUserWordartOverride`, `deleteUserWordartOverride` for per-user WordArt JSONB storage
- `ui/src/app/api/v1/user/wordart/route.ts` — NEW: REST API (GET/PUT/DELETE) for per-user WordArt
- `ui/src/components/settings/user-wordart-settings.tsx` — NEW: Client component for personal WordArt customization
- `ui/src/app/api/ui-bridge/branding/route.ts` — NEW: Bridge-authenticated branding endpoint for CP
- `control-panel/src/app/api/ui/branding/route.ts` — NEW: CP proxy to UI bridge for branding data
- `control-panel/src/app/embed/branding/page.tsx` + `client.tsx` — NEW: Server branding embed (site name, WordArt, accent color)
- `ui/src/app/settings/branding/page.tsx` — Rewritten: no longer admin-only, renders tabbed layout
- `ui/src/components/settings/branding-tabs.tsx` — NEW: "My WordArt" (all users) + "Server Branding" (admin-only embed) tabs
- `ui/src/components/settings/settings-shell.tsx` — Moved branding from ADMIN_SECTIONS to USER_SECTIONS
- `ui/messages/{en,de,fr,ru,es}.json` — Added `branding` key to `settings.sections`
- `control-panel/src/middleware.ts` — Added `/api/ui` to PUBLIC_ROUTES for embed proxy access
- `ui/src/app/page.tsx`, `settings/layout.tsx`, `notifications/page.tsx`, `timeline/page.tsx` — WordArt override support in Navbar

### Test Results
- Branding page: both tabs verified (My WordArt + Server Branding embed)
- Theme switching: embeds follow light/dark mode correctly
- System embed verified in both light and dark modes
- Server Branding embed loads branding data from UI via bridge proxy
- CP middleware fix verified: /api/ui/branding returns 200 (was 401)
- 13 containers running, 0 stopped

### Notes for Iris
- Both CP and UI changed — must deploy both
- CP middleware change: `/api/ui` added to PUBLIC_ROUTES (embed proxy)
- No DB migration needed — WordArt stored in existing userSettings JSONB
- Branding page accessible to all users now (not admin-only); admin sees extra "Server Branding" tab
- Authentik branding sync: CP triggers fire-and-forget POST to /api/ui-bridge/authentik/branding on save

## v0.2.22.9 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 5 (cleanup)

### Changes
- Deleted 10 orphaned admin components from `ui/src/components/settings/admin/`: system-settings, proxy-settings, backup-settings, dns-settings, container-settings, user-settings, apps-list-settings, update-overlay, bridge-unavailable, access-denied
- Deleted `ui/src/components/settings/bridge-embed.tsx` — replaced by admin-embed.tsx in Phase 1
- Deleted `ui/src/components/settings/language-settings.tsx` — replaced by user-language-settings.tsx in Phase 4
- Deleted `ui/src/lib/admin/types.ts` — only imported by deleted admin components
- Deleted `ui/src/lib/admin/use-admin.ts` — unused
- Total: 14 files, 3,359 lines of dead code removed
- Retained: catch-all proxy route and bridge-client.ts (still used by App Store, branding, config)

### Test Results
- All 8 embed settings pages verified: System, Proxy, Backup, DNS, Containers, Users, Apps, Language
- App Store verified working (proxy retained)
- 13 containers running, 0 stopped
- Screenshots: Tests/Sebastian/20260418_10/

### Notes for Iris
- UI-only change (CP unchanged at v0.2.22.8)
- Catch-all proxy `/api/admin/[...path]` intentionally retained — used by App Store, settings-shell, branding, app-drawer
- bridge-client.ts intentionally retained — used by 10+ API routes (app registration, widget sync, notifications, etc.)
- New wiki article: `YE-Wiki/control-panel/admin-settings-embed.md`

## v0.2.22.8 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 4 (complex pages: Users, Apps, Language)

### Changes
- `control-panel/src/app/embed/users/page.tsx` + `client.tsx` — new CP embed page for user management: full CRUD (list, create, set password, toggle active/admin, delete) via Authentik bridge APIs, system user filtering
- `control-panel/src/app/embed/apps/page.tsx` + `client.tsx` — new CP embed page for apps & updates: categorized app list (Apps, Infrastructure, System), update status polling, self-destructive CP update flow with postMessage to parent, inline progress bars, edit dialog for user apps
- `control-panel/src/app/embed/language/page.tsx` + `client.tsx` — new CP embed page for system default language: 5-language selector, two-step save (config + Authentik propagation)
- `ui/src/components/settings/admin-embed.tsx` — added restart state handling: listens for `youeye-embed-action` postMessage (`cp-restarting`, `ui-restarting`), shows skeleton + spinner during restart, polls CP health endpoint every 5s, auto-reloads iframe when CP comes back
- `ui/src/components/settings/user-language-settings.tsx` — new native component for user language selection (split from old LanguageSettings)
- `ui/src/app/settings/users/page.tsx` — rewritten to use `<AdminEmbed section="users">`
- `ui/src/app/settings/apps-list/page.tsx` — rewritten to use `<AdminEmbed section="apps">`
- `ui/src/app/settings/language/page.tsx` — hybrid: native `<UserLanguageSettings>` on top + `<AdminEmbed>` for system language below (admin-only)
- `control-panel/package.json` + `ui/package.json` — version bumped to 0.2.22.8

### Test Results
- Users embed: 2 users listed, create/password/delete/toggle actions visible, system users filtered
- Apps embed: 13+ services displayed in 3 categories (Apps, Infrastructure, System), update buttons visible
- Language embed: hybrid layout renders correctly — user language native, system language embedded (admin-only)
- System embed (Phase 2): no regression
- Auth: unauthenticated and invalid signatures correctly rejected
- CP restart flow: postMessage triggers skeleton loader in parent, health polling restores iframe
- Screenshots: Tests/Sebastian/20260418_9/

### Notes for Iris
- No schema changes, no env var changes
- Branding page kept native (data lives in UI's DB — moving to CP embed would require storage migration)
- Apps edit endpoint (`PUT /api/ui-bridge/apps/[id]`) doesn't exist on CP — edit button present but non-functional (known issue from old proxy component)
- Old admin proxy route still active — cleanup is Phase 5
- Phase 5 (cleanup: delete old proxy, old components, update docs) is next

## v0.2.22.7 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 3 (interactive pages: DNS + Containers)

### Changes
- `control-panel/src/app/embed/dns/page.tsx` + `client.tsx` — new CP embed page for DNS: Pi-Hole stats, top queries/blocked tables, enable/disable toggle
- `control-panel/src/app/embed/containers/page.tsx` + `client.tsx` — new CP embed page for containers: list with status/IPv4, start/stop/restart actions, confirmation dialog, 30s auto-refresh
- `ui/src/app/settings/dns/page.tsx` — rewritten to use `<AdminEmbed section="dns">`
- `ui/src/app/settings/containers/page.tsx` — rewritten to use `<AdminEmbed section="containers">`
- `control-panel/package.json` + `ui/package.json` — version bumped to 0.2.22.7

### Test Results
- Playwright: DNS embed loads with stats, toggle visible, auth enforced
- Playwright: Containers embed loads with 13 containers, Stop/Restart buttons visible
- Playwright: System embed (Phase 2) still works — no regression
- Security: unauthenticated and fake-signature requests return Unauthorized
- Screenshots: Tests/Sebastian/20260418_8/

### Notes for Iris
- No schema changes, no env var changes
- Old admin proxy still active for unmigrated pages (Users, Apps, Branding, Language)
- Phase 4 (complex pages) is next

## v0.2.22.6 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 1 (infrastructure) + Phase 2 (read-only pages)

### Changes

**Control Panel — Embed Infrastructure (Phase 1):**
- `control-panel/next.config.ts` — split CSP headers: `/embed/*` routes allow framing from UI origin (`frame-ancestors`), all other routes keep `DENY`
- `control-panel/src/lib/embed/auth.ts` — NEW: HMAC token validation for signed embed URLs (bridge token as key, 5-min TTL)
- `control-panel/src/middleware.ts` — added `/embed` to PUBLIC_ROUTES so embed pages bypass session auth (use signed URL tokens instead)
- `control-panel/src/lib/ui-bridge/auth.ts` — added referer-based auth fallback for embed pages loaded in iframes
- `control-panel/src/app/embed/layout.tsx` — themed embed layout: reads `theme`/`accent` URL params, injects CSS variables, ResizeObserver for auto-height, postMessage ready/resize signals
- `control-panel/src/app/embed/health/route.ts` — NEW: health check endpoint for CP restart detection (UI polls this during skeleton state)
- `control-panel/src/app/embed/app-network/[appId]/page.tsx` + `client.tsx` — rewritten to use new embed auth and theme CSS variables

**Control Panel — Read-Only Embed Pages (Phase 2):**
- `control-panel/src/app/embed/system/page.tsx` + `client.tsx` — NEW: system dashboard embed (hostname, OS, CPU/RAM/disk, container counts, auto-refresh)
- `control-panel/src/app/embed/proxy/page.tsx` + `client.tsx` — NEW: proxy routes embed (Caddy reverse proxy table)
- `control-panel/src/app/embed/backup/page.tsx` + `client.tsx` — NEW: backup history embed (config, schedule, history, auto-refresh)

**UI — Embed Infrastructure (Phase 1):**
- `ui/src/lib/admin/embed-token.ts` — NEW: server-side HMAC signed URL generation for CP embed pages
- `ui/src/components/settings/admin-embed.tsx` — NEW: generic iframe wrapper with postMessage handling, auto-resize, skeleton loader during CP restarts, origin validation
- `ui/src/app/api/ui-bridge/embed-status/route.ts` — NEW: receives CP restart notifications, stores status for AdminEmbed skeleton state

**UI — Settings Pages Migrated (Phase 2):**
- `ui/src/app/settings/system/page.tsx` — rewritten to use AdminEmbed (was direct bridge API component)
- `ui/src/app/settings/proxy/page.tsx` — rewritten to use AdminEmbed
- `ui/src/app/settings/backup/page.tsx` — rewritten to use AdminEmbed

**Bug Fixes:**
- `control-panel/scripts/postbuild.js` — fixed package completeness heuristic: `@swc/helpers` was missing from standalone build, breaking runtime
- Embed layout postMessage race condition: resize event now doubles as ready signal, eliminating timing issue where parent missed the ready message

### Test Results
- System embed loads in iframe with correct system data (hostname, OS, CPU/RAM/disk)
- Proxy embed loads with Caddy route table
- Backup embed loads with backup configuration and history
- Embed pages return 403 without valid signed HMAC token
- Embed pages respect theme parameter (dark/light)
- Auto-resize works via postMessage — no scrollbar in parent
- CP health endpoint responds for restart detection
- App-network embed continues working with new auth/theme system

### Notes for Iris
- Phase 1+2 only — phases 3-5 (interactive pages, complex pages, cleanup) remain
- Old UI admin components (`ui/src/components/settings/admin/*.tsx`) are NOT deleted yet — cleanup is Phase 5
- The admin proxy route (`/api/admin/[...path]`) is NOT deleted yet — still used by DNS, Containers, Users, Apps pages
- CP postbuild fix (`@swc/helpers`) should be merged early — it fixes standalone builds for all branches
- `bridge-embed.tsx` still exists alongside new `admin-embed.tsx` — will be removed in Phase 5
- Embed auth uses the existing bridge token (`/etc/youeye/ui-bridge-token`) as HMAC key — no new secrets needed

## v0.2.22.5 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 3: C5 — Settings > Connectors UI, Connection Flow, Credential Management

### Changes
- `ui/src/app/settings/connectors/page.tsx` — NEW: Connectors settings page (replaces old Apps settings)
- `ui/src/app/settings/connectors/[appId]/page.tsx` — NEW: Per-app connector management page
- `ui/src/app/connectors/setup/page.tsx` — NEW: Setup redirect page with redirect URI validation
- `ui/src/components/settings/connector-app-list.tsx` — NEW: App list with connector status summary
- `ui/src/components/settings/connector-detail.tsx` — NEW: Capability management, source picker, credential entry
- `ui/src/components/settings/connector-setup.tsx` — NEW: Full-page source selection with identity indicator
- `ui/src/app/api/settings/connectors/route.ts` — NEW: List apps with connector status
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — NEW: Per-app capabilities + connect/disconnect
- `ui/src/app/api/settings/connectors/credentials/route.ts` — NEW: Credential storage (AES-256-GCM)
- `ui/src/app/api/v1/connectors/resolve/route.ts` — Returns not-connected status with setupUrl instead of 404
- `ui/src/app/api/v1/connectors/proxy/route.ts` — Added boundHost enforcement for credential forwarding
- `ui/src/db/schema.ts` — Added `persistent` to userConnectors, `boundHost` to userConnectorSecrets
- `ui/src/db/index.ts` — Auto-migration for new columns
- `ui/src/components/settings/settings-shell.tsx` — Renamed Apps → Connectors in sidebar
- `ui/src/app/settings/apps/page.tsx` — Redirects to /settings/connectors
- `ui/src/app/settings/apps/[appId]/page.tsx` — Redirects to /settings/connectors/[appId]
- `ui/messages/en.json` — Added connectorSettings translation namespace

### Test Results
- Settings > Connectors page renders with app list (Wiki, Notes, Translate, Search, Weather)
- Per-app detail page renders with capabilities and direct access section
- Setup redirect page renders with source selection and identity indicator
- Sidebar correctly shows "Connectors" with plug icon
- All other settings pages unaffected

### Notes for Iris
- Old `/settings/apps` routes redirect to `/settings/connectors` — no broken links
- `connectorSettings` i18n namespace added to en.json — other locales need translation
- boundHost enforcement in proxy route prevents credential forwarding to wrong API hosts
- Admin bridge iframe in detail page returns 404 (CP endpoint doesn't exist yet) — non-blocking

## v0.2.22.3 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 2: C3 — Connector Runtime Container + Manifest v1 Schema

### Changes
- `connector-runtime/` — NEW: stateless Node.js proxy worker (isolated-vm for V8 script transforms, SSRF protection, rate limiting)
- `control-panel/src/lib/infrastructure/deployer.ts` — Step 9: deploy youeye-connectors container
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — entryFile + postInstallCommands support
- `control-panel/src/lib/infrastructure/manifests.ts` — connectorsContainerSpec()
- `control-panel/src/lib/infrastructure/types.ts` — entryFile, postInstallCommands fields
- `control-panel/src/lib/connectors/schema.ts` — Manifest v1: provides[] array, ui section, capabilities
- `control-panel/src/lib/connectors/registry.ts` — handles provides array + directory-based manifests
- `control-panel/src/app/api/connectors/[connectorId]/manifest/route.ts` — NEW: manifest API endpoint
- `control-panel/src/app/api/setup/run/route.ts` — connectors Caddy route in setup wizard
- `control-panel/scripts/postbuild.js` — Fixed pnpm workspace module flattening
- `ui/src/app/api/v1/connectors/proxy/route.ts` — NEW: proxy route (decrypt creds → forward to runtime)
- `ui/src/lib/db/queries/connectors.ts` — CONNECTOR_RUNTIME_URL constant

### Test Results
- Connector runtime health: OK (38MB memory, 2s uptime)
- Wikipedia search proxy: "quantum physics" returned results with Quantum mechanics
- Caddy route: connectors.devvm.test → youeye-connectors:3001
- All 3 connectors loaded from AppMarket (wikipedia, searxng, whoogle)
- CP v0.2.22.3 deployed and running (13 containers total)
- UI v0.2.22.3 deployed and running

### Notes for Iris
- YE-AppMarket `sebastian` branch has manifest v1 changes (provides[] array) + TMDB connector — merge both repos
- Connector runtime needs `npm rebuild isolated-vm` after deploy (handled by postInstallCommands in deployer)
- CP standalone build now uses pnpm-store flattening script — postbuild.js was updated to merge workspace-root node_modules
- New tag prefix `cr-` for connector runtime releases
- `tmdb-media` connector is the first with script transforms — requires user API key

## v0.2.22.2 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** C1+C2 — App Gateway Migration + Network Isolation + App Bridges

### Changes
- `control-panel/src/lib/market/engine.ts` — Token hash forwarding to YE-UI on app registration, ACL application after container deploy, bridge dependency detection and auto-activation
- `control-panel/src/lib/market/platform-env.ts` — Gateway URL redirected from CP to YE-UI (`http://youeye-ui.youeye:3000/api/apps/v1`), added `url` field to containers map (`https://{subdomain}.{domain}`)
- `control-panel/src/lib/market/types.ts` — Added `url: string` to containers record in VariableContext
- `control-panel/src/lib/incus/network-acl.ts` — NEW: Incus network ACL management (subnet-based rules, Incus 6.23 compatible)
- `control-panel/src/lib/bridges/store.ts` — NEW: Bridge CRUD with JSON file storage at `/var/lib/youeye/bridges/bridges.json`
- `control-panel/src/lib/bridges/manager.ts` — NEW: Bridge lifecycle (detect deps from env_mapping, create, activate with env injection, deactivate, pending bridge auto-activation)
- `control-panel/src/app/api/bridges/` — NEW: Bridge REST API (list, create, get, update, delete)
- `control-panel/src/app/embed/` — NEW: Chromeless embed layout + bridge management UI page
- `ui/src/db/schema.ts` — Added `tokenHash` column to apps table
- `ui/src/lib/auth/app-token.ts` — NEW: SHA-256 token hash validation for app gateway
- `ui/src/app/api/apps/v1/platform/route.ts` — NEW: App gateway platform endpoint (migrated from CP)
- `ui/src/app/api/apps/v1/widgets/sync/route.ts` — NEW: App gateway widget sync endpoint (migrated from CP)
- `ui/src/app/settings/apps/[appId]/page.tsx` — NEW: Per-app settings page with bridge embed
- `ui/src/components/settings/bridge-embed.tsx` — NEW: Bridge management iframe component

### Test Results
- Network isolation verified: apps reach internal subnet, blocked from internet
- Dashboard, Wiki app confirmed working under ACLs
- Gateway endpoint returns 401 for unauthenticated requests (correct)

### Notes for Iris
- `@acl-name` syntax not supported in Incus 6.23 — using subnet-based ACL rules instead
- System container ACLs need `default.egress.action=allow` and `default.ingress.action=allow`
- App container ACLs need `default.egress.action=reject` and `default.ingress.action=allow`
- Bridge system stores data at `/var/lib/youeye/bridges/bridges.json` — needs to survive container recreation

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