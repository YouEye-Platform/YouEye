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

const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function assertInert(response: Response) {
  assert.equal(response.headers.get('content-security-policy'), SANDBOX);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

async function proxied(imageUrl: string, upstream: () => Response | Promise<Response>) {
  process.env.YOUEYE_RELEASE_CACHE = join(import.meta.dirname, 'missing-release-cache');
  const { GET } = await import('../src/app/api/market/image/route');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => upstream()) as typeof fetch;
  try {
    return await GET(new Request(`https://control.example.test/api/market/image?url=${encodeURIComponent(imageUrl)}`));
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('cdn.jsdelivr.net is not trusted (it serves any GitHub repository)', async () => {
  assert.doesNotMatch(route, /jsdelivr/);
  const response = await proxied('https://cdn.jsdelivr.net/gh/someone/repo/evil.svg', () => { throw new Error('must not fetch'); });
  assert.equal(response.status, 403);
  assertInert(response);
});

test('an allowed image keeps its type and is served under the sandbox policy', async () => {
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', () =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assertInert(response);
});

test('an SVG labelled text/plain (raw.githubusercontent.com) is typed by its extension and sandboxed', async () => {
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.svg', () =>
    new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assertInert(response);
});

for (const [name, url, type] of [
  ['HTML', 'https://raw.githubusercontent.com/o/r/v1/icon.svg', 'text/html; charset=utf-8'],
  ['script', 'https://raw.githubusercontent.com/o/r/v1/icon.png', 'application/javascript'],
  ['XHTML', 'https://raw.githubusercontent.com/o/r/v1/icon.svg', 'application/xhtml+xml'],
  ['an unknown extension under a generic type', 'https://raw.githubusercontent.com/o/r/v1/page.html', 'text/plain'],
  ['no type and no extension', 'https://raw.githubusercontent.com/o/r/v1/icon', ''],
] as const) {
  test(`${name} from an allowed host becomes the placeholder`, async () => {
    const response = await proxied(url, () => {
      const res = new Response('<html><script>alert(1)</script></html>');
      if (type) res.headers.set('Content-Type', type); else res.headers.delete('Content-Type');
      return res;
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.doesNotMatch(await response.text(), /script/);
    assertInert(response);
  });
}

test('placeholder and error answers carry the same headers', async () => {
  const { GET } = await import('../src/app/api/market/image/route');
  const failed = await proxied('https://raw.githubusercontent.com/o/r/main/icon.png', () => new Response('nope', { status: 404 }));
  assert.equal(failed.headers.get('content-type'), 'image/svg+xml');
  assertInert(failed);
  const thrown = await proxied('https://raw.githubusercontent.com/o/r/main/icon.png', () => { throw new Error('offline'); });
  assertInert(thrown);
  for (const query of ['', 'url=not-a-url', `url=${encodeURIComponent('https://example.com/x.png')}`, 'catalog=catalog.yaml']) {
    const response = await GET(new Request(`https://control.example.test/api/market/image?${query}`));
    assert.ok(response.status >= 400, query);
    assertInert(response);
  }
});

test('the proxy sandboxes the image route (its policy replaces the route\'s own)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function applySecurityHeaders');
  const branch = source.slice(start, source.indexOf("pathname === '/api/ping'", start));
  assert.match(branch, /pathname === '\/api\/market\/image'/);
  assert.match(branch, /default-src 'none'; style-src 'unsafe-inline'; sandbox/);
  assert.doesNotMatch(branch, /script-src/);
});

// ─── The proxy needs no sign-in: it never buffers more than 5 MiB ─────────────

const MiB = 1024 * 1024;

/** An endless PNG stream in 64 KiB chunks; `pulled` counts the bytes the proxy read. */
function endlessImage(headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { state.pulled += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: () => new Response(body, { headers: { 'Content-Type': 'image/png', ...headers } }) };
}

test('an upstream image announcing more than 5 MiB is refused before its body is read', async () => {
  const upstream = endlessImage({ 'Content-Length': String(6 * MiB) });
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', upstream.response);
  assert.equal(response.status, 200);
  assertInert(response);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(upstream.state.pulled, 0);
});

test('a streamed upstream image is read only up to 5 MiB, then refused', async () => {
  const upstream = endlessImage();
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', upstream.response);
  assert.equal(response.status, 200);
  assertInert(response);
  assert.ok(upstream.state.pulled <= 5 * MiB + 128 * 1024, `read ${upstream.state.pulled} bytes`);
  assert.equal(upstream.state.cancelled, true);

  const exact = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', () =>
    new Response(new Uint8Array(5 * MiB), { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(exact.status, 200, 'exactly 5 MiB passes');
  assert.equal((await exact.arrayBuffer()).byteLength, 5 * MiB);
});
