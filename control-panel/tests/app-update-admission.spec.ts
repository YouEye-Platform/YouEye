import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AppUpdateJournalStore, updateResourceKey, type NewAppUpdate, type UpdateResource,
} from '../src/lib/market/update-journal';
import {
  AppLifecycleAdmissionError, assertRecoveryCopyAdmission, withAppInventory, withAppLifecycle, withContainerLifecycle,
} from '../src/lib/market/update-admission';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';
import { isContainerMaintenanceActive } from '../src/lib/maintenance/container-maintenance';

const hash = 'a'.repeat(64);
const resources: UpdateResource[] = [
  { kind: 'app', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: false },
  { kind: 'container', scope: 'incus', name: 'app-fixture', ownerAppId: 'fixture', mutable: true },
  { kind: 'volume', scope: 'default', name: 'ye-fixture-data', ownerAppId: 'fixture', mutable: true },
];
const input: NewAppUpdate = {
  appId: 'fixture', source: { manifestSHA256: hash, artifactSHA256: [] },
  target: { manifestSHA256: hash, artifactSHA256: [] },
  resources, originalRunning: { 'app-fixture': false }, metadataBeforeSHA256: hash,
};
const admissionModule = path.resolve('src/lib/market/update-admission.ts');
const journalModule = path.resolve('src/lib/market/update-journal.ts');

