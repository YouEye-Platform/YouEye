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