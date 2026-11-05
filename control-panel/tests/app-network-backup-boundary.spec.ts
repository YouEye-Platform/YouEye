import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('encrypted core backup includes durable app network state', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/backup/core-backup.ts'),
    'utf8',
  );
  assert.match(source, /stageAppNetworkRecoveryState\(stagingDir\)/);
  assert.match(source, /path\.join\(source, 'ipam\.json'\)/);
  assert.match(source, /path\.join\(source, 'operations'\)/);
  assert.match(source, /Transient allocator\/per-app lock directories are intentionally/);
});
