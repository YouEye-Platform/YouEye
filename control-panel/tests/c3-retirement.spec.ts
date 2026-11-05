import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C3 — retirement (incremental).
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/c3-retirement.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('browser tab title no longer surfaces "Control Panel" (D4)', () => {
  const l = read('src/app/layout.tsx');
  assert.doesNotMatch(l, /Control Panel`/);          // the templated title is gone
  assert.match(l, /title: config\.site_name/);        // brand-only title
});

test('the three dead embeds are deleted (verified unreferenced in CP + UI)', () => {
  assert.ok(!has('src/app/embed/containers/page.tsx'), 'embed/containers must be deleted');
  assert.ok(!has('src/app/embed/market/page.tsx'), 'embed/market must be deleted');
  assert.ok(!has('src/app/embed/update-progress/page.tsx'), 'embed/update-progress must be deleted');
});

test('still-consumed embeds are kept and the retired avatar embed stays removed', () => {
  // embed/health is fetched by the UI admin-embed health poll — must NOT be deleted
  assert.ok(has('src/app/embed/health/route.ts'), 'embed/health is used by the UI — keep it');
  // other active embeds remain
  for (const e of ['profile', 'language', 'branding', 'apps', 'dns', 'tls', 'app-network']) {
    assert.ok(has(`src/app/embed/${e}`), `embed/${e} should remain`);
  }
  assert.ok(!has('src/app/embed/avatar'), 'first-user onboarding is CP-native; embed/avatar must remain retired');
});

test('legacy (dashboard) shell is deleted', () => {
  assert.ok(!has('src/app/(dashboard)/page.tsx'), '(dashboard) root must be deleted');
  assert.ok(!has('src/app/(dashboard)/apps/page.tsx'), '(dashboard)/apps must be deleted');
  assert.ok(!has('src/app/(dashboard)/health/page.tsx'), '(dashboard)/health must be deleted');
  assert.ok(!has('src/app/(dashboard)/layout.tsx'), '(dashboard) layout must be deleted');
});

test('middleware redirects legacy shell routes to Settings (host-aware, precise)', () => {
  const m = read('src/middleware.ts');
  assert.match(m, /Retire the legacy control\.<domain>/);
  assert.match(m, /SHELL_PREFIXES = \['\/apps', '\/dns', '\/health', '\/people', '\/proxy', '\/updates'\]/);
  // subdomain → base-domain Settings; direct/PAM → same-origin /settings
  assert.match(m, /shellHost\.startsWith\('control\.'\)/);
  assert.match(m, /\$\{getParentOrigin\(\)\}\/settings/);
  assert.match(m, /NextResponse\.redirect\(new URL\('\/settings', request\.url\)\)/);
  // the redirect must NOT capture /settings, /market, /embed, or /api
  assert.doesNotMatch(m, /SHELL_PREFIXES = \[[^\]]*'\/(settings|market|embed|api)'/);
});

test('IP setup handoff wins before legacy Settings shell redirects', () => {
  const m = read('src/middleware.ts');
  const ipBlock = m.indexOf('IP-via-Caddy setup flow');
  const legacyBlock = m.indexOf('Retire the legacy control.<domain>');

  assert.ok(ipBlock >= 0, 'middleware should keep the IP setup flow block');
  assert.ok(legacyBlock >= 0, 'middleware should keep the legacy shell retirement block');
  assert.ok(ipBlock < legacyBlock, 'IP setup flow must run before / -> /settings redirects');
  assert.match(m, /completed \? '\/setup-complete' : '\/login'/);
});
