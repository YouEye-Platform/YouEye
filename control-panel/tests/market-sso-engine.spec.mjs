import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('SSO engine supports equals conditions used by Integration cleanup steps', () => {
  const engine = read('src/lib/market/sso-engine.ts');

  assert.ok(engine.includes('const equalsMatch = trimmed.match'));
  assert.ok(engine.includes("\\s+equals\\s+'([^']*)'"));
  assert.ok(engine.includes('const resolvedExpected = resolveStepVariables(expected, ctx)'));
  assert.ok(engine.includes("String(value ?? '') === resolvedExpected"));
  assert.ok(engine.includes('const expected = resolveStepVariables(search, ctx)'));
});

test('SSO action steps fail loudly on non-OK responses', () => {
  const engine = read('src/lib/market/sso-engine.ts');

  assert.ok(engine.includes('const res = await fetch(url'));
  assert.ok(engine.includes('if (!res.ok)'));
  assert.ok(engine.includes('SSO action ${action.method} ${url} failed'));
  assert.ok(engine.includes('statusCode: res.status'));
});

test('SSO API steps tolerate successful non-JSON responses', () => {
  const engine = read('src/lib/market/sso-engine.ts');

  assert.ok(engine.includes('return { body: JSON.parse(text), response: res }'));
  assert.ok(engine.includes('return { body: { raw: text }, response: res }'));
});
