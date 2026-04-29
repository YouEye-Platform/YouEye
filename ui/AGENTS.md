## v0.3.4.6 — sebastian — 2026-04-29
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix info card providers to live-fetch runtime manifests from app containers (Session 38)

### Changes
- `src/lib/db/queries/app-management.ts` — Rewrote `getInfoCardProviders()` to live-fetch each app's `/api/manifest` via `fetchAppManifest()` + `discoverAppUpstreams()` (Caddy IP discovery), with `Promise.allSettled()` for fault tolerance and DB manifest as fallback. Previously read `info_cards` from the stored installation manifest which never contains this field.
- `package.json` — Version bump to 0.3.4.6

### Test Results
- API verified: `GET /api/v1/apps/info-cards` now returns Cinema provider with triggers `["imdb.com", "themoviedb.org"]` and `embed_path: "/embed/card/movie"` (was returning `{ providers: [] }`)
- `sudo spine status` → 14 running, 1 stopped
- UI service healthy after deploy

### Notes for Iris
- This follows the exact same pattern as `getAppWidgetDeclarations()` (same file, lines 256-301) which already live-fetches widget declarations
- The stored installation manifest (youeye-file.yml format) never contains `info_cards` — only the app's runtime `/api/manifest` declares them
- Falls back to DB manifest if live fetch fails, so existing behavior is preserved for apps whose containers are down

## v0.3.4.5 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix pending_timeline_events schema + accept manifest from CP during registration (Session 37)

### Changes
- `src/db/index.ts` — Added `CREATE TABLE IF NOT EXISTS pending_timeline_events` to `ensureSchema()`. Table was defined in Drizzle schema but never created at runtime.
- `src/app/api/v1/apps/register/route.ts` — Accept `manifest` field from CP request body as fallback when live fetch from app container fails (timing race during install).
- `package.json` — Version bump to 0.3.4.5

### Test Results
- Table creation verified via `\dt pending_timeline_events` in postgres
- Timeline pending entry verified in DB after Cinema movie view
- `curl -sk https://localhost/api/ping` → `{"status":"ok"}`

### Notes for Iris
- The manifest fallback ensures apps.manifest column is populated even if the app container isn't fully started when registration runs
- pending_timeline_events was the missing piece for timeline event queuing when no PIN session is active

## v0.3.4.4 — sebastian — 2026-04-28
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Timeline embed system — iframe embeds with structured data fallback (Session 35)

### Changes
- `src/lib/db/queries/timeline.ts` — Added embed_path to TimelineEntryData interface, documented standard data fields, updated processPendingEvents to carry embed_path
- `src/app/api/v1/timeline/route.ts` — Pass embed_path through to both encrypt-immediately and queue-for-later paths
- `src/app/api/v1/timeline/[collection]/route.ts` — Same embed_path pass-through for collection-specific endpoint
- `src/components/timeline/timeline-embed.tsx` — NEW: Core component — IntersectionObserver lazy loading, iframe rendering, postMessage protocol, 5s timeout fallback to StandardCard
- `src/components/timeline/timeline-entry-card.tsx` — REWRITTEN: embed_path support, domain prop, expanded TYPE_ICONS, render chain: embed_path -> TimelineEmbed -> legacy InfoCard
- `src/components/timeline/timeline-feed.tsx` — Added embed_path to interface, baseDomain derivation, passes domain to cards

### Test Results
- Code changes only, no build in this session

### Notes for Iris
- TimelineEmbed constructs iframe URLs as https://{appSlug}.{domain}{embed_path} — apps must expose /embed/timeline/* routes
- Fallback StandardCard renders from stored data fields (description, thumbnail_url, url) when app iframe is unavailable
- postMessage protocol: youeye-embed-ready and youeye-embed-resize from iframe to parent
- Both Cinema and Search branches must be merged alongside UI for end-to-end timeline embeds

## v0.2.19.10 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix icon picker overflow, dynamic app list, apps-first ordering

### Changes
- `src/components/icon-picker.tsx` — Fixed scroll overflow: use fixed `h-[200px]` instead of `max-h`
- `src/components/settings/app-drawer-settings.tsx` — Added `max-h-[85vh] overflow-y-auto` to edit dialog
- `src/components/settings/admin/apps-list-settings.tsx` — Reordered categories: apps first (`user → infrastructure → system`), added `max-h-[85vh]` to admin edit dialog

### Test Results
- Playwright: icon picker contained in dialog, apps section first, no hardcoded uninstalled apps

### Notes for Iris
- Pairs with CP andrew-v0.2.19.10 (dynamic app filtering in bridge)

---

## v0.2.19.9 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App drawer customization — reorder, rename, icon picker, admin edits

### Changes
- `src/components/icon-picker.tsx` — New IconPicker component with Lucide/emoji/upload tabs
- `src/components/settings/app-drawer-settings.tsx` — New App Drawer settings section with drag-and-drop reorder (dnd-kit), edit dialog
- `src/components/settings/appearance-settings.tsx` — Added App Drawer subsection
- `src/components/layout/app-drawer.tsx` — Added emoji: prefix handling in AppIcon
- `src/components/settings/admin/apps-list-settings.tsx` — Added edit button and AdminEditAppDialog with name/icon/subdomain fields
- `src/app/api/admin/apps/[appId]/route.ts` — New admin API for global app edits with subdomain rename via bridge
- `src/lib/db/queries/app-management.ts` — Added updateGlobalApp function
- `package.json` — Added @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities

### Test Results
- Playwright: 14 screenshots, all verified
- Screenshots: Tests/Andrew/20260410_3/

