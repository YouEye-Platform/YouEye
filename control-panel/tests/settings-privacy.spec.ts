import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — Privacy page.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-privacy.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

const D18 = 'Collected and kept on this server only — never leave it unless you export and share them yourself';

test('Privacy page is a Personal page (renders for non-admins, passes isAdmin; only PAM/CLI redirect)', () => {
  const p = read('src/app/settings/(shell)/privacy/page.tsx');
  assert.match(p, /PrivacyClient/);
  assert.match(p, /isAdmin=\{session\?\.isAdmin \?\? false\}/);
  assert.match(p, /authMethod === "pam"/);
  // not gated to admins only (unlike People/System/Network/About)
  assert.doesNotMatch(p, /if \(!session\?\.isAdmin\) redirect/);
});

test('Your data card: Timeline lock + Export my data', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /title="Your data"/);
  assert.match(c, /Timeline lock/);
  assert.match(c, /Export my data/);
});

test('Timeline lock wired to real PIN endpoints, presented honestly (no fake off-toggle)', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /uiSettingsApi\("pin\/status"\)/);
  assert.match(c, /uiSettingsApi\("pin\/create"\)/);
  assert.match(c, /uiSettingsApi\("pin\/change"\)/);
  assert.match(c, /uiSettingsApi\("pin\/session"\)/);
  // switch is disabled when a PIN exists (no remove endpoint) — honest, not a fake toggle
  assert.match(c, /disabled=\{hasPin\}/);
  assert.match(c, /Removing the lock isn’t available yet/);
});

test('Export my data scoped out honestly — disabled, no fake export endpoint (pitfall #28)', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /Coming soon/);
  // the Export button is disabled and there is no data-export fetch
  assert.match(c, /disabled>\s*Export/);
  assert.doesNotMatch(c, /\/api\/.*export-my-data/);
});

test('Server card (admin) shows Local usage statistics with the exact D18 copy', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /Local usage statistics/);
  assert.ok(c.includes(D18), 'must use the exact D18 copy');
  // admin-gated
  assert.match(c, /\{isAdmin && <ServerCard/);
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
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.match(c, /\/settings\/api\/telemetry\/settings/);
  assert.match(c, /\/settings\/api\/telemetry\/export/);
  assert.match(c, /from "@\/components\/ui\/switch"/);
});

test('No raw inputs or radix deps on the Privacy surface', () => {
  const c = read('src/components/settings-shell/privacy-client.tsx');
  assert.doesNotMatch(c, /<input/);
  assert.doesNotMatch(c, /from ["']@radix-ui/);
});
