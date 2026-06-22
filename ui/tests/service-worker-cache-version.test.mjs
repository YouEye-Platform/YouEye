import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'src/app/sw.ts'), 'utf8');

test('service worker versions runtime caches from the active build manifest', () => {
  assert.match(sw, /const CACHE_VERSION = getCacheVersion\(PRECACHE_ENTRIES\)/);
  assert.match(sw, /_buildManifest\\.js/);
  assert.match(sw, /function versionCacheName\(name: string\)/);
  assert.match(sw, /cacheName: versionCacheName\("static-assets"\)/);
});

test('service worker deletes old release caches during activation', () => {
  assert.match(sw, /LEGACY_CACHE_PREFIXES/);
  assert.match(sw, /isOwnedCache\(cacheName\) && !cachesToKeep\.has\(cacheName\)/);
  assert.match(sw, /"ui-"/);
});
