import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('both dashboard routes use the one settings-panel check', () => {
  for (const file of ['src/app/api/v1/apps/drawer/route.ts', 'src/app/api/ui-bridge/settings/[...path]/route.ts']) {
    const source = read(file);
    assert.match(source, /import \{ hasSettingsPanel \} from "@\/lib\/surfaces\/normalize"/, file);
    assert.doesNotMatch(source, /function hasSettingsPanel/, file);
  }
});
