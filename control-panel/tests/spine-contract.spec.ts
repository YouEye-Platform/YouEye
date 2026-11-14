import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { backupSourceIdentityFromStatus } from '../src/lib/backup/compatibility';
import { backupStoreRequest, type BackupSetRecord } from '../src/lib/backup/platform-backup';

// Fixtures shared with Spine's tests (contracts/README.md).
const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const fixture = (name: string) => path.join(root, '..', 'contracts', 'spine-cp', name);

test('backup identity is built from the status Spine marshals', () => {
  const status = JSON.parse(readFileSync(fixture('status-appliance.json'), 'utf8'));
  const source = backupSourceIdentityFromStatus(status);
  assert.equal(source.runtime_kind, 'appliance-image');
  assert.equal(source.source_tree, status.runtime.source_tree);
  assert.equal(source.image_version, status.runtime.image_version);
  assert.equal(source.state_schema_version, status.persistent_state.state_schema_version);
  assert.equal(source.data_schema_version, status.persistent_state.data_schema_version);
  assert.equal(source.spine_version, status.spine.version);
});

test('the backup store request matches the body Spine decodes strictly', () => {
  const status = JSON.parse(readFileSync(fixture('status-appliance.json'), 'utf8'));
  const record: BackupSetRecord = {
    schema: 'youeye.backup.set.v1', id: 'backup-20261114T000000Z-0a1b2c3d', createdAt: '2026-11-14T00:00:00.000Z',
    status: 'completed', appCount: 1, apps: ['razzia'], reason: 'manual', sizeBytes: 4096,
    source: backupSourceIdentityFromStatus(status, '0.6.3-dev.1'),
  };
  const body = JSON.stringify(backupStoreRequest(record, 'media-1', undefined, true), null, 2) + '\n';
  if (process.env.YOUEYE_UPDATE_CONTRACTS === '1') writeFileSync(fixture('backup-store-request.json'), body);
  assert.equal(body, readFileSync(fixture('backup-store-request.json'), 'utf8'),
    'store request changed; regenerate with YOUEYE_UPDATE_CONTRACTS=1 and run Spine\'s contract test');
});
