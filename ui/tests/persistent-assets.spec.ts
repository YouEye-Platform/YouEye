import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { imageExtension, persistentAssetResponse } from '../src/lib/persistent-assets';

test('uploaded image URLs retain bytes when executable directories are replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-assets-'));
  try {
    const app = join(root, 'code');
    const data = join(root, 'data');
    await mkdir(app); await mkdir(data);
    await writeFile(join(data, 'logo-fixture.png'), 'fixture image bytes');
    await rename(app, join(root, 'previous-code'));
    await mkdir(app);
    const response = await persistentAssetResponse(data, ['logo-fixture.png']);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), 'fixture image bytes');
    assert.equal(imageExtension('image/jpeg'), 'jpg');
    assert.throws(() => imageExtension('text/javascript'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('persistent public image reads refuse traversal, links and non-image files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-assets-'));
  try {
    await writeFile(join(root, 'owner.env'), 'private fixture');
    await symlink('owner.env', join(root, 'logo.png'));
    await symlink(root, join(root, 'linked-owner'));
    for (const parts of [['..', 'owner.env'], ['owner.env'], ['logo.png'], ['linked-owner', 'logo.png'], ['missing.png'], ['script.js']]) {
      assert.equal((await persistentAssetResponse(root, parts)).status, 404);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