async function temporary(work: (directory: string, store: AppUpdateJournalStore) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-admission-'));
  const directory = path.join(root, 'journal');
  try { await work(directory, new AppUpdateJournalStore(directory)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function child(code: string, directory: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', code, directory], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

test('lifecycle and updater share an OS app lock across awaits and separate processes', () =>
  temporary(async (directory, store) => {
    await withAppLifecycle('fixture', async () => {
      await Promise.resolve();
      child(`
        const { withAppLifecycle } = require(${JSON.stringify(admissionModule)});
        const { AppUpdateJournalStore } = require(${JSON.stringify(journalModule)});
        withAppLifecycle('fixture', () => { throw new Error('must not enter'); },
          { store: new AppUpdateJournalStore(process.argv[1]) })
          .then(() => process.exit(1), error => {
            if (!error.message.includes('lock is busy')) { console.error(error); process.exit(2); }
          });
      `, directory);
      // The updater reserves resources while retaining exactly the same app lock.
      const lease = store.create(input);
      try { assert.equal(store.isReserved(resources[0]), true); }
      finally { lease.release(); }
    }, { store });
    let entered = false;
    await assert.rejects(withAppLifecycle('fixture', () => { entered = true; }, { store }),
      AppLifecycleAdmissionError);
    assert.equal(entered, false);
  }));

test('nested restore/uninstall/storage work reuses admission, and ordinary failure releases OS lock', () =>
  temporary(async (_directory, store) => {
    await assert.rejects(withAppLifecycle('fixture', async () => {
      await withAppLifecycle('fixture', async () => {
        await Promise.resolve();
        await withAppLifecycle('fixture', () => undefined, { store });
      }, { store });
      throw new Error('ordinary operation failed');
    }, { store }), /ordinary operation failed/);
    await withAppLifecycle('fixture', () => undefined, { store });
    await withAppLifecycle('other', () => undefined, { store });
  }));

test('dead updater retains recovery_required evidence and watchdog exclusion without reservation directories', () =>
  temporary(async (directory, store) => {
    child(`
      const { withAppLifecycle } = require(${JSON.stringify(admissionModule)});
      const { AppUpdateJournalStore } = require(${JSON.stringify(journalModule)});
      const store = new AppUpdateJournalStore(process.argv[1]);
      withAppLifecycle('fixture', () => {
        const lease = store.create(${JSON.stringify(input)});
        lease.recoveryRequired('migration-interrupted');
        process.exit(0);
      }, { store }).catch(error => { console.error(error); process.exit(1); });
    `, directory);
    const record = store.list()[0];
    const evidence = readFileSync(path.join(directory, 'operations', `${record.id}.json`), 'utf8');
    // Missing locks must not turn durable unfinished intent into permission.
    for (const resource of resources) {
      rmSync(path.join(directory, 'locks', updateResourceKey(resource)), { recursive: true });
    }
    const options = { stateDirectory: path.join(path.dirname(directory), 'maintenance'), updateJournalDirectory: directory };
    assert.equal(isContainerMaintenanceActive('app-fixture', options), true);
    assert.equal(isContainerMaintenanceActive('app-other', options), false);
    await assert.rejects(withAppLifecycle('fixture', () => assert.fail('mutation entered'), { store }),
      AppLifecycleAdmissionError);
    assert.equal(readFileSync(path.join(directory, 'operations', `${record.id}.json`), 'utf8'), evidence);
  }));

test('orphan container reservations and orphan maintenance locks suppress watchdog restart', () =>
  temporary(async (directory) => {
    const maintenance = path.join(path.dirname(directory), 'maintenance');
    const options = { stateDirectory: maintenance, updateJournalDirectory: directory };
    mkdirSync(path.join(directory, 'locks', updateResourceKey(resources[1])), { mode: 0o700 });
    assert.equal(isContainerMaintenanceActive('app-fixture', options), true);
    mkdirSync(path.join(maintenance, 'locks', 'app-other.lock'), { recursive: true, mode: 0o700 });
    assert.equal(isContainerMaintenanceActive('app-other', options), true);
  }));

test('explicit recovery uses the same app lock and preserves receipt until reconciliation', () =>
  temporary(async (_directory, store) => {
    const lease = store.create(input);
    lease.recoveryRequired('migration-failed');
    const id = lease.snapshot().id;
    lease.release();
    await assert.rejects(withAppLifecycle('other', () => assert.fail('wrong app recovered'),
      { store, recoveryOperationId: id }), AppLifecycleAdmissionError);
    await withAppLifecycle('fixture', async () => {
      const recovered = store.recover(id);
      try {
        recovered.assertActive();
        assert.equal(recovered.snapshot().phase, 'recovery_required');
        await withAppLifecycle('fixture', () => undefined, { store });
      } finally { recovered.release(); }
    }, { store, recoveryOperationId: id });
    await assert.rejects(withAppLifecycle('fixture', () => assert.fail('unfinished recovery ignored'), { store }),
      AppLifecycleAdmissionError);
  }));

test('exact volume reservation rejects a different app storage mutation', () =>
  temporary(async (_directory, store) => {
    const lease = store.create(input);
    lease.release();
    await assert.rejects(withAppLifecycle('other', () => assert.fail('reserved volume mutated'),
      { store, resources: [resources[2]] }), AppLifecycleAdmissionError);
    await withAppLifecycle('other', async () => {
      await assert.rejects(withAppLifecycle('other', () => assert.fail('nested reserved volume mutated'),
        { store, resources: [resources[2]] }), AppLifecycleAdmissionError);
    }, { store });
  }));

test('corrupt journal blocks both lifecycle mutations and watchdog restart', () =>
  temporary(async (directory, store) => {
    writeFileSync(path.join(directory, 'operations', 'corrupt.json'), '{}', { mode: 0o600 });
    await assert.rejects(withAppLifecycle('fixture', () => assert.fail('corrupt store admitted'), { store }),
      AppLifecycleAdmissionError);
    assert.equal(isContainerMaintenanceActive('app-fixture', {
      stateDirectory: path.join(path.dirname(directory), 'maintenance'), updateJournalDirectory: directory,
    }), true);
  }));

test('container state actions refuse exact reservations before resolving missing app metadata', () =>
  temporary(async (_directory, store) => {
    const lease = store.create(input);
    lease.release();
    await assert.rejects(withContainerLifecycle('app-fixture', () => assert.fail('container action entered'), { store }),
      AppLifecycleAdmissionError);
  }));

test('destructive lifecycle entry points refuse recovery_required without changing evidence', () =>
  temporary(async (directory, store) => {
    const lease = store.create(input);
    lease.recoveryRequired('migration-failed');
    lease.release();
    const id = lease.snapshot().id;
    const evidence = readFileSync(path.join(directory, 'operations', `${id}.json`), 'utf8');
    child(`
      const assert = require('node:assert/strict');
      process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = process.argv[1];
      process.env.YOUEYE_INSTALLED_APPS_PATH = process.argv[1] + '/installed.json';
      const { uninstallApp } = require(${JSON.stringify(path.resolve('src/lib/market/uninstaller.ts'))});
      const { restoreApp } = require(${JSON.stringify(path.resolve('src/lib/backup/app-restore.ts'))});
      const { backupApp } = require(${JSON.stringify(path.resolve('src/lib/backup/app-backup.ts'))});
      const { cleanupAppByScan } = require(${JSON.stringify(path.resolve('src/lib/market/reconciler.ts'))});
      const { createBridge } = require(${JSON.stringify(path.resolve('src/lib/bridges/manager.ts'))});
      const { probeInstalledApp } = require(${JSON.stringify(path.resolve('src/lib/market/app-prober.ts'))});
      const { controlInstalledApp } = require(${JSON.stringify(path.resolve('src/lib/apps/lifecycle.ts'))});
      const { deleteAppStorage, ensureAppStorage, deleteCreatedRecoveryStorage } = require(${JSON.stringify(path.resolve('src/lib/market/storage.ts'))});
      const { generateAppToken } = require(${JSON.stringify(path.resolve('src/lib/market/platform-env.ts'))});
      const { enableManagedAI, disableManagedAI, changeManagedAIGroup, takeOverManagedAI } = require(${JSON.stringify(path.resolve('src/lib/market/managed-ai.ts'))});
      const { AppLifecycleAdmissionError } = require(${JSON.stringify(admissionModule)});
      (async () => {
        const actions = [
          () => uninstallApp('fixture', { keepData: false, dropSharedDatabase: true }),
          () => restoreApp({ appId: 'fixture', archivePath: '/unused', passphrase: 'unused' }, () => assert.fail('restore event emitted')),
          () => backupApp({ appId: 'fixture' }, () => assert.fail('backup event emitted')),
          () => cleanupAppByScan('fixture', { keepData: false, dropDatabase: true }),
          () => createBridge({ from: 'fixture', to: 'other', envMappings: [], approvedBy: 'admin' }),
          () => controlInstalledApp('fixture', 'start', 'admin'),
          () => controlInstalledApp('fixture', 'restart', 'admin'),
          () => controlInstalledApp('fixture', 'stop', 'admin'),
          () => deleteAppStorage([{ appId: 'fixture', pool: 'default', name: 'ye-fixture-data' }]),
          () => ensureAppStorage({ metadata: { id: 'fixture' } }, {}),
          () => deleteCreatedRecoveryStorage('fixture', [{ pool: 'default', name: 'ye-fixture-data' }]),
          () => generateAppToken('fixture'),
          () => enableManagedAI('fixture', {}, 'group'),
          () => disableManagedAI('fixture', {}),
          () => changeManagedAIGroup('fixture', {}, 'group'),
          () => takeOverManagedAI('fixture', {}, 'group'),
        ];
        for (const action of actions) await assert.rejects(action(), AppLifecycleAdmissionError);
        const probe = await probeInstalledApp('fixture');
        assert.equal(probe.state, 'maintenance');
        assert.match(probe.detail, /recovery is pending/);
      })().catch(error => { console.error(error); process.exit(1); });
    `, directory);
    assert.equal(readFileSync(path.join(directory, 'operations', `${id}.json`), 'utf8'), evidence);
    assert.equal(store.isReserved(resources[0]), true);
    assert.equal(store.isReserved(resources[2]), true);
  }));

test('operation-marked checkpoint copies cannot be powered or deleted before terminal cleanup', () =>
  temporary(async (_directory, store) => {
    const lease = store.create(input);
    const config = {
      'user.youeye.update_operation': lease.snapshot().id,
      'user.youeye.update_source': 'app-fixture',
      'boot.autostart': 'false',
    };
    const name = `ye-rollback-${lease.snapshot().id.replaceAll('-', '').slice(0, 12)}-0`;
    assert.throws(() => assertRecoveryCopyAdmission(name, config, store), AppLifecycleAdmissionError);
    assert.throws(() => assertRecoveryCopyAdmission(name, {}, store), AppLifecycleAdmissionError);
    lease.recoveryRequired('migration-failed');
    assert.throws(() => assertRecoveryCopyAdmission('temporary-copy', config, store), AppLifecycleAdmissionError);
    lease.transition('recovering');
    lease.rolledBack();
    lease.transition('cleanup');
    // Verified rollback still retains exclusion until cleanup releases evidence.
    assert.throws(() => assertRecoveryCopyAdmission(name, config, store), AppLifecycleAdmissionError);
    lease.finishCleanup();
    assert.doesNotThrow(() => assertRecoveryCopyAdmission(name, config, store));
    assert.throws(() => assertRecoveryCopyAdmission(name, {
      ...config, 'user.youeye.update_source': 'unrelated',
    }, store), AppLifecycleAdmissionError);
    assert.throws(() => assertRecoveryCopyAdmission(name, {
      ...config, 'user.youeye.update_operation': '00000000-0000-4000-8000-000000000000',
    }, store), AppLifecycleAdmissionError);
  }));


test('global inventory capture excludes a different new app across processes and releases after failure', () =>
  temporary(async (directory, store) => {
    await assert.rejects(withAppInventory(async () => {
      await withAppInventory(() => withAppLifecycle('existing-app', () => undefined, { store }), { store });
      await Promise.resolve();
      child(`
        const { withAppInventory, withAppLifecycle } = require(${JSON.stringify(admissionModule)});
        const { AppUpdateJournalStore } = require(${JSON.stringify(journalModule)});
        const options = { store: new AppUpdateJournalStore(process.argv[1]) };
        withAppInventory(() => withAppLifecycle('new-app', () => {
          throw new Error('new installation entered a frozen inventory');
        }, options), options).then(() => process.exit(1), error => {
          if (!error.message.includes('lock is busy')) { console.error(error); process.exit(2); }
        });
      `, directory);
      throw new Error('backup failed');
    }, { store }), /backup failed/);
    child(`
      const { withAppInventory, withAppLifecycle } = require(${JSON.stringify(admissionModule)});
      const { AppUpdateJournalStore } = require(${JSON.stringify(journalModule)});
      const options = { store: new AppUpdateJournalStore(process.argv[1]) };
      let entered = false;
      withAppInventory(() => withAppLifecycle('new-app', () => { entered = true; }, options), options)
        .then(() => { if (!entered) process.exit(1); }, error => { console.error(error); process.exit(2); });
    `, directory);
  }));


test('core activation drains shared lifecycle work and a durable reservation survives lock release', () =>
  temporary(async (directory, store) => {
    const file = path.join(directory, 'core-lifecycle.flock');
    await withAppLifecycle('fixture', async () => {
      assert.throws(() => AppUpdateExecutorLock.acquire(file), /busy/);
      await withAppLifecycle('another-app', () => undefined, { store });
    }, { store });
    const coordinator = AppUpdateExecutorLock.acquire(file);
    try {
      await assert.rejects(withAppLifecycle('fixture', () => assert.fail('entered during checkpoint'), { store }), /busy/);
      writeFileSync(path.join(directory, 'core-reservation.json'), JSON.stringify({
        schema: 'youeye.core-lifecycle.v1', request_id: 'fixture-core', manifest_sha256: hash,
      }), { mode: 0o600 });
    } finally { coordinator.release(); }
    await assert.rejects(withAppLifecycle('fixture', () => assert.fail('entered reserved lifecycle'), { store }), /System update owns/);
    await assert.rejects(withAppInventory(() => assert.fail('captured reserved inventory'), { store }), /System update owns/);
    await assert.rejects(withContainerLifecycle('youeye-control', () => assert.fail('changed reserved system container'), { store }), /System update owns/);
    child(`
      const { withAppLifecycle } = require(${JSON.stringify(admissionModule)});
      const { AppUpdateJournalStore } = require(${JSON.stringify(journalModule)});
      withAppLifecycle('fixture', () => { throw new Error('must not enter'); },
        { store: new AppUpdateJournalStore(process.argv[1]) })
        .then(() => process.exit(1), error => {
          if (!error.message.includes('System update owns')) { console.error(error); process.exit(2); }
        });
    `, directory);
  }));
