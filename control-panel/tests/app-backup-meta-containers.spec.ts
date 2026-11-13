import assert from 'node:assert/strict';
import test from 'node:test';
import { backupMetaContainers } from '../src/lib/backup/app-backup';
import { restoredBackupContainers } from '../src/lib/backup/app-restore';

// Regression: the restore once kept only object entries, but the backup writes plain names, so every restore lost
// its container list (a stopped app then always failed its post-restore health check).
test('the restore reads back exactly the container names the backup writes', () => {
  const written = backupMetaContainers([{ containerName: 'app-demo-main' }, { containerName: 'app-demo-db' }]);
  const meta = JSON.parse(JSON.stringify({ schema: 'youeye.backup.app-meta.v1', containers: written }));
  assert.deepEqual(restoredBackupContainers(meta.containers), ['app-demo-main', 'app-demo-db']);
  assert.deepEqual(restoredBackupContainers([{ containerName: 'app-x' }, 'Bad Name', 7]), []);
  assert.deepEqual(restoredBackupContainers(undefined), []);
});
