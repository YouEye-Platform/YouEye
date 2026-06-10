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
  const settingsRoute = read('src/app/api/v1/apps/[appId]/user-settings/route.ts');

  assert.match(route, /normalizeAppSurfaces\(manifest\)/);
  assert.match(route, /manifest\?\.permissions/);
  assert.match(route, /collectLaunchPreferences\(manifest\)/);
  assert.match(route, /manifest\?\.preferences/);
  assert.match(route, /manifest\?\.launchPreferences/);
  assert.match(route, /settings.schema/);
  assert.match(route, /getUserSettings\(userId\)/);
  assert.match(route, /missing_preferences/);
  assert.match(route, /preferences_required/);
  assert.match(route, /app_settings_url_absolute/);
  assert.match(route, /app_settings_api_absolute/);
  assert.match(route, /checkPermission\(userId, grantAppId, permission\)/);
  assert.match(route, /request\.nextUrl\.searchParams\.get\("return_to"\)/);
  assert.match(route, /buildPermissionApproval\(grantAppId, missing, "persistent", request, returnTo\)/);
  assert.match(route, /first_launch_complete: false/);
  assert.match(route, /first_launch_complete: true/);
  assert.match(route, /service app cannot inspect launch requirements for another app/);
  assert.match(route, /normalizePermissionAppId/);
  assert.match(route, /required_permissions: required\.map/);

  assert.match(settingsRoute, /permissionAppMatches\(callingApp, appId\)/);
  assert.match(settingsRoute, /normalizePermissionAppId\(appId\)/);
});
