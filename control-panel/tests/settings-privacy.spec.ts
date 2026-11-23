import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — Privacy page.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-privacy.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => englishInterfaceSource(readFileSync(join(repoRoot, p), 'utf8'));
const has = (p: string) => existsSync(join(repoRoot, p));

test('Privacy page is a personal page (renders for non-admins; only PAM/CLI redirect)', () => {
  const p = read('src/app/settings/(shell)/privacy/page.tsx');
  assert.match(p, /<PrivacyClient \/>/);
  assert.match(p, /authMethod === "pam"/);
  // not gated to admins only (unlike People/System/Network/General)
  assert.doesNotMatch(p, /if \(!session\?\.isAdmin\) redirect/);
});

test('Timeline: collection and the lock sit together in one group', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /<TimelineCollection \/>\s*<TimelineLock \/>/);
  assert.match(c, /uiSettingsApi\("timeline\/collection"\)/);
  assert.match(c, /Timeline lock/);
});

test('Timeline lock wired to real PIN endpoints, presented honestly (no fake off-toggle)', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /uiSettingsApi\("pin\/status"\)/);
  assert.match(c, /uiSettingsApi\("pin\/create"\)/);
  assert.match(c, /uiSettingsApi\("pin\/change"\)/);
  assert.match(c, /uiSettingsApi\("pin\/session"\)/);
  // There is no remove endpoint: once set, the lock can be changed or locked now, and the page says so.
  assert.match(c, /Removing the lock isn’t available yet/);
});

test('Privacy is personal only: no dead export row, no server statistics (they are on General)', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.doesNotMatch(c, /Coming soon/);
  assert.doesNotMatch(c, /Export my data/);
  assert.doesNotMatch(c, /telemetry/);
  assert.doesNotMatch(c, /isAdmin/);
  assert.match(read('src/components/settings-shell/general-client.tsx'), /\/settings\/api\/telemetry\/settings/);
});

test('telemetry toggle is REAL — tracker enabled flag + guarded recording', () => {
  const t = read('src/lib/telemetry/tracker.ts');
  assert.match(t, /enabled: boolean/);
  assert.match(t, /export function isTelemetryEnabled/);
  assert.match(t, /export function setTelemetryEnabled/);
  // recording no-ops when disabled
  assert.match(t, /trackRoute\(pathname: string\): void \{\s*if \(!this\.data\.enabled\) return;/);
  // reset must not silently re-enable collection
  assert.match(t, /const wasEnabled = this\.data\.enabled/);
});

test('telemetry settings endpoint (GET session / PATCH admin+CSRF) + admin-guarded export', () => {
  assert.ok(has('src/app/api/telemetry/settings/route.ts'));
  const s = read('src/app/api/telemetry/settings/route.ts');
  assert.match(s, /export async function GET/);
  assert.match(s, /export async function PATCH/);
  assert.match(s, /verifyCSRFToken/);
  assert.match(s, /setTelemetryEnabled/);
  // export route now admin-gated (was unauthenticated)
  const e = read('src/app/api/telemetry/export/route.ts');
  assert.match(e, /session\?\.isAdmin/);
  assert.match(e, /verifyCSRFToken/); // DELETE reset requires CSRF
});

test('telemetry reached via /settings/api/telemetry/* proxies (root /api/telemetry → UI from Settings)', () => {
  assert.ok(has('src/app/settings/api/telemetry/settings/route.ts'));
  assert.ok(has('src/app/settings/api/telemetry/export/route.ts'));
});

test('No raw inputs or radix deps on the Privacy surface', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.doesNotMatch(c, /<input/);
  assert.doesNotMatch(c, /from ["']@radix-ui/);
});
