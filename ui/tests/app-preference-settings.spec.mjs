import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('app settings page renders and saves manifest-declared preferences', () => {
  const detail = read('src/components/settings/app-settings-detail.tsx');

  assert.match(detail, /collectPreferenceFields/);
  assert.ok(detail.includes('manifest?.preferences'));
  assert.ok(detail.includes('manifest?.launchPreferences'));
  assert.ok(detail.includes('"settings.schema"'));
  assert.ok(detail.includes('/api/v1/apps/${encodeURIComponent(targetAppId)}/manifest'));
  assert.ok(detail.includes('/api/v1/apps/${encodeURIComponent(targetAppId)}/user-settings'));
  assert.ok(detail.includes('/api/v1/apps/${encodeURIComponent(app.id)}/user-settings'));
  assert.match(detail, /PreferenceFieldInput/);
  assert.ok(detail.includes('field.type === "password" ? "password" : "text"'));
  assert.ok(detail.includes('field.type === "select"'));
  assert.ok(detail.includes('field.type === "boolean"'));
  assert.ok(detail.includes('hasEmbeddedSettings || hasPreferenceSettings'));
});
