import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadApp } from '../src/lib/market/app-format/compile';

test('Session-owned app-network live fixtures remain valid and isolated from Market', async () => {
  const directory = path.join(process.cwd(), 'tests/live/fixtures');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.yaml')).sort();
  assert.deepEqual(names, [
    'fail-health.yaml',
    'fail-image.yaml',
    'healthy-multi.yaml',
    'healthy-single.yaml',
    'integration-source.yaml',
    'integration-target.yaml',
  ]);
  for (const name of names) {
    // Session fixtures use image tags on purpose (one is meant to fail to pull).
    const manifest = loadApp({ manifest: await readFile(path.join(directory, name), 'utf8') }, { allowUnpinned: true });
    assert.match(manifest.metadata.id, /^session-/);
  }
});
