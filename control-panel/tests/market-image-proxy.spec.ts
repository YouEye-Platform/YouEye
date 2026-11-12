import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const route = readFileSync(join(root, 'src/app/api/market/image/route.ts'), 'utf8');

test('Control Panel image proxy trusts official GitHub assets and validates every redirect', () => {
  assert.match(route, /['"]raw\.githubusercontent\.com['"]/);
  assert.doesNotMatch(route, /private forge/i);
  assert.match(route, /parsed\.hostname === domain \|\| parsed\.hostname\.endsWith\('\.' \+ domain\)/);
  assert.match(route, /redirect: 'manual'/);
  assert.match(route, /isTrustedImageURL\(current\)/);
});

test('official catalog images come from the accepted catalog.tar, never from a catalog host', async () => {
  const { GET } = await import('../src/app/api/market/image/route');
  assert.match(route, /officialCatalogFile\(catalogPath\)/);
  assert.doesNotMatch(route, /catalog\.youeye\.me/);
  assert.equal((await GET(new Request('https://control.example.test/api/market/image?catalog=catalog.yaml'))).status, 400);
  assert.equal((await GET(new Request(`https://control.example.test/api/market/image?url=${encodeURIComponent('https://catalog.youeye.me/v1/snapshots/x/icon.svg')}`))).status, 403);
});
