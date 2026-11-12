import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freezeUpdateOCIImage } from '../src/lib/market/update-oci';

const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] });
const sha = createHash('sha256').update(manifest).digest('hex');
const response = () => new Response(manifest, { headers: { 'Docker-Content-Digest': `sha256:${sha}` } });

test('a tag is frozen to verified content and rebuild uses its exact digest', async () => {
  let requested = '';
  const result = await freezeUpdateOCIImage('docker.io/library/alpine:3.21', (async (url: string) => {
    requested = String(url); return response();
  }) as typeof fetch);
  assert.match(requested, /registry-1\.docker\.io\/v2\/library\/alpine\/manifests\/3.21$/);
  assert.deepEqual(result, { image: `docker.io/library/alpine@sha256:${sha}`, sha256: sha });
});
test('a mismatching source digest or requested digest fails before rebuild', async () => {
  await assert.rejects(freezeUpdateOCIImage('docker.io/library/alpine:3.21', (async () =>
    new Response(manifest, { headers: { 'Docker-Content-Digest': `sha256:${'0'.repeat(64)}` } })) as typeof fetch), /digest/);
  await assert.rejects(freezeUpdateOCIImage(`docker.io/library/alpine@sha256:${'0'.repeat(64)}`,
    (async () => response()) as typeof fetch), /digest/);
});
test('a registry cannot send bearer authentication to a foreign token authority', async () => {
  let calls = 0;
  await assert.rejects(freezeUpdateOCIImage('example.test/app:1', (async () => {
    calls++;
    return new Response(null, { status: 401, headers: {
      'www-authenticate': 'Bearer realm="https://foreign.test/token",service="registry"',
    } });
  }) as typeof fetch), /authority/);
  assert.equal(calls, 1);
});
test('public docker authentication stays in memory and uses pull-only scope', async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const result = await freezeUpdateOCIImage('docker.io/library/alpine:3.21', (async (url, options) => {
    const text = String(url);
    calls.push({ url: text, authorization: (options?.headers as Record<string, string>)?.Authorization });
    if (calls.length === 1) return new Response(null, { status: 401, headers: {
      'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
    } });
    if (calls.length === 2) return Response.json({ token: 'ephemeral-test-token' });
    return response();
  }) as typeof fetch);
  assert.equal(new URL(calls[1].url).searchParams.get('scope'), 'repository:library/alpine:pull');
  assert.equal(calls[2].authorization, 'Bearer ephemeral-test-token');
  assert.equal(JSON.stringify(result).includes('ephemeral'), false);
});
test('oversized and failed artifact reads are rejected without using mutable tags', async () => {
  await assert.rejects(freezeUpdateOCIImage('docker.io/library/alpine:3.21',
    (async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))) as typeof fetch), /too large/);
  await assert.rejects(freezeUpdateOCIImage('docker.io/library/alpine:3.21',
    (async () => new Response(null, { status: 404 })) as typeof fetch), /could not be resolved/);
});
