import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithBackupAdmission } from '../src/lib/backup/admission';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';
import { withAppInventory, withAppLifecycles } from '../src/lib/market/update-admission';
const busy = () => new Error('App update executor lock is busy');
const noWait = async () => {};

test('brief lifecycle contention waits before the single app capture starts', async () => {
  let admissions = 0, captures = 0;
  const result = await runWithBackupAdmission(async () => { captures++; return 'archive'; }, async work => {
    if (++admissions < 3) throw busy(); return work();
  }, { pause: noWait });
  assert.equal(result, 'archive'); assert.equal(admissions, 3); assert.equal(captures, 1);
});

test('a started capture that throws the same busy error is never repeated', async () => {
  let admissions = 0, captures = 0;
  await assert.rejects(runWithBackupAdmission(async () => { captures++; throw busy(); }, async work => {
    admissions++; return work();
  }, { pause: noWait }), /lock is busy/);
  assert.equal(admissions, 1); assert.equal(captures, 1);
});

test('reserved, insecure or unavailable admission is not retried', async () => {
  for (const message of ['App resources are reserved by an unfinished update; explicit recovery is required',
    'App update executor lock is corrupt or insecure; recovery must remain blocked',
    'App update executor OS lock unavailable; recovery must remain blocked']) {
    let admissions = 0, captures = 0;
    await assert.rejects(runWithBackupAdmission(async () => { captures++; }, async () => {
      admissions++; throw Error(message);
    }, { pause: noWait }), { message });
    assert.equal(admissions, 1); assert.equal(captures, 0);
  }
});

test('persistent contention reaches a finite bound without starting capture', async () => {
  let admissions = 0, captures = 0;
  await assert.rejects(runWithBackupAdmission(async () => { captures++; }, async () => {
    admissions++; throw busy();
  }, { attempts: 3, pause: noWait }), /lock is busy/);
  assert.equal(admissions, 3); assert.equal(captures, 0);
});

test('core admission retries real inventory and partial multi-app locks before one capture', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-core-admission-'));
  const previous = process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
  process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = directory;
  new AppUpdateJournalStore(directory);
  let held: AppUpdateExecutorLock | undefined;
  try {
    for (const file of ['inventory.lock', 'app-pointer.lock']) {
      held = AppUpdateExecutorLock.acquire(path.join(directory, 'executors', file));
      let captures = 0, waits = 0;
      await runWithBackupAdmission(async () => { captures++; },
        work => withAppInventory(() => withAppLifecycles(['identity', 'pointer'], work)), {
          pause: async () => {
            waits++;
            // A failed later gate must release earlier inventory/app locks.
            if (file === 'app-pointer.lock') {
              const inventory = AppUpdateExecutorLock.acquire(path.join(directory, 'executors', 'inventory.lock'));
              const identity = AppUpdateExecutorLock.acquire(path.join(directory, 'executors', 'app-identity.lock'));
              identity.release(); inventory.release();
            }
            held!.release(); held = undefined;
          },
        });
      assert.equal(waits, 1); assert.equal(captures, 1);
    }
  } finally {
    held?.release();
    if (previous === undefined) delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
    else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
