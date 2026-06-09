import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('launch requirements derive manifest permissions and require user approval', () => {
  const route = read('src/app/api/v1/apps/[appId]/launch-requirements/route.ts');

  assert.match(route, /normalizeAppSurfaces\(manifest\)/);
  assert.match(route, /manifest\?\.permissions/);
  assert.match(route, /checkPermission\(userId, grantAppId, permission\)/);
  assert.match(route, /buildPermissionApproval\(grantAppId, missing, "persistent", request\)/);
  assert.match(route, /first_launch_complete: false/);
  assert.match(route, /first_launch_complete: true/);
  assert.match(route, /service app cannot inspect launch requirements for another app/);
  assert.match(route, /normalizePermissionAppId/);
  assert.match(route, /required_permissions: required\.map/);
});