### Notes for Iris
- New dependency: @dnd-kit/* (drag-and-drop) — pnpm install required
- Pairs with CP andrew-v0.2.19.9 (subdomain rename bridge endpoint)

## v0.2.19.8 — andrew — 2026-04-10
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App drawer fixes — icons, hover bug, marketplace registration, UI cleanup

### Changes
- `src/components/layout/app-drawer.tsx` — Fixed PascalCase→kebab-case icon normalization for ICON_MAP lookup; fixed inverted onMouseLeave that opened context menu on leave; removed 3-dot context menu and hover overlay entirely; replaced status dot with opacity+grayscale dimming for unhealthy apps

### Test Results
- Playwright: VNC session, verified all 4 apps render with correct icons (SVG for native, IMG for marketplace logos), no status dots, no context menu, dimming logic confirmed via DOM inspection
- Screenshots: Tests/Andrew/20260410_1/

### Notes for Iris
- Marketplace apps (Whoogle, SearXNG) were manually registered with YE-UI via bridge API since they were installed before the engine fix
- The CP engine.ts fix (v0.2.19.7) will auto-register future marketplace installs

## v0.2.19.1 — andrew — 2026-04-09
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix app drawer and marketplace icon rendering

### Changes
- `src/components/layout/app-drawer.tsx` — Added ICON_MAP for Lucide icon names, AppIcon component with cascading resolution
- `src/components/settings/app-market.tsx` — Same icon fix for marketplace settings page

### Test Results
- Playwright: VNC session, verified UI loads correctly after update

### Notes for Iris
- Icon rendering was broken for native apps (treated icon names as URLs)

## v0.2.14.1 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** UI Polish — 7 Fixes (theme cycle, notifications dupe, backgrounds, settings skeleton, avatar errors)

### Changes
- `src/components/layout/user-menu.tsx` — Fix 1: Replaced 3 theme items with single cycling button (light→dark→system). Fix 2: Removed duplicate Notifications menu item (header bell suffices). Added Monitor icon, removed Bell import.
- `src/app/page.tsx` — Fix 3: Removed `bg-background` from homepage root div so animated backgrounds at z-0 are visible through the container.
- `src/components/settings/profile-settings.tsx` — Fix 4: Added loading skeleton (animate-pulse) while profile data fetches. Fix 6: Added error handling to avatar upload — setError on non-OK response, catch block with user-facing message.
- `package.json` — Bumped to 0.2.14.1

### Test Results
- pnpm build: success (all pages compiled)
- spine update ui: v0.2.14.1 deployed to johnvm
- API health: /api/health returns ok
- Source verification: bg-background removed from page.tsx, Monitor icon in user-menu, animate-pulse skeleton in profile-settings, avatar error handling added

### Notes for Iris
- Fix 3 removes bg-background from homepage — ensure theme still works (Navbar has its own bg)
- Fix 6 adds error feedback but doesn't change the upload API — server-side is unchanged

---

## v0.2.19.1 — sebastian — 2026-04-09
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Theme sync, widget overhaul, header unification, add widget dialog

### Changes
- `src/app/api/v1/themes/active/route.ts` — GET returns mode from user_settings
- `src/app/api/v1/header/config/route.ts` — uses UI_EXTERNAL_URL for service calls
- `src/components/color-theme-provider.tsx` — syncs DB theme mode to next-themes
- `src/components/layout/user-menu.tsx` — theme toggle saves mode to DB
- `src/components/layout/navbar.tsx` — added Home button
- `src/components/layout/app-drawer.tsx` — Google-style 3x3 dots icon
- `src/components/dashboard/widget-container.tsx` — transparent default, resize all edges/corners
- `src/components/dashboard/add-widget-dialog.tsx` — tabbed dialog with carousel previews

### Test Results
- Verified via VNC on ye-sebastian VM

### Notes for Iris
- Search and Wiki apps need full rebuild from source

---

## v0.2.14.1 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** UI Polish — 7 Fixes (theme cycle, notifications dupe, backgrounds, settings skeleton, avatar errors)

### Changes
- `src/components/layout/user-menu.tsx` — Fix 1: Replaced 3 theme items with single cycling button (light→dark→system). Fix 2: Removed duplicate Notifications menu item (header bell suffices). Added Monitor icon, removed Bell import.
- `src/app/page.tsx` — Fix 3: Removed `bg-background` from homepage root div so animated backgrounds at z-0 are visible through the container.
- `src/components/settings/profile-settings.tsx` — Fix 4: Added loading skeleton (animate-pulse) while profile data fetches. Fix 6: Added error handling to avatar upload — setError on non-OK response, catch block with user-facing message.
- `package.json` — Bumped to 0.2.14.1

### Test Results
- pnpm build: success (all pages compiled)
- spine update ui: v0.2.14.1 deployed to johnvm
- API health: /api/health returns ok
- Source verification: bg-background removed from page.tsx, Monitor icon in user-menu, animate-pulse skeleton in profile-settings, avatar error handling added

### Notes for Iris
- Fix 3 removes bg-background from homepage — ensure theme still works (Navbar has its own bg)
- Fix 6 adds error feedback but doesn't change the upload API — server-side is unchanged

---
=======
## v0.2.14.1 — mike — 2026-04-01
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Authentik login page theming — rewrite CSS generator for Shadow DOM, add WordArt branding, fix sync triggers

### Changes
- `src/lib/themes/css-generator.ts` — Rewrote generateAuthentikCSS() to use ::part(main), ::part(branding) selectors and CSS variables that pierce Shadow DOM in Authentik 2025.12.x. Added animated gradient background, WordArt branding support, dark/light theme toggle via [data-theme] selectors
- `src/app/api/admin/authentik/branding/route.ts` — Updated admin endpoint to work with empty body (fetches active theme from DB) for "sync now" pattern. Added WordArt/branding config fetch
- `src/components/color-theme-provider.tsx` — Added startup sync: pushes theme to Authentik on mount. Fixed silent error handling (was catch(() => {}), now logs warnings)
- `src/components/settings/branding-settings.tsx` — Added Authentik push trigger on branding save (fire-and-forget POST)

### Test Results
- Playwright: 7/7 tests passed (49.1s) — CSS injection, rounded corners, branding title, gradient background, Inter font, startup sync, debug push
- Screenshots: 10 captured, all verified

### Notes for Iris
- YE-ControlPanel also modified (see CP AGENTS.md) — both repos needed for full feature
- Deployment note: UI bridge update deploys to /opt/app/ but systemd service runs from /opt/youeye-ui/ — may need to fix update path in CP bridge endpoint
- No DB migrations required
=======
## v0.2.14.1 — lisa — 2026-04-01
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Native app hardening — registration pipeline, global sign-out, unified user menu

### Changes
- `src/lib/auth/service.ts` — Removed hardcoded knownNativeApps; uses pure DB lookup for app registration
- `src/app/api/v1/notifications/route.ts` — Removed hardcoded app whitelist; all registered apps accepted
- `src/app/api/v1/timeline/route.ts` — Extended NATIVE_APP_IDS to include all 6 native apps
- `src/app/api/v1/apps/register/route.ts` — Added bridge token authentication for app self-registration
- `src/app/api/v1/apps/[appId]/unregister/route.ts` — NEW: DELETE endpoint for app deregistration
- `src/app/api/v1/header/config/route.ts` — Added ui_base_url and user_menu with platform_items to response
- `package.json` — Version bump to 0.2.14.1

### Test Results
- Deployed to lisavm: CP 0.2.14.1, YE-UI 0.2.14.1, Weather 0.2.14.1
- Other native apps: code changes ready, will be installed fresh during Iris validation

### Notes for Iris
- 8 repos modified, all need merging to dev
- Native apps must be reinstalled to trigger registration pipeline
- Setup wizard consent flow changed — new installs will use implicit consent
- New unregister endpoint at /api/v1/apps/[appId]/unregister (DELETE, bridge token auth)

---

## v0.2.13.2 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** BUG-030 fix — add TMDB API key input to Cinema install wizard in app market

### Changes
- `src/components/settings/app-market.tsx` — Added `tmdbApiKey` field to `installForm` state; added TMDB API key input section (visible only when `installTarget.id === "cinema"`); Install button disabled when Cinema selected and tmdbApiKey is empty; `tmdbApiKey` passed in `installParams` to bridge API
- `package.json` — Bumped to 0.2.13.2

### Test Results
- pnpm build: success
- spine update ui: v0.2.13.2 confirmed deployed on johnvm
- Bundle verified: tmdbApiKey, tmdbApiKeyPlaceholder, tmdbApiKeyHelp translations present in deployed JS
- Cinema shows as installed on johnvm (Uninstall button visible) — install dialog TMDB prompt verified via source code inspection
- Screenshots: Tests/John/20260401_2/

### Notes for Iris
- TMDB API key input shows in install wizard when Cinema app is selected
- Install button is disabled if Cinema is selected and TMDB key is blank (enforcement)
- TMDB content could NOT be verified end-to-end — no live TMDB API key available in this session
- Vlad should re-install Cinema with a real TMDB key to verify content loads

## v0.2.13.1 — john — 2026-04-01
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Add ye-cinema to knownNativeApps for bridge token auth

### Changes
- `src/lib/auth/service.ts` — Added "ye-cinema" to knownNativeApps array
- `package.json` — Bumped to 0.2.13.1

### Test Results
- pnpm build: success
- Cinema manifest endpoint authenticated via bridge token: passes

### Notes for Iris
- Minimal change, no UI changes

## v0.2.8.1 — john — 2026-03-31
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** API security (rate limiting + HMAC signing) + gateway monitoring

### Changes
- `src/lib/rate-limit.ts` — token-bucket rate limiter: per-app-slug limits (60/min gateway, 10/min notifs, 30/min timeline, 120/min info cards)
- `src/lib/auth/hmac.ts` — HMAC-SHA256 signing/verification with constant-time comparison; APP_SECRET storage in systemSettings; feature flag require_app_signatures
- `src/lib/middleware/rate-limit-guard.ts` — withRateLimit() wrapper for route handlers with rate limiting + HMAC verification
- `src/app/api/v1/notifications/route.ts` — rate limiting on notification ingest POST
- `src/app/api/v1/apps/info-card/route.ts` — rate limiting on info card POST
- `src/app/api/v1/apps/[appId]/rate-limit-status/route.ts` — admin-only rate limit status endpoint
- `src/db/schema.ts` — gateway_requests table for inter-app API call logging (rolling 10K window)
- `src/lib/db/queries/gateway.ts` — logGatewayRequest() + getGatewayStats() for monitoring dashboard
- `src/app/api/v1/admin/gateway/stats/route.ts` — admin-only gateway stats endpoint (per-app request counts, error rates, avg response times)
- `package.json` — version bump to 0.2.8.1

### Test Results
- Build: successful standalone tarball
- Screenshots: Tests/John/20260331_1/

### Notes for Iris
- DB migration: gateway_requests table added — Drizzle will create it on first access via ensureSchema()
- Feature flag require_app_signatures defaults to false — Wiki and Search work without HMAC during grace period
- In-memory rate limiter resets on process restart (by design — not a security boundary)

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Language propagation bridge + PATCH proxy support

### Changes
- `src/app/api/admin/[...path]/route.ts` — Added PATCH handler to admin proxy catch-all for language propagation bridge calls
- `src/components/settings/language-settings.tsx` — System language change now triggers bridge propagation (Authentik + apps) in background
- `package.json` — Version bump to 0.2.8.1

### Test Results
- Build: YE-UI builds successfully
- Deploy: youeye-ui container running v0.2.8.1 on lisavm

### Notes for Iris
- PATCH handler is needed for the CP language propagation bridge — without it, `/api/admin/user/language` returns 405

## v0.2.8.1 — lisa — 2026-03-31
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Cycle 3 — Language propagation bridge + PATCH proxy support

### Changes
- `src/app/api/admin/[...path]/route.ts` — Added PATCH handler to admin proxy catch-all for language propagation bridge calls
- `src/components/settings/language-settings.tsx` — System language change now triggers bridge propagation (Authentik + apps) in background
- `package.json` — Version bump to 0.2.8.1

### Test Results
- Build: YE-UI builds successfully
- Deploy: youeye-ui container running v0.2.8.1 on lisavm

### Notes for Iris
- PATCH handler is needed for the CP language propagation bridge — without it, `/api/admin/user/language` returns 405

## v0.2.8.1 — ben — 2026-03-31
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Timeline info cards, timeline auto-recording, app drawer redesign (Cycle 3)

### Changes
- `src/components/layout/app-drawer.tsx` — Replaced Sheet-based sidebar with Popover-based 4-column grid; status dots, hover overlay with "Open"/"Open in new tab"/"App settings", "Manage Apps" footer
- `src/components/ui/popover.tsx` — New Radix Popover UI component
- `src/components/timeline/timeline-entry-card.tsx` — Added inline info card rendering via IntersectionObserver, added onSelect prop for detail view, added wiki/search type icons
- `src/components/timeline/timeline-feed.tsx` — Added entry detail view, retroactive enrichment via deriveInfoCardUrl, processPendingEvents on load
- `src/components/timeline/timeline-info-card.tsx` — New lazy-loading info card component with IntersectionObserver
- `src/components/timeline/timeline-entry-detail.tsx` — New entry detail view with full-size info card and "Open in app" action
- `src/lib/timeline/derive-info-card-url.ts` — URL derivation rules for wiki/search/notes/photos entry types
- `src/app/api/v1/timeline/route.ts` — Added POST handler for app-to-app timeline ingest with timeline:write permission check, auto-grant for native apps, pending events queue
- `src/db/schema.ts` — New pendingTimelineEvents table for unencrypted temporary event storage
- `src/lib/db/queries/timeline.ts` — Added queuePendingEvent, getPendingEvents, deletePendingEvent, processPendingEvents functions
- `messages/*.json` — Added i18n keys for app drawer (manageApps, visitMarketplace) and timeline detail (backToTimeline, tags, rawData) in all 5 locales

### Test Results
- Build: TypeScript compilation passes, Next.js build succeeds
- Deploy: spine update ui → 0.2.8.1 success
- Platform: 7 running, 0 stopped

### Notes for Iris
- New `pendingTimelineEvents` table added — Drizzle auto-creates on first access via ensureSchema()
- The POST /api/v1/timeline endpoint auto-grants timeline:write for ye-wiki and ye-search — no manual permission setup needed
- App drawer now uses Popover instead of Sheet — may affect any tests that look for Sheet-based selectors
- The info card URL derivation function handles future app types (notes, photos) but those apps don't exist yet

## v0.2.8.1 — mike — 2026-03-31
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** WordArt greeting presets, gradient backgrounds, X-App-Slug notification auth

### Changes
- `src/lib/greeting-presets.ts` — 17 WordArt preset definitions (5 categories: Classic, Minimal, Decorative, Animated, Fun)
- `src/components/widgets/greeting-widget.tsx` — Updated to support style presets with inline CSS rendering
- `src/components/widgets/greeting-preset-picker.tsx` — New preset picker with category tabs and thumbnail grid
- `src/components/widgets/index.ts` — Added settings schema for greeting widget (name field)
- `src/components/dashboard/widget-settings-dialog.tsx` — Integrated preset picker for greeting widget
- `src/app/globals.css` — Self-hosted Google Fonts (@font-face), CSS keyframe animations for WordArt
- `public/fonts/` — 8 woff2 font files (Caveat, Dancing Script, Playfair Display in latin + cyrillic)
- `src/components/backgrounds/background-settings-dialog.tsx` — Added gradient background preset swatches
- `src/components/backgrounds/homepage-background.tsx` — Support CSS gradient strings in solid background mode
- `src/app/api/v1/notifications/route.ts` — Added X-App-Slug auth for native app notification ingestion
- `package.json` — Version bump to 0.2.8.1

### Test Results
- Build passes, all pages render correctly
- Deployed to mikevm, UI loads successfully

### Notes for Iris
- New fonts in public/fonts/ increase standalone tarball size by ~260KB
- Notification endpoint now accepts X-App-Slug header (backward compatible — session and bridge auth still work)

## v0.2.7.2 — sam — 2026-03-31
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Fix widget proxy sending wrong user ID — DB UUID instead of Authentik UID

### Changes
- `src/lib/auth/session.ts` — Added `authentikId: string` field to `SessionPayload` and `createSession()` parameters
- `src/app/api/auth/callback/route.ts` — Pass `authentikId: userInfo.sub` (Authentik sub claim) when creating session JWT
- `src/app/api/v1/widgets/app-data/route.ts` — Use `session.authentikId ?? session.userId` as `X-YouEye-User` header
- `src/app/api/v1/apps/info-card/route.ts` — Same fix: use `session.authentikId ?? session.userId`
- `package.json` — bumped to 0.2.7.2

### Test Results
- Widget proxy check: `items` array now returns samvm's real notes (2 items) ✓
- Multi-user widget test: samvm sees their own 5 notes; testuser2 has clean empty dashboard ✓
- Screenshots: Tests/Sam/playwright/test-results/

### Notes for Iris
- Root cause: YE-UI session JWT stored `userId = user.id` (internal DB UUID), but native apps (Notes, Search etc.) store user data keyed by Authentik UID (sub claim)
- Fix adds `authentikId` to JWT — existing sessions will lack this field; fallback to `userId` prevents crashes but widget will be empty until re-login
- All native app proxies should use `authentikId` for user identity going forward
- Existing logged-in sessions need to re-login after deploy to get `authentikId` in their JWT

---

## v0.2.7.1 — sam — 2026-03-30
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Add ye-notes to knownNativeApps for theme sync support

### Changes
- `src/lib/youeye/known-apps.ts` (or equivalent) — added `ye-notes` to knownNativeApps list

### Notes for Iris
- Required for Notes app to receive theme sync requests without 401 Unauthorized errors

---

## v0.2.6.1 — lisa — 2026-03-29
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** User avatar system — upload, serve, profile page, header display, Authentik sync

### Changes
- `src/app/api/v1/user/avatar/route.ts` — POST upload: accept JPEG/PNG/WebP/GIF, resize to ≤256×256 via sharp, store as WebP at /var/lib/youeye/ui-data/avatars/{userId}.webp, track in userAssets, update users.image
- `src/app/api/v1/user/avatar/[id]/route.ts` — GET serve: serve stored webp file or 404 if not uploaded
- `src/app/api/v1/user/profile/route.ts` — DELETE avatar endpoint (removes file + clears users.image)
- `src/components/settings/profile-settings.tsx` — Avatar section: current avatar display, upload widget with preview, crop, remove button
- `src/components/layout/user-menu.tsx` — Replace initials with avatar image; fallback chain: avatarUrl → initials → generic icon
- `src/lib/avatar/storage.ts` — File system helpers: save/delete WebP at /var/lib/youeye/ui-data/avatars/
- `src/lib/avatar/authentik-sync.ts` — Bridge call to /api/ui-bridge/user/avatar for Authentik avatar sync (best-effort)
- `package.json` — bumped to 0.2.6.1; sharp added as dependency

### Test Results
- Playwright: 5 tests, 5 passed — profile avatar section visible, avatar API endpoint responds (401 = endpoint exists), header shows initials fallback
- Screenshots: Tests/Lisa/20260329_2/

### Notes for Iris
- sharp requires native bindings — verify it installs correctly inside the Incus container (arm64/amd64)
- Avatar storage volume: /var/lib/youeye/ui-data/avatars/ — needs persistence across deploys
- Authentik sync is best-effort: upload succeeds even if bridge call fails

---

---

 HEAD
## v0.2.6.1 — sam — 2026-03-29 (session 2 — resumed)
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Fix add-widget preview thumbnails — icons instead of WxH text

### Changes
- `src/components/dashboard/widget-grid.tsx` — replace size badge (WxH text) with descriptive
  Lucide icons per widget type: User (greeting), Search (search), Clock (clock),
  List (timeline-preview), Package (default/app-widget)

### Test Results
- `pnpm build` — passes
- Playwright: 2 tests, 8 screenshots — Tests/Sam/20260329_3/

### Notes for Iris
- No DB changes, no API changes — UI-only improvement

## v0.2.6.1 — sam — 2026-03-29
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Per-widget background styles, settings dialog enhancement, empty dashboard state

### Changes
- `src/components/dashboard/widget-container.tsx` — Per-widget background styling: reads `backgroundStyle` (default/transparent/custom) and `customBackgroundColor` from widget settings JSONB; applies glass-morphism for transparent, inline backgroundColor for custom; settings button now always visible in edit mode (not gated by settingsSchema)
- `src/components/dashboard/widget-settings-dialog.tsx` — Dialog always opens for any widget (was gated by settingsSchema); added BackgroundStyleSection with 3 visual swatch thumbnails (Default, Glass, Custom) + color picker for custom mode; separated widget-specific fields from background section with border
- `src/components/dashboard/widget-grid.tsx` — Empty dashboard state with "Add Widget" CTA; add-widget menu shows size preview thumbnails (WxH) for each widget type
- `messages/en.json` — Added widgetGrid.emptyTitle/emptyDescription/addFirstWidget + widgetSettings section
- `messages/de.json` — German translations for new keys
- `messages/es.json` — Spanish translations for new keys
- `messages/fr.json` — French translations for new keys
- `messages/ru.json` — Russian translations for new keys
- `package.json` — version bump to 0.2.6.1

### Test Results
- Playwright: 2/2 tests passed (login+dashboard, edit mode+toolbar)
- Screenshots: Tests/Sam/20260329_2/

### Notes for Iris
- No DB migration needed — background styles stored in existing `settings` JSONB column
- Widget padding changed from p-3 to p-4 for consistency
- Settings button now shows for ALL widgets (including those without settingsSchema) because background section is always available

---
## v0.2.5.1 — john — 2026-03-29
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** API versioning (/api/v1/) + login auto-redirect + theme in user menu

### Changes
- `src/app/api/v1/` — Moved 12 route groups (apps, branding, header, notifications, permissions, pin, settings, themes, timeline, user, user-assets, widgets) under /api/v1/
- `src/app/api/auth/`, `src/app/api/health/`, `src/app/api/admin/`, `src/app/api/ui-bridge/` — kept outside v1 (infrastructure routes)
- All client-side fetch calls updated to /api/v1/ paths (14 component/lib files)
- `src/app/api/v1/header/config/route.ts` — notification endpoint path updated to /api/v1/
- `src/app/login/page.tsx` — immediate redirect to /api/auth/sso (no intermediate button page); error param still shows LoginCard
- `src/components/layout/navbar.tsx` — removed ThemeToggle import and usage
- `src/components/layout/user-menu.tsx` — added Light/Dark/System theme options with system preference detection
- `src/components/layout/theme-toggle.tsx` — deleted
- `messages/{en,ru,de,es,fr}.json` — added themeLight, themeDark, themeSystem i18n keys
- `package.json` — bumped to 0.2.5.1

### Test Results
- Playwright: 8 screenshots, all verified
- Screenshots: Tests/John/20260329_1/
- Old API paths (/api/notifications, /api/themes, /api/widgets) return 404
- New v1 paths (/api/v1/notifications, /api/v1/themes) return 200
- Auth/health routes unchanged and working
- Login auto-redirect works; error param shows LoginCard
- Theme toggle visible in user menu (Light/Dark/System), removed from navbar

### Notes for Iris
- **MERGE JOHN FIRST** — this is the most widespread change in Cycle 0 (v1 prefix). All other agents' new code must use /api/v1/ paths.
- Large diff due to directory rename (api/ → api/v1/) but logic unchanged
- Native apps (Wiki, Search) and CP also updated — merge those repos too

---
## v0.2.5.1 — ben — 2026-03-29
**Branch:** ben
**VM:** benvm.test (192.168.31.208)
**Agent:** Ben
**Task:** Background system hardening — BUG-001 fix, error boundaries, memory leak audit, performance settings

### Changes
- `src/components/backgrounds/shader-gradient.tsx` — Fixed BUG-001: increased SCALE from 4 to 8 (4x fewer pixels), capped at 30fps, reuse ImageData to reduce GC pressure, added clearRect on unmount
- `src/components/backgrounds/background-error-boundary.tsx` — NEW: React error boundary wrapping all animated backgrounds, falls back to solid color on crash
- `src/components/backgrounds/homepage-background.tsx` — Wrapped animated backgrounds with error boundary, added performance detection (prefers-reduced-motion + low CPU cores), added disableAnimations setting support
- `src/components/backgrounds/background-settings-dialog.tsx` — Added "Disable animations (better battery life)" toggle with description
- `src/components/backgrounds/dot-particles.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/flowing-dots.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/flowing-lines.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/flowing-ribbons.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/horizontal-bars.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/interactive-dots.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/sliding-ease.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/smooth-wavy.tsx` — Added clearRect canvas cleanup on unmount
- `src/components/backgrounds/vertical-bars.tsx` — Added clearRect canvas cleanup on unmount
- `messages/en.json` — Added disableAnimations and disableAnimationsHint i18n keys
- `messages/ru.json` — Added Russian translations for disable animations
- `messages/fr.json` — Added French translations for disable animations
- `messages/es.json` — Added Spanish translations for disable animations
- `messages/de.json` — Added German translations for disable animations
## v0.2.5.1 — mike — 2026-03-29
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** User Identity Foundation — schema, profile API, greeting widget

### Changes
- `src/db/schema.ts` — Added firstName, lastName, bio, timezone, userOrigin columns to users table
- `src/db/index.ts` — Added ALTER TABLE IF NOT EXISTS for 5 new columns in ensureSchema()
- `src/lib/db/queries/users.ts` — Updated upsertUser() for firstName/lastName, added findUserById() and updateUserProfile()
- `src/lib/auth/authentik.ts` — Added given_name/family_name to fetchUserInfo return type
- `src/app/api/auth/callback/route.ts` — Extract and pass firstName/lastName from Authentik JWT claims
- `src/app/api/v1/user/profile/route.ts` — New GET/PATCH endpoint for user profile (editable fields)
- `src/components/settings/profile-settings.tsx` — Full rewrite: editable firstName, lastName, bio, timezone with save button
- `src/app/page.tsx` — Fetch user from DB, use firstName for greeting widget
- `messages/*.json` — Added profile field i18n keys (firstName, lastName, bio, timezone, save, saved) in 5 languages
- `package.json` — Version bump to 0.2.5.1

### Test Results
- Playwright: 4 tests, all passed
- All 10 background types cycle without crash
- Shader Gradient stable after 30-second sustained run
- Disable animations toggle visible and functional
- No console errors during background operation
- Screenshots: Tests/Ben/20260329_2/

### Notes for Iris
- Only touches `src/components/backgrounds/` — zero conflict risk with other agents
- New file: `background-error-boundary.tsx` (no merge conflicts possible)
- BackgroundConfig type extended with `disableAnimations?: boolean` — backward compatible
- BUG-001 status should be updated to resolved in current-state.yaml
- Screenshots: Tests/Mike/20260329_1/ (13 screenshots)
- Profile page shows all new fields, Bio textarea, Timezone dropdown, Save button
- Greeting widget works (shows username for existing installs, firstName for new)

### Notes for Iris
- New DB columns added via ALTER TABLE IF NOT EXISTS — safe for existing installs
- userOrigin column is pure placeholder (always null) — no logic around it
- New /api/v1/user/profile endpoint — uses /api/v1/ prefix per convention
- Merge Mike AFTER John if John also has /api/v1/ routes
## v0.2.5.1 — sam — 2026-03-29
**Branch:** sam
**VM:** samvm.test (192.168.31.209)
**Agent:** Sam
**Task:** Notification center (full page + toasts) + Info card component library

### Changes
- `src/app/notifications/page.tsx` — New full notifications page with auth and navbar
- `src/components/notifications/notifications-list.tsx` — Client component: filter (type/read), search, pagination, bulk actions
- `src/components/layout/notification-bell.tsx` — Added toast notifications (Sonner) on new poll + "View all" link
- `src/components/layout/user-menu.tsx` — Added Notifications link to user dropdown
- `src/components/providers.tsx` — Added Sonner Toaster to app providers
- `src/app/api/notifications/route.ts` — Extended GET with offset/type/read/search params, added DELETE for bulk delete read
- `src/lib/db/queries/notifications.ts` — Extended getUserNotifications with filtering, added getNotificationCount + deleteReadNotifications
- `src/components/info-cards/` — New info card component library (InfoCard, ArticleSummaryCard, DefaultCard, Skeleton, Fallback, useInfoCard hook)
- `messages/{en,ru,de,es,fr}.json` — Added notification page + nav i18n keys for all 5 languages
- `package.json` — Version bump to 0.2.5.1

### Test Results
- Playwright: 4/4 tests passed (bell dropdown, notifications page, filters, user menu)
- Screenshots: Tests/Sam/20260329_2/ (11 screenshots, all verified)

### Notes for Iris
- Sam only touches new files under `src/components/info-cards/` and `src/components/notifications/` — zero conflict risk
- Modified `notification-bell.tsx`, `user-menu.tsx`, `providers.tsx` — small additions only
- Extended `notifications.ts` queries and API route — backwards compatible (old limit-only calls still work)
- No DB migrations — all tables already exist

## v0.2.4.1 — mike — 2026-03-27
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Unified update UX with floating updates section and reconnection overlay

### Changes
- `src/components/settings/admin/apps-list-settings.tsx` — Rewritten: Updates Available section floats to top (Play Store style), inline progress per item from persistent status, confirmation dialog for self-destructive updates, post-update toast via systemSettings flag
- `src/components/settings/admin/update-overlay.tsx` — New: full-screen overlay during CP/UI self-update with health polling and auto-dismiss
- `src/components/ui/progress.tsx` — New: progress bar component
- `src/lib/admin/types.ts` — Added UpdateStatusRecord and UpdateStatusResponse interfaces
- `src/lib/db/queries/update-flag.ts` — New: get/set/clear update flag in systemSettings for detecting UI restart after self-update
- `src/app/api/admin/update-flag/route.ts` — New: GET/POST/DELETE API for update flag persistence
- `package.json` — Version bump to 0.2.4.1

### Test Results
- TypeScript: clean build, no type errors
- Deployed to mikevm: apps list shows all components grouped by category with versions
- Playwright: 8 tests, all pass (apps list screenshot verified — System, Infrastructure, Apps sections render correctly)

### Notes for Iris
- New `/api/admin/update-flag` route is UI-local (not proxied to CP) — uses Drizzle systemSettings table
- Status polling uses existing catch-all proxy at `/api/admin/[...path]` — no new proxy routes needed
- Update overlay polls `/api/health` (UI) or `/api/admin/system` (CP) every 3s after 5s delay

## v0.2.4.1 — john — 2026-03-26
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Cross-platform per-user language support

### Changes
- `src/app/api/ui-bridge/user-language/route.ts` — NEW: Bridge endpoint returning user's language preference by Authentik sub ID
- `src/components/settings/language-settings.tsx` — Fixed admin system language to route through bridge proxy, load current value on mount
- `src/app/settings/language/page.tsx` — Passes current system language to language settings component

### Test Results
- Playwright: 2 tests passed (per-user UI + system default CP)
- 14 screenshots captured, all valid (60KB-2MB)

### Notes for Iris
- New bridge endpoint `/api/ui-bridge/user-language` — CP depends on this for per-user language resolution
- No new dependencies added
- No migration needed

## v0.2.2.2 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Complete i18n string extraction for all remaining UI components

### Changes
- `messages/en.json` — Added 200+ new translation keys for all remaining components
- `messages/ru.json` — Russian translations for all new keys
- `messages/de.json` — German translations for all new keys
- `messages/es.json` — Spanish translations for all new keys
- `messages/fr.json` — French translations for all new keys
- `src/components/auth/login-card.tsx` — Converted to useTranslations('login')
- `src/components/layout/app-drawer.tsx` — Converted to useTranslations('appDrawer')
- `src/components/layout/notification-bell.tsx` — Converted to useTranslations('notifications')
- `src/components/layout/theme-toggle.tsx` — Converted to useTranslations('themeToggle')
- `src/components/backgrounds/background-settings-dialog.tsx` — Converted to useTranslations('backgroundSettings')
- `src/components/widgets/timeline-preview-widget.tsx` — Converted to useTranslations('timelinePreview')
- `src/components/widgets/app-widget.tsx` — Converted to useTranslations('appWidget')
- `src/components/dashboard/widget-card.tsx` — Converted to useTranslations('widgets')
- `src/components/dashboard/widget-container.tsx` — Converted to useTranslations('widgetGrid')
- `src/components/dashboard/widget-grid.tsx` — Converted to useTranslations('widgetGrid')
- `src/components/settings/app-market.tsx` — Converted to useTranslations('appMarket')
- `src/components/settings/branding-settings.tsx` — Converted to useTranslations('settings.branding')
- `src/components/settings/permission-manager.tsx` — Converted to useTranslations('permissions')
- `src/components/settings/pin-manager.tsx` — Converted to useTranslations('pinManager')
- `src/components/timeline/pin-prompt.tsx` — Converted to useTranslations('pinPrompt')
- `src/components/timeline/timeline-entry-card.tsx` — Converted to useTranslations('timeline')
- `src/components/timeline/timeline-feed.tsx` — Converted to useTranslations('timeline')
- `src/components/timeline/timeline-filters.tsx` — Converted to useTranslations('timeline')
- `src/app/timeline/page.tsx` — Converted to getTranslations('timeline')
- `src/app/settings/privacy/page.tsx` — Converted to getTranslations('privacySettings')
- `src/app/settings/apps/page.tsx` — Converted to getTranslations('appsSettings')
- `src/app/settings/market/page.tsx` — Simplified (AppMarket handles its own strings)

### Test Results
- Build: successful (pnpm build passes clean)
- No VM deploy needed for this task

### Notes for Iris
- 37 total files now use useTranslations/getTranslations (up from 16)
- All user-visible strings are now i18n-ready
- Translations may need native-speaker review but are functional
- Merged origin/mike into john before starting work

## v0.2.2.2 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Fix Round 2 — string extraction expansion across admin settings

### Changes
- `src/components/settings/admin/system-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/container-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/dns-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/proxy-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/user-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/apps-list-settings.tsx` — Converted to useTranslations
- `src/components/settings/admin/bridge-unavailable.tsx` — Converted to useTranslations
- `src/components/settings/admin/access-denied.tsx` — Converted to useTranslations
- `src/components/dashboard/widget-settings-dialog.tsx` — Converted to useTranslations

### Test Results
- Build: successful
- Deployed to mikevm.test

### Notes for Iris
- UI now at 16/85 files with useTranslations (up from 7)
- All admin settings components are now i18n-ready

## v0.2.2.1 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Complete i18n string extraction across UI components

### Changes
- `src/components/settings/settings-shell.tsx` — Convert sidebar labels to use useTranslations
- `src/components/widgets/greeting-widget.tsx` — Use translated greeting keys
- `src/components/widgets/search-widget.tsx` — Translate search placeholder
- `src/components/settings/appearance-settings.tsx` — Translate mode labels
- `messages/*.json` — Add greeting, widgets, timeline, bridgeUnavailable, accessDenied namespaces

### Test Results
- Build pending

### Notes for Iris
- Greeting widget now uses translation keys instead of hardcoded English strings
- Settings shell sidebar section labels now pulled from message files

---

## v0.2.1.3 — mike — 2026-03-24
**Branch:** mike
**VM:** mikevm.test (192.168.31.202)
**Agent:** Mike
**Task:** Multi-language support across YouEye platform

### Changes
- `next.config.ts` — Wrap with createNextIntlPlugin
- `src/app/layout.tsx` — Add NextIntlClientProvider with locale from server
- `src/i18n/config.ts` — Locale config with display names
- `src/i18n/request.ts` — Language resolution: user settings > bridge system lang > "en"
- `src/app/settings/language/page.tsx` — New language settings page
- `src/components/settings/language-settings.tsx` — Language selector with per-user override and admin system language control
- `src/components/settings/settings-shell.tsx` — Added "Language" entry to sidebar navigation
- `src/components/settings/profile-settings.tsx` — Converted to useTranslations()
- `src/components/layout/user-menu.tsx` — Converted to useTranslations()
- `src/app/api/user/language/route.ts` — GET/POST API for user language preference (reads/writes userSettings JSONB)
- `messages/en.json` — English translations
- `messages/ru.json` — Russian translations
- `messages/es.json` — Spanish translations
- `messages/de.json` — German translations
- `messages/fr.json` — French translations

### Test Results
- Build: clean pnpm build
- TypeScript: no type errors
- Language settings page builds at /settings/language

### Notes for Iris
- New dependency: next-intl
- New settings route: /settings/language
- User language stored in userSettings JSONB as { language: "xx" }
- Admin can change system language via patchConfig through bridge proxy
- Profile settings and user menu converted to i18n as proof of pattern

---

# YE-UI Agent Log

## Version History

## v0.2.2.1 — john — 2026-03-24
**Branch:** john
**VM:** johnvm.test (192.168.31.201)
**Agent:** John
**Task:** Wiki App Full Platform Integration — YE-UI side

### Changes
- `src/lib/auth/service.ts` — New service-to-service auth resolver (X-YouEye-App + X-YouEye-User headers, validates app registration and user existence)
- `src/lib/auth/index.ts` — Added resolveServiceAuth export
- `src/middleware.ts` — Allow service-to-service requests to pass through middleware (API routes with X-YouEye-App + X-YouEye-User headers)
- `src/app/api/header/config/route.ts` — Added service-to-service auth path, added theme mode field from user settings, accepts NextRequest
- `src/app/api/apps/[appId]/user-settings/route.ts` — New generic app user-settings API (GET/PUT, JSONB namespaced by app ID)
- `src/app/api/themes/active/route.ts` — Added mode-only PUT support (dark/light/system), service-to-service auth
- `src/app/api/notifications/route.ts` — Added service-to-service auth for GET and PUT (mark-all-read)
- `package.json` — Bumped version to 0.2.2.1

### Test Results
- Build: successful (pnpm build passes)
- Playwright: pending

### Notes for Iris
- Service-to-service auth uses trust boundary (Incus container network)
- Known native app IDs (ye-wiki, ye-search) are allow-listed without DB lookup
- Theme mode stored in user_settings JSONB as themeMode field

## v0.2.1.1 — lisa — 2026-03-23
**Branch:** lisa
**VM:** lisavm.test (192.168.31.203)
**Agent:** Lisa
**Task:** Integrate Control Panel admin functions into YouEye UI settings

### Changes
- `src/app/settings/layout.tsx` — Added Navbar component to settings layout (logo, app drawer, notifications, theme toggle, user menu)
- `src/components/settings/settings-shell.tsx` — Removed sticky top bar (replaced by Navbar), added "Back to Dashboard" link, "Apps" admin section entry, "Control Panel" external link (fetched from bridge)
- `src/components/settings/admin/user-settings.tsx` — Expanded from read-only table to full CRUD: Add User dialog, set password, toggle active/admin, delete with confirmation, system users toggle
- `src/components/settings/admin/apps-list-settings.tsx` — New page showing all apps (system, infra, native, marketplace) with versions, container status badges, update indicator, SSE-powered "Update Now" button
- `src/app/settings/apps-list/page.tsx` — Route for new Apps admin page
- `src/components/settings/app-market.tsx` — Rewritten with real catalog from bridge API, install flow with config dialog + SSE streaming progress, uninstall with confirmation
- `src/app/api/admin/[...path]/route.ts` — Added SSE passthrough: detects `text/event-stream` responses and streams them as ReadableStream instead of buffering
- `src/lib/admin/bridge-client.ts` — Added extended timeout (5 min) for SSE connections
- `src/lib/admin/types.ts` — Added PlatformConfig type for CP URL config endpoint
- `package.json` — Version bump to 0.2.1.1

### Test Results
- Playwright: 10 screenshots verified (settings navbar, sidebar, users CRUD, add user dialog, apps page, market page, CP link, back to dashboard)
- All pages render correctly with real data from bridge API
- Deployed to lisavm.test, version confirmed 0.2.1.1

### Notes for Iris
- New admin sidebar entry "Apps" at `/settings/apps-list` — maps to admin section, requires isAdmin
- App Market now fetches real catalog via bridge — no more hardcoded placeholder apps
- SSE passthrough in admin proxy is transparent — works for both app updates and marketplace installs
- Flow change: settings now has persistent Navbar instead of separate sticky top bar

### v0.1.105.6 — Color Theme System (2026-03-12)

**Agent:** Alpha (α)
**Branch:** alpha
**Tag:** alpha-v0.1.105.6

**Changes:**

1. **Database Schema** — Added `themes` and `user_theme_preferences` tables to `src/db/schema.ts` and `ensureSchema()` in `src/db/index.ts`. Includes `ThemeColors` interface for OKLCH CSS variable values.

2. **Theme Presets** — Created `src/lib/themes/presets.ts` with 8 built-in color themes (Zinc, Slate, Violet, Blue, Rose, Orange, Green, Ocean). Auto-seeded on first DB access.

3. **Theme DB Queries** — Created `src/lib/db/queries/themes.ts` with full CRUD for themes and user preferences (listThemes, createTheme, updateTheme, deleteTheme, getUserActiveTheme, setUserActiveTheme).

4. **CSS Variable Generator** — Created `src/lib/themes/css-generator.ts` with functions to generate CSS custom properties, compact CSS strings for native apps, and Authentik login page CSS.

5. **Theme API Endpoints:**
   - `GET /api/themes` — List all themes
   - `GET /api/themes/presets` — List preset themes
   - `POST /api/themes` — Create custom theme (admin)
   - `PUT /api/themes/[id]` — Update custom theme (admin)
   - `DELETE /api/themes/[id]` — Delete custom theme (admin)
   - `GET /api/themes/active` — Get user's active theme with CSS
   - `PUT /api/themes/active` — Set user's active theme

6. **ColorThemeProvider** — Created `src/components/color-theme-provider.tsx` React context that fetches active theme on mount, injects CSS custom properties via `<style>` tag, and provides `useColorTheme()` hook with `setColorTheme()`.

7. **Providers Integration** — Updated `src/components/providers.tsx` to wrap app with both ThemeProvider (dark/light) and ColorThemeProvider (color palette).

8. **Appearance Settings Enhancement** — Rewrote `src/components/settings/appearance-settings.tsx` with:
   - 8-card preset grid with color swatches and active indicator
   - Custom theme creation dialog (admin only) with OKLCH color inputs
   - Live preview panel for custom themes
   - Instant theme switching with optimistic updates

9. **Header Config API** — Updated `src/app/api/header/config/route.ts` to include `theme` field with id, name, and compact CSS variables for native apps.

10. **Authentik Branding Bridge** — Created `src/app/api/admin/authentik/branding/route.ts` that generates Authentik CSS from theme colors and pushes to CP bridge.

---

### v0.1.105.1 — Delta Merge: Admin Pages (2026-03-11)

**Agent:** Delta (δ)
**Branch:** dev
**Tag:** dev-v0.1.105.1

**Merged branches:**
- `beta`: Admin proxy layer (/api/admin/[...path]), 5 admin pages (System, Containers, DNS, Proxy, Users), admin guard, settings shell

**Merge status:** Clean (fast-forward from main, then fast-forward from beta)

---

### v0.5.4.1 — Admin Proxy Layer & Admin Pages (2026-03-11)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.5.4.1

**Feature:** Server-side proxy layer and admin page UI components for managing the YouEye platform from within the UI. Admin users can now view system info, manage containers, monitor DNS, and see proxy routes — all without leaving the YouEye dashboard.

**Architecture:**
```
Browser → YE-UI /api/admin/* → proxy → CP /api/ui-bridge/* (via Incus internal network)
Browser → YE-UI /settings/admin/* → React pages → fetch /api/admin/* → display data
```

**New Files:**
- `src/lib/admin/types.ts` — TypeScript interfaces for all bridge API contracts
- `src/lib/admin/bridge-client.ts` — Bridge token reader + HTTP proxy client with 15s timeout
- `src/lib/admin/use-admin.ts` — Client-side `useAdmin()` hook for admin status checking
- `src/app/api/admin/[...path]/route.ts` — Catch-all proxy route (GET/POST/PUT/DELETE)
- `src/components/settings/admin/system-settings.tsx` — System info with CPU/memory/disk bars
- `src/components/settings/admin/container-settings.tsx` — Container table with start/stop/restart actions
- `src/components/settings/admin/dns-settings.tsx` — Pi-Hole stats, top queries, enable/disable toggle
- `src/components/settings/admin/proxy-settings.tsx` — Caddy routes table (read-only)
- `src/components/settings/admin/user-settings.tsx` — User table from Authentik via bridge
- `src/components/settings/admin/bridge-unavailable.tsx` — Graceful "CP unavailable" card
- `src/components/settings/admin/access-denied.tsx` — "Access Denied" card for non-admins
- `src/components/ui/table.tsx` — shadcn/ui Table component
- `src/components/ui/alert-dialog.tsx` — shadcn/ui AlertDialog component
- `src/app/settings/containers/page.tsx` — Containers settings page
- `src/app/settings/dns/page.tsx` — DNS settings page
- `src/app/settings/proxy/page.tsx` — Proxy settings page
- `tests/admin-pages.spec.ts` — 28 Playwright tests
- `playwright.config.ts` — Playwright configuration

**Changed Files:**
- `src/app/settings/system/page.tsx` — Enhanced with SystemSettings component (was placeholder)
- `src/app/settings/users/page.tsx` — Enhanced with UserSettings component (was placeholder)
- `src/components/settings/settings-shell.tsx` — Added Containers, DNS, Proxy nav items in Admin section
- `package.json` — Added @playwright/test dev dependency

**Key Design Decisions:**
1. Bridge token read from `/etc/youeye/ui-bridge-token` with in-memory caching
2. All admin pages gracefully degrade when CP bridge is unavailable (show retry button)
3. Container actions (start/stop/restart) have confirmation dialogs
4. Container list auto-refreshes every 30 seconds
5. Non-admin users see no admin nav items and are redirected from admin pages
6. Server-side admin check (redirect) + proxy-side admin check (403) — belt and suspenders

**Testing:**
- 28 Playwright tests, all passing:
  - Health endpoint + login page (existing functionality)
  - Admin API proxy returns 401 for unauthenticated users (5 endpoints)
  - All 9 settings pages redirect to /login when unauthenticated
  - Admin sees all 7 admin navigation items
  - All 5 admin pages load without crashing (system, containers, dns, proxy, users)
  - Admin API returns proper 503 error when bridge unavailable
  - Non-admin doesn't see admin navigation
  - Non-admin is redirected from admin pages
  - Non-admin API request returns 403
  - Dashboard still works for authenticated users
- Deployed and tested on YE-BetaVM (192.168.31.43)

---

### v0.5.3.1 — Semantic Version Comparison (2026-03-10)

**Agent:** Beta (β)
**Branch:** beta
**Tag:** beta-v0.5.3.1

**Feature:** Added semantic version comparison library for proper 3-digit and 4-digit version handling.

**New Files:**
- `src/lib/version.ts` — `compareVersions()`, `isNewer()`, `sortVersionsDesc()` functions

**Changed Files:**
- `package.json` — Version bumped from 0.5.3 to 0.5.3.1

### v0.5.2 — shadcn/ui Polish & Glass-morphism Widgets

**Features:**
- Initialized shadcn/ui with `components.json` configuration
- Added 9 shadcn components: sheet, badge, input, scroll-area, skeleton, tabs, tooltip, sonner
- Widget containers now have glass-morphism card styling (backdrop-blur-xl, semi-transparent bg)
- App drawer completely rewritten with shadcn Sheet component (was custom slide-out)
- Default widget positions optimized for better layout

**Fixes:**
- Fixed navbar transparency (now bg-background/95 backdrop-blur-md)
- Fixed globals.css duplicate @layer base blocks
- Search widget: polished with focus ring and border styling

**Changes:**
- `components.json` — New shadcn configuration file
- `src/components/ui/` — 9 new shadcn component files
- `src/components/dashboard/widget-container.tsx` — Glass-morphism card wrapper
- `src/components/dashboard/widget-grid.tsx` — shadcn Button/Separator toolbar
- `src/components/layout/app-drawer.tsx` — Full rewrite with shadcn Sheet
- `src/components/layout/navbar.tsx` — Fixed transparency
- `src/components/widgets/search-widget.tsx` — Polished styling
- `src/lib/db/queries/widgets.ts` — Updated default positions
- `src/app/globals.css` — Cleaned up duplicates

**Testing:**
- Playwright verified: dashboard widgets, app drawer, navbar all rendering correctly
- Screenshots: yeui-dashboard.png, yeui-app-drawer.png

### v0.5.1 — App Widget Catalog Integration

**Features:**
- App-provided widgets now appear in the dashboard "Add widget" menu under "App Widgets" section
- Each widget shows its source app name for clarity
- Widgets dynamically fetched from `/api/apps/widgets` when entering edit mode

**Fixes:**
- Fixed widget ID format: use raw `widget_id` instead of compound `app_id:widget_id` when proxying data
- Registered `app-widget` type in `WIDGET_REGISTRY` for rendering

**Changes:**
- `src/components/widgets/index.ts` — Added `app-widget` to `WIDGET_REGISTRY`
- `src/components/dashboard/widget-grid.tsx` — Fetch app widgets, show App Widgets section, pass correct widget_id

**Testing:**
- 18/18 integration tests pass (app registration, health checks, manifest, widget proxy, info cards)
- Playwright verified: App Market page, App Drawer, Featured Article widget (live Wikipedia data), Today in History widget

---

### v0.5.0 — Phase 2: Native Apps Platform

**Features:**
- App registration system with manifest auto-fetch
- App health monitoring and status tracking
- Widget proxy for app-provided dashboard widgets
- Info card system for contextual content cards
- App Market settings page with installed apps + catalog
- App drawer in navbar showing registered apps

**New Files:**
- `src/lib/db/queries/app-management.ts` — App CRUD, manifest, health
- `src/app/api/apps/register/route.ts` — Registration and listing
- `src/app/api/apps/[appId]/route.ts` — Details, unregister, health check
- `src/app/api/apps/[appId]/manifest/route.ts` — Manifest endpoint
- `src/app/api/widgets/app-data/route.ts` — Widget data proxy
- `src/app/api/widgets/notify/route.ts` — Widget change notification
- `src/app/api/apps/info-cards/route.ts` — Info card providers
- `src/app/api/apps/info-card/route.ts` — Info card request
- `src/app/api/apps/widgets/route.ts` — Widget declarations
- `src/components/widgets/app-widget.tsx` — Generic app widget
- `src/components/settings/app-market.tsx` — App Market UI

**Testing:**
- Wiki and Search app containers deployed on dev server
- All APIs verified via curl integration tests (18/18)
- Browser-verified via Playwright

---

### v0.2.2 — Fix OAuth2 "Invalid state" Error

**Problem:** Clicking "Sign in with Authentik" redirected to Authentik correctly, but on callback redirect back to `/api/auth/callback`, the state cookie validation failed with "Invalid state", preventing login.

**Root Cause:** Two bugs in `callback/route.ts`:
1. State cookie read via `cookies()` from `next/headers` (implicit response context) instead of `request.cookies` (actual HTTP Cookie header). In Next.js 15.3.3, the implicit context doesn't reliably include request cookies.
2. Session cookies set via `setSessionCookies()` which writes to `cookies()` implicit context — these do NOT merge into `NextResponse.redirect()`, so session cookies were silently dropped even if state validated.

**Fix:** Rewrote callback to use `request.cookies` for reads and `response.cookies.set()` for writes — matching the pattern already proven in `sso/route.ts`.

**Changes:**
- `src/app/api/auth/callback/route.ts` — Complete rewrite of cookie handling
  - Read state from `request.cookies.get("oauth-state")` instead of `cookies()`
  - Set `ye-ui-session` and `ye-ui-csrf` directly on `NextResponse.redirect()` response
  - Removed `setSessionCookies()` dependency (uses implicit context internally)
  - Added `SECURE_COOKIES` env var support (consistent with sso/route.ts)
  - Enhanced diagnostic logging: saved state, URL state, all cookie names, host, secure_cookies
  - Delete `oauth-state` cookie on ALL exit paths (error, missing params, mismatch, success, catch)

**Testing:**
- Deployed v0.2.2 to dev server 192.168.31.190
- SSO initiation: `oauth-state` cookie set correctly, redirect to Authentik works
- State validation: matching state passes through to token exchange
- State mismatch: correctly detected, redirects to `/login?error=Invalid+state`
- Diagnostic logging confirmed working in journalctl

---

### v0.2.1 — Scrollbar Fix, Edit Button Redesign & White-Label Support

**Fixes:**
- **Scrollbar flicker** — Added `overflow-hidden` to `<main>` in page.tsx to prevent double scrollbar
- **Edit button** — Changed to icon-only paintbrush button, moved toolbar to `top-4 left-4`
- **Add widget menu** — Opens downward (top-full) instead of overlapping toolbar

**White-Label:**
- **Dynamic metadata** — `generateMetadata()` reads `site_name` from `system_settings` DB table
- **Login card** — Accepts `siteName` prop, displays configurable site name
- **Site config helper** — `src/lib/site-config.ts` reads from `system_settings` table

**Changes:**
- `src/app/page.tsx` — `overflow-hidden` on main
- `src/components/dashboard/widget-grid.tsx` — Toolbar at top-left, paintbrush icon button
- `src/app/layout.tsx` — Dynamic generateMetadata() using getSiteName()
- `src/app/login/page.tsx` — Pass siteName to LoginCard
- `src/components/auth/login-card.tsx` — Display configurable siteName prop
- `src/lib/site-config.ts` — New file: getSiteName() from system_settings

**Testing:**
- Deployed v0.2.1 to dev server (192.168.31.190), health check passing

---

### v0.2.0 — Widget System, Animated Backgrounds & Dark/Light Mode

**Features:**
- **Dark/Light/System theme** via `next-themes` v0.4.6 — attribute="class", defaultTheme="dark", enableSystem
- **Theme toggle** — Sun/Moon/Monitor dropdown in navbar (hydration-safe with mounted state)
- **10 animated backgrounds** — flowing-lines, interactive-dots, vertical-bars, horizontal-bars, sliding-ease, dot-particles, smooth-wavy, flowing-ribbons, flowing-dots, shader-gradient (all canvas-based, requestAnimationFrame, mouse interactive)
- **10 color presets** — purple, blue, green, orange, pink, gray, sunset, ocean, forest, neon (each with light/dark variants)
- **Background settings dialog** — Type selector (solid/animated/image), animation picker, color palette grid, advanced sliders (speed/scale/intensity/reactivity), custom hex input for solid
- **Free-position widget system** — Absolute positioning, drag-to-move (GripVertical handle), resize (bottom-right handle), snap-to-grid (20px), percentage-based storage
- **Edit mode** — Paintbrush toggle button, toolbar with Add/Background/Reset/Done buttons
- **Auto-save** — Widget positions and background config saved to DB with 800ms debounce
- **Background API** — GET/PUT `/api/settings/background` with auth guard

**New Files (20+):**
- `src/components/providers.tsx` — ThemeProvider wrapper
- `src/components/layout/theme-toggle.tsx` — Theme toggle dropdown
- `src/components/ui/slider.tsx` — Radix slider (shadcn/ui)
- `src/components/ui/dialog.tsx` — Radix dialog (shadcn/ui)
- `src/lib/db/queries/settings.ts` — getUserSettings, getUserBackground, saveUserBackground
- `src/app/api/settings/background/route.ts` — Background preferences API
- `src/components/backgrounds/index.ts` — Registry with types, presets, helpers
- `src/components/backgrounds/homepage-background.tsx` — Background renderer
- `src/components/backgrounds/background-settings-dialog.tsx` — Full settings dialog
- `src/components/backgrounds/flowing-lines.tsx` through `shader-gradient.tsx` — 10 animated backgrounds
- `src/components/dashboard/widget-container.tsx` — Drag/resize wrapper
- `src/components/dashboard/widget-grid.tsx` — Full rewrite from flex to absolute positioning

**Modified Files:**
- `src/app/layout.tsx` — Added Providers, suppressHydrationWarning, removed hardcoded "dark"
- `src/components/layout/navbar.tsx` — Added ThemeToggle
- `src/app/page.tsx` — Added getUserBackground, passes initialBackground to WidgetGrid
- `package.json` — Version 0.2.0, added next-themes, @radix-ui/react-slider, @radix-ui/react-tabs

**Dependencies Added:** next-themes v0.4.6, @radix-ui/react-slider v1.3.5, @radix-ui/react-tabs v1.1.12

**Default Widget Layout:**
- Greeting: position (30%, 30%), size (40%, 10%)
- Search: position (32.5%, 48%), size (35%, 8%)
- Clock: position (78%, 8%), size (18%, 15%)

**Default Background:** Animated "flowing-lines" with "purple" preset

**Testing:**
- Deployed to dev server 192.168.31.190 via `spine update ui`
- Health check returns 200
- Login page renders with next-themes script
- All page bundles and static assets serving correctly
- Service logs clean (only expected "already exists" DB notices)
- Caddy routing to container confirmed
- **HTTPS Note:** System uses self-signed TLS certificates (not Let's Encrypt) for internal testing

**Build:** 47.1 kB first load for homepage, compiled in 4.0s, standalone.tar 48MB

---

### v0.1.1 — Self-Healing Database Schema

**Problem:** On fresh deployments, SSO callback fails with `Failed query: select ... from "users"` because Spine's psql-based schema creation silently fails (`.Run()` without error check).

**Fix:** Added `ensureSchema()` to `src/db/index.ts` — a singleton function that runs `CREATE TABLE IF NOT EXISTS` for all 5 tables using raw `postgres` tagged template literals.

**Changes:**
- `src/db/index.ts` — Added `ensureSchema()` function (~80 lines), singleton guard with `schemaReady` flag
- `src/lib/db/queries/users.ts` — Calls `ensureSchema()` before `findUserByAuthentikId()`
- `src/lib/db/queries/widgets.ts` — Calls `ensureSchema()` before `getUserWidgets()` and `saveUserWidgets()`
- `src/app/api/health/route.ts` — Calls `ensureSchema()` on health check (triggered by Spine's 10×2s loop)

**Testing:**
- Deployed to dev server 192.168.31.190
- Health check returns 200, logs show "Database schema verified"
- SSO redirect works (307 to Authentik)
- Self-healing test: dropped ALL tables → restarted service → health check auto-recreated all 5 tables
- Confirmed via `psql \dt` — users, widgets, apps, user_settings, system_settings all present

**Important:** If you modify the Drizzle schema (`src/db/schema.ts`), you MUST also update the raw SQL in `ensureSchema()` to match.

---

### v0.1.0 — Initial Release

**Features:**
- Custom OAuth2 SSO with Authentik (NOT NextAuth)
- JWT sessions via `jose` (cookie: `ye-ui-session`, 7 days)
- Drizzle ORM with PostgreSQL
- Widget system (greeting, search, clock)
- Health check endpoint (`/api/health`)
- Standalone Next.js 15.3.3 build

**Env vars:** `UI_EXTERNAL_URL`, `SECURE_COOKIES`, `AUTHENTIK_URL`, `AUTHENTIK_INTERNAL_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `JWT_SECRET`, `DATABASE_URL`

**Build:** `pnpm run build` → `.next/standalone` → tar for Gitea release
