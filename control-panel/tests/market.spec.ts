import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream D — Market Browse + Sources.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/market.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('Browse page layout includes hero, pill bar, Built-for, Featured, and Sources pill', () => {
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

test('App detail rebuilt to mockup: hero (88px tile) + meta band + 2-up gallery + About', () => {
  const d = read('src/app/market/[appId]/page.tsx');
  assert.match(d, /heroTile/);                 // category-coloured 88px tile
  assert.match(d, /size-\[88px\]/);
  assert.match(d, />Version</);
  assert.match(d, />Category</);
  assert.match(d, />Source</);
  assert.match(d, />Developer</);
  assert.match(d, />Account login</);
  assert.match(d, /About this app/);
  // gallery shows designed placeholders, never broken images
  assert.match(d, /aspectRatio: '16 \/ 10'/);
  assert.match(d, /<Camera /);
});

test('App detail preserves install/uninstall machinery + drops the fake domain fallback', () => {
  const d = read('src/app/market/[appId]/page.tsx');
  assert.match(d, /InstallDialog/);
  assert.match(d, /handleInstall/);
  assert.match(d, /UninstallDialog/);
  assert.match(d, /handleUninstall/);
  assert.doesNotMatch(d, /youeye\.local/);     // pitfall #13
});

test('App detail is token-styled (dark-mode-correct), no hardcoded gray/blue/white', () => {
  const d = read('src/app/market/[appId]/page.tsx');
  assert.doesNotMatch(d, /text-gray-\d/);
  assert.doesNotMatch(d, /bg-gray-\d/);
  assert.doesNotMatch(d, /\bbg-white\b/);
  assert.doesNotMatch(d, /text-blue-\d/);
  assert.doesNotMatch(d, /border-gray-\d/);
});
