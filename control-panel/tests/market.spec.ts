import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream D — Market Browse + Sources.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/market.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('Browse page is the Umbrel layout: hero + pill bar + Built-for + Featured + Sources pill', () => {
  const m = read('src/app/market/page.tsx');
  assert.match(m, /Apps for your server/);                 // hero tagline
  assert.match(m, /All apps/);
  assert.match(m, /Installed/);
  assert.match(m, /Updates/);
  assert.match(m, /Integrations/);
  assert.match(m, /Built for your server/);
  assert.match(m, /Featured/);
  assert.match(m, /href="\/market\/sources"/);             // Sources pill + footer
  assert.match(m, /Manage sources/);                       // footer link
});

test('Browse uses real catalog/status data + category-coloured icon tiles', () => {
  const m = read('src/app/market/page.tsx');
  assert.match(m, /\/api\/market\/catalog/);
  assert.match(m, /\/api\/market\/status/);
  assert.match(m, /CATEGORY_TILE/);
  assert.match(m, /function MarketIcon/);
  // rows/tiles navigate to the detail page
  assert.match(m, /function variantHref/);
});

test('Browse is token-styled, not hardcoded grays/blues (Workstream A)', () => {
  const m = read('src/app/market/page.tsx');
  assert.doesNotMatch(m, /text-gray-\d/);
  assert.doesNotMatch(m, /bg-gray-\d/);
  assert.doesNotMatch(m, /text-blue-\d/);
  // the old inline Sources editor + raw filter <select>s are gone from Browse
  assert.doesNotMatch(m, /<select/);
  assert.doesNotMatch(m, /saveMarketSources/);
});

test('Sources page exists: connected sources w/ switches + Add + Install from address (D9)', () => {
  assert.ok(has('src/app/market/sources/page.tsx'), 'market/sources page must exist');
  const s = read('src/app/market/sources/page.tsx');
  assert.match(s, /Connected sources/);
  assert.match(s, /from ['"]@\/components\/ui\/switch['"]/);
  assert.match(s, /Add source/);
  assert.match(s, /Install from address/);
  assert.match(s, /InstallFromUrlDialog/);
  assert.match(s, /\/api\/market\/source/);                 // PATCH to persist
  assert.match(s, /href="\/market"/);                       // back link
  assert.match(s, /Admin</);                                 // admin badge
});

test('Sources toggles persist to the real source API (no fake control)', () => {
  const s = read('src/app/market/sources/page.tsx');
  assert.match(s, /method: 'PATCH'/);
  assert.match(s, /onCheckedChange=\{\(v\) => toggle/);
  assert.match(s, /active_sources/);
});
