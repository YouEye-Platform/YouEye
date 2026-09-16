import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.env.UI_ROOT || join(import.meta.dirname, '..');
const route = readFileSync(join(root, 'src/app/api/market/image/route.ts'), 'utf8');

test('UI image proxy trusts official GitHub assets and validates every redirect', () => {
  assert.match(route, /['"]raw\.githubusercontent\.com['"]/);
  assert.doesNotMatch(route, /private forge/i);
  assert.match(route, /parsed\.hostname === domain \|\| parsed\.hostname\.endsWith\('\.' \+ domain\)/);
  assert.match(route, /redirect: 'manual'/);
  assert.match(route, /isTrustedImageURL\(current\)/);
});
