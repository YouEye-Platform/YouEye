import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ImageFetchCancelledError, isTransientImageFetchError, retryImageFetch,
} from '../src/lib/infrastructure/image-fetch-retry';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const digest = 'sha256:' + 'ab404c'.padEnd(64, '0');
const dnsTimeout = new Error('App installation failed (installer stage failed); rollback verified clean', {
  cause: new Error(`Operation failed: Failed getting remote image info: Failed to run: skopeo --insecure-policy inspect `
    + `docker://docker.io/docuseal/docuseal@${digest} --no-tags: exit status 1 (time="x" level=fatal msg="Error parsing `
    + `image name: pinging container registry: Get \\"https://production.cloudfront.docker.com/x?Expires=1&Signature=abc\\": `
    + `dial tcp: lookup production.cloudfront.docker.com on 10.0.0.1:53: read udp: i/o timeout")`),
});

test('network-shaped image fetch failures are transient', () => {
  assert.equal(isTransientImageFetchError(dnsTimeout), true);
  for (const message of [
    'Failed getting remote image info: connection reset by peer',
    'net/http: TLS handshake timeout',
    'received unexpected HTTP status: 503 Service Unavailable',
    'toomanyrequests: You have reached your pull rate limit',
    'Temporary failure in name resolution',
    'pinging container registry registry-1.docker.io: Get "https://registry-1.docker.io/v2/": dial tcp [2600:1f18::1]:443: connect: cannot assign requested address',
    'dial tcp 1.2.3.4:443: connect: no route to host',
  ]) assert.equal(isTransientImageFetchError(new Error(message)), true, message);
});

test('registry refusals and digest mismatches are not retried', () => {
  for (const message of [
    'skopeo inspect: manifest unknown: manifest unknown',
    'Error: unauthorized: authentication required',
    'reading manifest: requested access to the resource is denied',
    'received unexpected HTTP status: 404 Not Found',
    'digest mismatch: expected sha256:aa got sha256:bb',
    'Operation did not complete within 1800 seconds',
  ]) assert.equal(isTransientImageFetchError(new Error(message)), false, message);
});

test('transient failures retry with the configured backoff, then succeed', async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await retryImageFetch(async () => {
    calls++;
    if (calls < 3) throw dnsTimeout;
    return 'created';
  }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(result, 'created');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test('retries stop after six attempts and rethrow the last error', async () => {
  let calls = 0;
  await assert.rejects(retryImageFetch(async () => { calls++; throw dnsTimeout; },
    { sleep: async () => undefined }), (error) => error === dnsTimeout);
  assert.equal(calls, 6);
});

test('non-transient failures fail at once', async () => {
  let calls = 0;
  await assert.rejects(retryImageFetch(async () => { calls++; throw new Error('manifest unknown'); },
    { sleep: async () => undefined }), /manifest unknown/);
  assert.equal(calls, 1);
});

test('the abort signal stops the backoff wait', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = retryImageFetch(async () => { calls++; throw dnsTimeout; },
    { signal: controller.signal, delaysMs: [60_000] });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, ImageFetchCancelledError);
  assert.equal(calls, 1);
});

test('beforeRetry can veto a retry when the instance already exists', async () => {
  let calls = 0;
  await assert.rejects(retryImageFetch(async () => { calls++; throw dnsTimeout; },
    { sleep: async () => undefined, beforeRetry: () => false }), (error) => error === dnsTimeout);
  assert.equal(calls, 1);
});

test('OCI instance creation, infrastructure deploys and rebuilds share the retry', () => {
  const deployer = readFileSync(path.join(root, 'src/lib/infrastructure/oci-deployer.ts'), 'utf8');
  assert.match(deployer, /await retryImageFetch\(async \(\) => \{\s+const result = await incusRequest/);
  assert.match(deployer, /signal: options\?\.signal/);
  const snapshot = readFileSync(path.join(root, 'src/lib/incus/snapshot.ts'), 'utf8');
  assert.match(snapshot, /await retryImageFetch\(async \(\) => \{\s+const resp = await incusRequest/);
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  assert.match(engine, /deployOCIContainer\(ociManifest, '', appNIC, \{ start: !appBridgeName, owner, signal,/);
});
