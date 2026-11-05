import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { AppManifestSchema } from '../src/lib/market/schema';

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
    const manifest = AppManifestSchema.parse(parse(await readFile(path.join(directory, name), 'utf8')));
    assert.match(manifest.metadata.id, /^session-/);
  }
});
