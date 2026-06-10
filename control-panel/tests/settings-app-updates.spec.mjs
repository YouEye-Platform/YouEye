import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Settings apps list exposes a real update action for pending app updates', () => {
  const client = read('src/components/settings-shell/apps-client.tsx');

  assert.match(client, /function updateApp\(appId: string\)/);
  assert.match(client, /\/settings\/api\/auth\/csrf/);
  assert.match(client, /\/settings\/api\/apps\/\$\{encodeURIComponent\(appId\)\}\/update/);
  assert.match(client, /"X-CSRF-Token": csrfToken/);
  assert.match(client, /onClick=\{\(\) => updateApp\(app\.id\)\}/);
  assert.match(client, /isUpdating \? "Updating" : "Update"/);
  assert.doesNotMatch(client, /<Badge variant="secondary">Update<\/Badge>/);
});

test('Settings app update route is admin-scoped and reuses existing update engines', () => {
  const route = read('src/app/settings/api/apps/[appId]/update/route.ts');

  assert.match(route, /getSession/);
  assert.match(route, /verifyCSRFToken/);
  assert.match(route, /session\?\.isAdmin/);
  assert.match(route, /updateLXDApp/);
  assert.match(route, /updateMarketplaceApp/);
  assert.match(route, /updateOCIApp/);
  assert.match(route, /spineClient\.updateControl/);
  assert.match(route, /statusComponentFor\(appId\)/);
});
