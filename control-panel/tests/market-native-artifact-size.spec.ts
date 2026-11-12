import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MAX_ARTIFACT_BYTES, MarketNativeArtifactPolicyError, stageVerifiedProductArtifact } from '../src/lib/market/native-artifact';
import { downloadProductAssetTo, downloadReleaseFileTo } from '../src/lib/releases/channel-index';
import { productBlobWithinLimit, type VerifiedProductRelease } from '../src/lib/releases/product-release';
import { incusUploadLocalFile } from '../src/lib/incus/server';

const MiB = 1024 * 1024;
const repository = 'https://github.com/YouEye-Platform/Search';
const tag = 'v0.6.2-dev.1';

function release(assets: Array<{ name: string; size_bytes: number; sha256: string }>) {
  return {
    repository,
    manifestSHA256: 'a'.repeat(64),
    release: { product: 'search', version: '0.6.2-dev.1', tag },
    build: { kind: 'native', assets },
  } as unknown as VerifiedProductRelease;
}

/** A body of `size` bytes made of fresh 1 MiB chunks, sampling memory as it is consumed. */
function streamingBody(size: number, peak: { bytes: number }) {
  const base = process.memoryUsage().arrayBuffers;
  let sent = 0;
  const hash = createHash('sha256');
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(MiB, size - sent)).fill(sent / MiB % 251);
      hash.update(chunk);
      sent += chunk.byteLength;
      peak.bytes = Math.max(peak.bytes, process.memoryUsage().arrayBuffers - base);
      controller.enqueue(chunk);
    },
  });
  return { body, digest: () => hash.digest('hex') };
}

test('native app packages up to 1 GiB are accepted; a larger one names the limit', async () => {
  assert.equal(MAX_ARTIFACT_BYTES, 1024 * MiB);
  const search = release([{ name: 'standalone.tar', size_bytes: 1100 * MiB, sha256: 'b'.repeat(64) }]);
  await assert.rejects(stageVerifiedProductArtifact('/nonexistent', 'app-search', search), (error: unknown) => {
    assert.ok(error instanceof MarketNativeArtifactPolicyError);
    assert.equal(error.message, 'The search 0.6.2-dev.1 package (1100 MB) is larger than the limit (1024 MB)');
    return true;
  });
  assert.throws(() => productBlobWithinLimit(search, 'standalone.tar', 256 * MiB),
    /package standalone\.tar \(1100 MB\) is larger than the limit \(256 MB\)/);
  assert.throws(() => productBlobWithinLimit(search, 'missing.tar', 256 * MiB), /has no missing\.tar asset$/);
  // 370 MB, the size of Search's package that used to be refused, is within the limit.
  assert.equal(productBlobWithinLimit(release([{ name: 'standalone.tar', size_bytes: 370 * MiB, sha256: 'c'.repeat(64) }]), 'standalone.tar', MAX_ARTIFACT_BYTES).size_bytes, 370 * MiB);
});

test('a large package streams to disk with bounded memory and a checked digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-size-'));
  try {
    const size = 192 * MiB;
    const peak = { bytes: 0 };
    const source = streamingBody(size, peak);
    const target = join(root, 'standalone.tar');
    const written = await downloadReleaseFileTo(`${repository}/releases/download/${tag}/standalone.tar`, target, size,
      (async () => new Response(source.body, { headers: { 'content-length': String(size) } })) as typeof fetch);
    assert.equal(written.bytes, size);
    assert.equal(written.sha256, source.digest());
    // Buffering the whole file would hold all 192 MiB at once.
    assert.ok(peak.bytes < 96 * MiB, `peak buffered memory ${Math.round(peak.bytes / MiB)} MiB`);

    // Over the declared size: refused while streaming (no content-length to catch it early).
    const over = streamingBody(4 * MiB, { bytes: 0 });
    await assert.rejects(downloadReleaseFileTo(`${repository}/releases/download/${tag}/other.tar`, join(root, 'other.tar'), 2 * MiB,
      (async () => new Response(over.body)) as typeof fetch), /exceeds/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a product asset whose bytes differ from its build digest is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-digest-'));
  try {
    const bytes = Buffer.from('archive bytes');
    const asset = { name: 'standalone.tar', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const fetcher = (payload: Buffer) => (async () => new Response(new Uint8Array(payload))) as typeof fetch;
    assert.equal(await downloadProductAssetTo(release([asset]), 'standalone.tar', join(root, 'a.tar'), MiB, fetcher(bytes)), bytes.length);
    assert.deepEqual(await readFile(join(root, 'a.tar')), bytes);
    await assert.rejects(downloadProductAssetTo(release([asset]), 'standalone.tar', join(root, 'b.tar'), MiB,
      fetcher(Buffer.from('archive BYTES'))), /differs from its original build digest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a local file is streamed to Incus as the upload body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-incus-upload-'));
  const socket = join(root, 'incus.socket');
  const before = { socket: process.env.INCUS_SOCKET, https: process.env.INCUS_HTTPS_URL };
  const payload = Buffer.alloc(3 * MiB + 17, 7);
  await writeFile(join(root, 'standalone.tar'), payload);
  let received = Buffer.alloc(0);
  let head = '';
  const server = createServer((connection) => {
    connection.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const split = received.indexOf('\r\n\r\n');
      if (split < 0) return;
      head = received.subarray(0, split).toString();
      const length = Number(/Content-Length: (\d+)/.exec(head)?.[1]);
      if (received.length - split - 4 < length) return;
      received = received.subarray(split + 4);
      const body = JSON.stringify({ type: 'sync', status: 'Success', status_code: 200, metadata: {} });
      connection.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await incusUploadLocalFile('app-search', '/tmp/app.tar', join(root, 'standalone.tar'), { mode: '0600' });
    assert.match(head, /^POST \/1\.0\/instances\/app-search\/files\?path=%2Ftmp%2Fapp\.tar HTTP\/1\.1/);
    assert.match(head, new RegExp(`Content-Length: ${payload.length}`));
    assert.match(head, /X-Incus-mode: 0600/);
    assert.ok(received.equals(payload));
  } finally {
    if (before.socket === undefined) delete process.env.INCUS_SOCKET; else process.env.INCUS_SOCKET = before.socket;
    if (before.https !== undefined) process.env.INCUS_HTTPS_URL = before.https;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
