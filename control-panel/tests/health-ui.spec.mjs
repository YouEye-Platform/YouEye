import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/settings-shell/health-client.tsx'), 'utf8');

test('Health follows the shared Settings hierarchy and neutral surfaces', () => {
  assert.match(source, /<PageHeader/);
  assert.match(source, /title="Health"/);
  assert.doesNotMatch(source, /text-3xl|bg-blue-|bg-red-|bg-amber-50(?:\s|"|')/);
  assert.match(source, /bg-card/);
});

test('Health uses calm status dot and word labels with human service categories', () => {
  assert.match(source, /Check soon/);
  assert.match(source, /Needs attention/);
  assert.match(source, /Apps and connections/);
  assert.doesNotMatch(source, /Durable repair registry|Badge variant="outline">\{issue\.source\}/);
});

test('Health surfaces request failures and provides a retry', () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /Try again/);
  assert.match(source, /throw new Error/);
});
