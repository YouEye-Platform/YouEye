import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('schema-only settings do not imply an embedded app settings panel', () => {
  const drawerRoute = read('src/app/api/v1/apps/drawer/route.ts');
  const bridgeSettingsRoute = read('src/app/api/ui-bridge/settings/[...path]/route.ts');

  for (const source of [drawerRoute, bridgeSettingsRoute]) {
    const body = source.match(/function hasSettingsPanel[\s\S]*?^}/m)?.[0] ?? '';
    assert.ok(body.includes('capabilities?.settings_panel === true'));
    assert.ok(body.includes('manifest.settings_panel === true'));
    assert.ok(!body.includes('typeof manifest.settings === "object"'));
  }
});
