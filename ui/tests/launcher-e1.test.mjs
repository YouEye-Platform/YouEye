import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E1 — the UI-served app launcher (one implementation; native apps iframe it).
// Run: node --test tests/launcher-e1.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('Launcher renders search + app grid + Market/Settings system tiles', () => {
  const l = read('src/components/layout/launcher.tsx');
  assert.match(l, /t\("searchApps"\)/);
  assert.match(l, /searchHits\.map/);
  assert.match(l, /gridItems\.map/);
  assert.match(l, /systemTiles/);
  assert.match(l, /href: "\/market"/);
  assert.match(l, /href: "\/settings"/);
});

test('Launcher data comes from the UI drawer API only — never CP (pitfall #25)', () => {
  const l = read('src/components/layout/launcher.tsx');
  assert.match(l, /\/api\/v1\/apps\/drawer/);
  assert.doesNotMatch(l, /CP_|control\.|ui-bridge|10\.87/);  // no CP origins
});

test('embedded mode opens apps at the top window (iframe-safe)', () => {
  const l = read('src/components/layout/launcher.tsx');
  assert.match(l, /window\.top\.location\.href/);
});

test('/embed/launcher route serves the launcher (UI origin) with theme via ?mode', () => {
  const p = read('src/app/embed/launcher/page.tsx');
  assert.match(p, /<Launcher embedded/);
  assert.match(p, /useSearchParams/);
  assert.match(p, /classList\.add\("dark"\)/);
});
