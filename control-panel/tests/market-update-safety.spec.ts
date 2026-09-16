import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  beginContainerMaintenance,
  isContainerMaintenanceActive,
  withContainerMaintenance,
} from '../src/lib/maintenance/container-maintenance';
import {
  buildRollbackCopyRequest,
  buildRollbackRenameRequest,
  buildOCIRebuildRequest,
  resolveOCIImageReference,
} from '../src/lib/incus/snapshot';
import { recoverOriginallyRunningContainers } from '../src/lib/market/update-recovery';
import { writeJSON } from '../src/lib/storage/json-store';
import { SerializedExecutor } from '../src/lib/storage/serialized-executor';
import { checkUpdateStatusAccess } from '../src/lib/updates/status-access';

test('concurrent atomic JSON writers use independent temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'youeye-update-status-'));
  const target = join(dir, 'update-status.json');
  try {
    await Promise.all(
      Array.from({ length: 64 }, (_, sequence) => writeJSON(target, { sequence })),
    );

    const finalValue = JSON.parse(await readFile(target, 'utf8')) as { sequence: number };
    assert.ok(finalValue.sequence >= 0 && finalValue.sequence < 64);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.includes('.tmp-')),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serialized progress mutations retain invocation order and continue after failure', async () => {
  const queue = new SerializedExecutor();
  const events: string[] = [];
  const first = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('first');
  });
  const failed = queue.run(async () => {
    events.push('failed');
    throw new Error('write failed');
  });
  const last = queue.run(async () => {
    events.push('last');
  });

  await first;
  await assert.rejects(failed, /write failed/);
  await last;
  assert.deepEqual(events, ['first', 'failed', 'last']);
});

test('container maintenance is durable, exclusive, and always releases after failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youeye-maintenance-'));
  const options = { stateDirectory: directory, operation: 'test-update' };
  try {
    const lease = beginContainerMaintenance(['app-searxng-main', 'app-searxng-redis'], options);
    assert.equal(isContainerMaintenanceActive('app-searxng-main', options), true);
    assert.throws(
      () => beginContainerMaintenance(['app-searxng-redis'], options),
      /maintenance already active/,
    );
    lease.markRollback('test rollback');
    assert.equal(isContainerMaintenanceActive('app-searxng-main', options), true);
    lease.release();
    lease.release();
    assert.equal(isContainerMaintenanceActive('app-searxng-main', options), false);

    const history = await readdir(join(directory, 'operations'));
    const record = JSON.parse(await readFile(join(directory, 'operations', history[0]), 'utf8'));
    assert.equal(record.state, 'completed');
    assert.equal(record.operation, 'test-update');

    await assert.rejects(
      withContainerMaintenance(['app-searxng-main'], async () => {
        assert.equal(isContainerMaintenanceActive('app-searxng-main', options), true);
        throw new Error('update failed');
      }, options),
      /update failed/,
    );
    assert.equal(isContainerMaintenanceActive('app-searxng-main', options), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OCI rollback captures a pullable source and builds the Incus rebuild request', () => {
  assert.equal(
    resolveOCIImageReference(
      'searxng/searxng:2026.3.29-7ac4ff39f',
      'docker.io/searxng/searxng (OCI)',
    ),
    'docker.io/searxng/searxng:2026.3.29-7ac4ff39f',
  );
  assert.equal(
    resolveOCIImageReference('ghcr.io/acme/app:v1', 'ghcr.io/acme/app (OCI)'),
    'ghcr.io/acme/app:v1',
  );
  assert.equal(resolveOCIImageReference('', 'docker.io/acme/app (OCI)'), null);
  assert.equal(resolveOCIImageReference('acme/app:v1', 'not an OCI image'), null);

  assert.deepEqual(
    buildOCIRebuildRequest('docker.io/valkey/valkey:8-alpine'),
    {
      source: {
        type: 'image',
        mode: 'pull',
        server: 'https://docker.io',
        protocol: 'oci',
        alias: 'valkey/valkey:8-alpine',
      },
    },
  );
});

test('OCI rollback uses an independent instance copy that can be renamed over the failed canonical instance', () => {
  assert.deepEqual(
    buildRollbackCopyRequest('app-searxng-main', 'ye-rollback-0123456789ab-0'),
    {
      name: 'ye-rollback-0123456789ab-0',
      instance_only: true,
      source: { type: 'copy', source: 'app-searxng-main' },
    },
  );
  assert.deepEqual(buildRollbackRenameRequest('app-searxng-main'), { name: 'app-searxng-main' });
});

test('Market OCI update retains rollback instance through health and metadata commit', async () => {
  const updater = await readFile(join(process.cwd(), 'src/lib/market/updater.ts'), 'utf8');
  const backup = updater.indexOf('await createRollbackInstanceBackup(name, backupName)');
  const rebuild = updater.indexOf('await rebuildContainer(name, spec.image)');
  const health = updater.indexOf('await waitForAppHealth', rebuild);
  const metadata = updater.indexOf('await saveInstallMetadata(installMeta)', rebuild);
  const cleanup = updater.indexOf('await deleteInstance(backup)', metadata);
  const restore = updater.indexOf('await restoreRollbackInstanceBackup(name, backup)');

  assert.ok(backup >= 0 && rebuild > backup);
  assert.ok(health > rebuild);
  assert.ok(metadata > rebuild);
  assert.ok(cleanup > metadata);
  assert.ok(restore > rebuild);
  assert.doesNotMatch(updater.slice(rebuild - 200, rebuild), /deleteSnapshot/);
  assert.match(updater, /maintenance\.markRollback\(errMsg\)/);
  assert.match(updater, /maintenance\.markFailed/);
});

test('rollback recovery restores every previously running container and reports failures', async () => {
  const states = new Map([
    ['app-searxng-main', 'Stopped'],
    ['app-searxng-redis', 'Stopped'],
    ['app-disabled', 'Stopped'],
  ]);
  const starts: string[] = [];
  const failures = await recoverOriginallyRunningContainers(
    new Map([
      ['app-searxng-main', 'Running'],
      ['app-searxng-redis', 'Running'],
      ['app-disabled', 'Stopped'],
    ]),
    {
      state: async (name) => states.get(name) ?? 'Unknown',
      start: async (name) => {
        starts.push(name);
        if (name === 'app-searxng-redis') throw new Error('start rejected');
        states.set(name, 'Running');
      },
      waitForRunning: async (name) => {
        if (states.get(name) !== 'Running') throw new Error('not running');
      },
    },
  );

  assert.deepEqual(starts, ['app-searxng-main', 'app-searxng-redis']);
  assert.deepEqual(failures, ['app-searxng-redis: start rejected']);
});

test('update progress is visible only to authenticated administrators', () => {
  assert.deepEqual(checkUpdateStatusAccess(null), {
    allowed: false,
    status: 401,
    error: 'Unauthorized',
  });
  assert.deepEqual(checkUpdateStatusAccess({ isAdmin: false }), {
    allowed: false,
    status: 403,
    error: 'Admin access required',
  });
  assert.deepEqual(checkUpdateStatusAccess({ isAdmin: true }), { allowed: true });
});
