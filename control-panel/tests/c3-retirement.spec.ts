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

test('still-consumed embeds are KEPT', () => {
  // embed/health is fetched by the UI admin-embed health poll — must NOT be deleted
  assert.ok(has('src/app/embed/health/route.ts'), 'embed/health is used by the UI — keep it');
  // other active embeds remain
  for (const e of ['profile', 'language', 'branding', 'apps', 'dns', 'tls', 'avatar', 'app-network']) {
    assert.ok(has(`src/app/embed/${e}`), `embed/${e} should remain`);
  }
});
