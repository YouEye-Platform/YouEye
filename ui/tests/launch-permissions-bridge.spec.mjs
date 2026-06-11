import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('UI bridge exposes launch permission preview and selected grants for YouEye ID', () => {
  const route = read('src/app/api/ui-bridge/app-launch-permissions/route.ts');

  assert.match(route, /validateToken/);
  assert.match(route, /getApp\(appId\)/);
  assert.match(route, /collectManifestPermissions/);
  assert.match(route, /collectConnectionPermissions/);
  assert.match(route, /connection:\$\{record\.appId/);
  assert.match(route, /getPermissionDecision\(userId, appId, permission\)/);
  assert.match(route, /findUserByIdentityId/);
  assert.match(route, /findUserByUsername/);
  assert.match(route, /findUserByEmail/);
  assert.match(route, /findUserById/);
  assert.match(route, /identityUserId/);
  assert.match(route, /User not found in UI database/);
  assert.match(route, /getUserAppsWithConfig\(user\.id\)/);
  assert.match(route, /customIconUrl/);
  assert.match(route, /siteNameStyleToCSS/);
  assert.match(route, /CHARACTER_SHAPE_PRESETS/);
  assert.match(route, /branding_css: brandingCss/);
  assert.match(route, /branding_font_url: brandingFontUrl/);
  assert.match(route, /branding_css_chars: brandingCssChars/);
  assert.match(route, /brandingFontUrl = fontUrl \? \(publicUrl\(fontUrl\) \?\? fontUrl\) : null/);
  assert.match(route, /avatar_url: publicUrl\(user\.image\)/);
  assert.match(route, /avatar_path: user\.image/);
  assert.match(route, /base \? `\$\{base\}\$\{value\}` : null/);
  assert.match(route, /display: await consentDisplay\(user, appId\)/);
  assert.match(route, /grantPermissions/);
  assert.match(route, /denyUnselected/);
  assert.match(route, /allowed\.has\(permission\)/);
  assert.match(route, /grantPermission\(userId, appId, permission, "persistent", "youeye-id-consent"\)/);
  assert.match(route, /denyPermission\(userId, appId, permission, "youeye-id-consent"\)/);
  assert.match(route, /describePermission/);
});
