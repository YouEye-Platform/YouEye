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
