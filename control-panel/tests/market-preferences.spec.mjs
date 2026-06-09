import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Market manifests preserve first-launch user preference declarations', () => {
  const schema = read('src/lib/market/schema.ts');
  const types = read('src/lib/market/types.ts');

  assert.match(schema, /UserPreferenceFieldSchema/);
  assert.match(schema, /AppSettingsSchema/);
  assert.match(schema, /preferences: z\.array\(UserPreferenceFieldSchema\)\.optional\(\)\.default\(\[\]\)/);
  assert.match(schema, /launchPreferences: z\.array\(UserPreferenceFieldSchema\)\.optional\(\)\.default\(\[\]\)/);
  assert.match(schema, /settings: AppSettingsSchema/);
  assert.match(schema, /choices: z\.array\(z\.object/);
  assert.match(schema, /description: z\.string\(\)\.optional\(\)/);

  assert.match(types, /export type UserPreferenceField/);
  assert.match(types, /export type AppSettingsSpec/);
});
