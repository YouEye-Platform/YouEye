import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E1 — header-config app-list security fix.
// Run: node --test tests/header-config-security.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('header/config omits the installed-app list for native-app (service) calls', () => {
  const r = read('src/app/api/v1/header/config/route.ts');
  // service calls (X-YouEye-App) get NO apps/sections; the UI's own header keeps them
  assert.match(r, /isServiceCall \? \{\} : \{ apps, sections \}/);
  assert.match(r, /E1 security fix/);
  // the service-call flag is derived from the app header
  assert.match(r, /const isServiceCall = !!request\.headers\.get\("x-youeye-app"\)/);
});

test('ui settings bridge exposes the UI base URL for CP iframe hosts', () => {
  const r = read('src/app/api/ui-bridge/settings/[...path]/route.ts');

  assert.match(r, /function getUiBaseUrl\(request: NextRequest\)/);
  assert.match(r, /ui_base_url: uiBaseUrl/);
});

test('ui settings bridge returns absolute avatar URLs to cross-origin native apps', () => {
  const r = read('src/app/api/ui-bridge/settings/[...path]/route.ts');

  assert.match(r, /function normalizeAvatarUrl/);
  assert.match(r, /image: normalizeAvatarUrl\(user\.image, uiBaseUrl\)/);
  assert.match(r, /avatar_url: avatarUrl/);
});
