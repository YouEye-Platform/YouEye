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

test('hosted catalog images use the protected transport without trusting unrelated domains', async () => {
  const { GET } = await import('../src/app/api/market/image/route');
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=(async(input: string | URL | Request)=>{
      assert.equal(String(input),`https://catalog.youeye.me/v1/snapshots/${'a'.repeat(40)}/apps/example/icon.svg`);
      return new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}});
    }) as typeof fetch;
    const response=await GET(new Request(`https://control.example.test/api/market/image?url=${encodeURIComponent(`https://catalog.youeye.me/v1/snapshots/${'a'.repeat(40)}/apps/example/icon.svg`)}`));
    assert.equal(response.status,200);assert.equal(await response.text(),'<svg/>');
    assert.equal((await GET(new Request('https://control.example.test/api/market/image?url=https://catalog.youeye.me.evil.test/icon.svg'))).status,403);
  } finally {globalThis.fetch=originalFetch;}
});
