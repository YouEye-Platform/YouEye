import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.env.UI_ROOT || join(import.meta.dirname, '..');
const route = readFileSync(join(root, 'src/app/api/market/image/route.ts'), 'utf8');
const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function assertInert(response: Response) {
  assert.equal(response.headers.get('content-security-policy'), SANDBOX);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

async function proxied(imageUrl: string, upstream: () => Response | Promise<Response>) {
  const { GET } = await import('../src/app/api/market/image/route');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => upstream()) as typeof fetch;
  try {
    return await GET(new Request(`https://ui.example.test/api/market/image?url=${encodeURIComponent(imageUrl)}`));
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('UI image proxy trusts official GitHub assets and validates every redirect', () => {
  assert.match(route, /['"]raw\.githubusercontent\.com['"]/);
  assert.doesNotMatch(route, /private forge/i);
  assert.match(route, /parsed\.hostname === domain \|\| parsed\.hostname\.endsWith\('\.' \+ domain\)/);
  assert.match(route, /redirect: 'manual'/);
  assert.match(route, /isTrustedImageURL\(current\)/);
});

test('cdn.jsdelivr.net is not trusted (it serves any GitHub repository)', async () => {
  assert.doesNotMatch(route, /jsdelivr/);
  const response = await proxied('https://cdn.jsdelivr.net/gh/someone/repo/evil.svg', () => { throw new Error('must not fetch'); });
  assert.equal(response.status, 403);
  assertInert(response);
});

test('an allowed image keeps its type and is served under the sandbox policy', async () => {
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.webp', () =>
    new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { 'Content-Type': 'image/webp' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
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
  ['script', 'https://raw.githubusercontent.com/o/r/v1/icon.png', 'text/javascript'],
  ['XHTML', 'https://raw.githubusercontent.com/o/r/v1/icon.svg', 'application/xhtml+xml'],
  ['an unknown extension under a generic type', 'https://raw.githubusercontent.com/o/r/v1/page.html', 'text/plain'],
] as const) {
  test(`${name} from an allowed host is refused`, async () => {
    const response = await proxied(url, () =>
      new Response('<html><script>alert(1)</script></html>', { headers: { 'Content-Type': type } }));
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.doesNotMatch(await response.text(), /script/);
    assertInert(response);
  });
}

test('error answers carry the same headers', async () => {
  const { GET } = await import('../src/app/api/market/image/route');
  assertInert(await proxied('https://raw.githubusercontent.com/o/r/main/icon.png', () => new Response('nope', { status: 404 })));
  assertInert(await proxied('https://raw.githubusercontent.com/o/r/main/icon.png', () => { throw new Error('offline'); }));
  for (const query of ['', 'url=not-a-url', `url=${encodeURIComponent('https://example.com/x.png')}`]) {
    const response = await GET(new Request(`https://ui.example.test/api/market/image?${query}`));
    assert.ok(response.status >= 400, query);
    assertInert(response);
  }
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
  assert.equal(response.status, 502);
  assertInert(response);
  assert.equal(upstream.state.pulled, 0);
});

test('a streamed upstream image is read only up to 5 MiB, then refused', async () => {
  const upstream = endlessImage();
  const response = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', upstream.response);
  assert.equal(response.status, 502);
  assertInert(response);
  assert.ok(upstream.state.pulled <= 5 * MiB + 128 * 1024, `read ${upstream.state.pulled} bytes`);
  assert.equal(upstream.state.cancelled, true);

  const exact = await proxied('https://raw.githubusercontent.com/o/r/v1/icon.png', () =>
    new Response(new Uint8Array(5 * MiB), { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(exact.status, 200, 'exactly 5 MiB passes');
  assert.equal((await exact.arrayBuffer()).byteLength, 5 * MiB);
});
