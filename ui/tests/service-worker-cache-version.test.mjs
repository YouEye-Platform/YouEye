import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'src/app/sw.ts'), 'utf8');

test('service worker uses Serwist instead of hand-rolled install precaching', () => {
  assert.match(sw, /new Serwist\(/);
  assert.match(sw, /precacheEntries: self\.__SW_MANIFEST \?\? \[\]/);
  assert.match(sw, /serwist\.addEventListeners\(\)/);
  assert.doesNotMatch(sw, /self\.addEventListener\("install"/);
  assert.doesNotMatch(sw, /PRECACHE_ENTRIES\.map/);
  assert.doesNotMatch(sw, /event\.respondWith/);
});

test('service worker deletes old app-owned runtime caches during activation', () => {
  assert.match(sw, /LEGACY_CACHE_PREFIXES/);
  assert.match(sw, /ACTIVE_RUNTIME_CACHES/);
  assert.match(sw, /caches\.delete\(cacheName\)/);
  assert.match(sw, /"ui-"/);
});
