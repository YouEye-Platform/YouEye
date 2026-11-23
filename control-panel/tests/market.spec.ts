import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream D — Market Browse + Sources.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/market.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => englishInterfaceSource(readFileSync(join(repoRoot, p), 'utf8'));
const has = (p: string) => existsSync(join(repoRoot, p));

test('Browse is one grid of apps: title + search, category chips, curated shelves, and the sources footer', () => {
  const m = read('src/app/market/page.tsx');
  assert.match(m, />Market<\/h1>/);
  assert.match(m, /type="search" value=\{search\}/);
  assert.match(m, /onClick=\{\(\) => setCategory\('all'\)\}>All</);
  assert.match(m, /Built for your server/);              // the catalog's spotlight, or the native apps
  assert.match(m, /curation\?\.collections/);              // the catalog's own collections, never invented picks
  assert.match(m, /const shelves = usedCategories/);       // one shelf per category
  assert.match(m, /href="\/market\/sources"/);
  assert.match(m, /Manage sources/);
  // Installed apps and their updates are managed in Settings → Apps, not here.
  assert.doesNotMatch(m, /\/api\/market\/updates/);
});

test('Browse uses real catalog/status data + category-coloured icon tiles', () => {
  const m = read('src/app/market/page.tsx');
  assert.match(m, /\/api\/market\/catalog/);
  assert.match(m, /\/api\/market\/status/);
  // Category tiles are DATA-DRIVEN from the catalog `categories:` section, not a hardcoded map.
  assert.match(m, /categoryLookup\(categoryDefs\)/);
  assert.match(m, /tile=\{categories\.tile\(app\.category\)\}/);
  const parts = read('src/components/market/market-parts.tsx');
  assert.match(parts, /export function MarketIcon/);
  assert.match(parts, /tile: \(id\?: string\) => of\(id\)\?\.tile \?\? DEFAULT_TILE/);
  // cards navigate to the detail page, with the source for another market's copy
  assert.match(parts, /export function appHref/);
  assert.match(parts, /\?source=\$\{encodeURIComponent\(app\.sourceId\)\}/);
  assert.match(parts, /<Link href=\{appHref\(app\)\}/);
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

test('App detail is a store page: header with the one action, facts, screenshots, About', () => {
  const d = read('src/app/market/[appId]/page.tsx');
  assert.match(d, /<MarketIcon app=\{app\} size=\{88\} tile=\{categories\.tile\(app\.category\)\} \/>/);
  assert.match(d, /const action = thisInstall \? null : isInstalled \?/);
  assert.match(d, /className="market-facts/);
  assert.match(d, /market\("facts\.signIn"\)/);
  assert.match(d, /market\("facts\.access"\)/);
  assert.match(d, /className="market-shots"/);
  assert.match(d, />About<\/h2>/);
});

test('App detail keeps the install machinery; uninstall lives in Settings; no fake domain fallback', () => {
  const d = read('src/app/market/[appId]/page.tsx');
  assert.match(d, /InstallDialog/);
  assert.match(d, /const handleInstall = async/);
  assert.match(d, /onInstall=\{handleInstall\}/);
  // An installed app is opened, or managed (and uninstalled) in Settings → Apps.
  assert.match(d, /href=\{`\/settings\/apps\/\$\{encodeURIComponent\(app\.id\)\}`\}>Manage in Settings</);
  assert.doesNotMatch(d, /\/api\/market\/uninstall/);
  const manage = read('src/components/market/app-management.tsx');
  assert.match(manage, /<UninstallDialog app=\{app\} onUninstall=\{uninstall\}/);
  assert.match(manage, /authenticatedFetch\('\/api\/market\/uninstall'/);
  assert.match(read('src/components/settings-shell/apps-client.tsx'), /<AppUninstall appId=\{appId\} appName=\{title\} \/>/);
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
