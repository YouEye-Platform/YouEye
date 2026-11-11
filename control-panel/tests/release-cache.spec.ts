import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cachedReleaseBytes } from '../src/lib/releases/cache';

test('candidate cache preserves exact URL identity and rejects equal-sized corruption', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-cache-'));
  const before = process.env.YOUEYE_RELEASE_CACHE;
  process.env.YOUEYE_RELEASE_CACHE = root;
  try {
    const bytes = Buffer.from('signed candidate');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = 'https://github.com/example/project/releases/download/ui-v1.2.3/standalone.tar';
    await mkdir(path.join(root, 'objects'));
    const object = path.join(root, 'objects', sha256);
    await writeFile(object, bytes, { mode: 0o600 });
    await writeFile(path.join(root, 'index.json'), JSON.stringify({ schema: 'youeye.release-cache.v1', objects: { [url]: { sha256, bytes: bytes.length } } }), { mode: 0o600 });
    assert.deepEqual(await cachedReleaseBytes(url), bytes);
    assert.equal(await cachedReleaseBytes(url.replace('1.2.3', '1.2.4')), null);
    await writeFile(object, 'forged candidate');
    await assert.rejects(cachedReleaseBytes(url), /digest rejected/);
    await writeFile(object, bytes);
    await chmod(object, 0o666);
    await assert.rejects(cachedReleaseBytes(url), /permissions/);
  } finally {
    if (before === undefined) delete process.env.YOUEYE_RELEASE_CACHE; else process.env.YOUEYE_RELEASE_CACHE = before;
    await rm(root, { recursive: true, force: true });
  }
});
