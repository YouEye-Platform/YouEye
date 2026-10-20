import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPublicAsset, isPublicPrecache, privateNetworkRequest } from '../src/lib/pwa-cache-policy.ts';
const origin = 'https://app.example.test';
test('persistent cache cannot retain identity, API, RSC, navigation or remote data', () => {
  for (const path of ['/offline', '/offline.html?account=one', '/api/me', '/api/notes', '/identity/session/check', '/dashboard', '/?_rsc=123', '/_next/data/build/private.json', '/fonts/private?user=one', '/icons/a.svg?token=private', 'https://other.example.test/fonts/a.woff2']) {
    const url = new URL(path, origin);
    assert.equal(isPublicAsset(url, origin), false, path);
    assert.equal(isPublicPrecache(url, origin), false, path);
  }
  for (const path of ['/_next/static/build/app.js', '/fonts/public.woff2', '/icons/app.png']) {
    assert.equal(isPublicAsset(new URL(path, origin), origin), true);
  }
  assert.equal(isPublicPrecache(new URL('/offline.html', origin), origin), true);
  assert.equal(isPublicAsset(new URL('/offline.html', origin), origin), false);
});

test('private network requests retain routing and authentication metadata while bypassing HTTP caching', async () => {
  for (const method of ['GET', 'POST']) {
    const original = new Request(`${origin}/api/ai/catalog`, {
      method, referrer: `${origin}/settings/ai/models`, referrerPolicy: 'same-origin',
      credentials: 'include', redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-only', RSC: '1' },
      ...(method === 'POST' ? { body: JSON.stringify({ test: true }) } : {}),
    });
    const expectedBody = await original.clone().text();
    const forwarded = privateNetworkRequest(original);
    assert.equal(forwarded.cache, 'no-store');
    for (const field of ['url', 'method', 'referrer', 'referrerPolicy', 'credentials', 'redirect', 'mode']) {
      assert.equal(forwarded[field], original[field], field);
    }
    assert.deepEqual([...forwarded.headers], [...original.headers]);
    assert.equal(await forwarded.text(), expectedBody);
  }
  const withoutReferrer = privateNetworkRequest(new Request(`${origin}/api/me`, { referrer: '' }));
  assert.equal(withoutReferrer.referrer, '');
});

test('worker transforms the request without a fetch init that would reset its referrer', () => {
  const worker = readFileSync(new URL('../src/app/sw.ts', import.meta.url), 'utf8');
  assert.match(worker, /requestWillFetch: \(\{ request \}\) => privateNetworkRequest\(request\)/);
  assert.doesNotMatch(worker, /fetchOptions\s*:/);
});
