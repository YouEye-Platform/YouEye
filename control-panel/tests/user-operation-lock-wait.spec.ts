import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import {
  AppLifecycleBusyError, AppLifecycleWaitCancelledError, withAppInventory, withAppLifecycle, withUserOperationLockWait,
} from '../src/lib/market/update-admission';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';

async function temporary(work: (directory: string, store: AppUpdateJournalStore) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-lock-wait-'));
  const directory = path.join(root, 'journal');
  const store = new AppUpdateJournalStore(directory);
  try {
    // Create the private journal/executor directories the way real admission does.
    await withAppLifecycle('fixture', () => undefined, { store });
    await withAppInventory(() => undefined, { store });
    await work(directory, store);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A background holder (e.g. the app prober) that releases after `ms`. */
function holdFor(file: string, ms: number): Promise<void> {
  const lock = AppUpdateExecutorLock.acquire(file);
  return new Promise(resolve => setTimeout(() => { lock.release(); resolve(); }, ms));
}

test('a user operation waits for a briefly held app lock and then succeeds', () =>
  temporary(async (directory, store) => {
    const released = holdFor(path.join(directory, 'executors', 'app-fixture.lock'), 1_000);
    const started = Date.now();
    let entered = false;
    await withUserOperationLockWait(() => withAppLifecycle('fixture', () => { entered = true; }, { store }));
    await released;
    assert.equal(entered, true);
    assert.ok(Date.now() - started >= 900, 'the operation must have waited for the holder');
  }));

test('a user uninstall-shaped operation waits for inventory and app locks in turn', () =>
  temporary(async (directory, store) => {
    const inventory = holdFor(path.join(directory, 'executors', 'inventory.lock'), 400);
    const app = holdFor(path.join(directory, 'executors', 'app-fixture.lock'), 900);
    let entered = false;
    await withUserOperationLockWait(() => withAppInventory(() =>
      withAppLifecycle('fixture', () => { entered = true; }, { store }), { store }));
    await Promise.all([inventory, app]);
    assert.equal(entered, true);
  }));

test('a lock held past the bound fails with a clear in-progress error', () =>
  temporary(async (directory, store) => {
    const released = holdFor(path.join(directory, 'executors', 'app-fixture.lock'), 2_000);
    let entered = false;
    await assert.rejects(
      withUserOperationLockWait(() => withAppLifecycle('fixture', () => { entered = true; }, { store }),
        { timeoutMs: 700, pollMs: 50 }),
      (error: unknown) => error instanceof AppLifecycleBusyError
        && /Another operation on this app is in progress; try again in a moment/.test(error.message),
    );
    assert.equal(entered, false);
    await released;
    await withAppLifecycle('fixture', () => undefined, { store });
  }));

test('background callers still fail at once on a busy lock', () =>
  temporary(async (directory, store) => {
    const lock = AppUpdateExecutorLock.acquire(path.join(directory, 'executors', 'app-fixture.lock'));
    try {
      const started = Date.now();
      await assert.rejects(withAppLifecycle('fixture', () => undefined, { store }), /executor lock is busy/);
      assert.ok(Date.now() - started < 500);
    } finally { lock.release(); }
  }));

test('the abort signal stops a lock wait', () =>
  temporary(async (directory, store) => {
    const lock = AppUpdateExecutorLock.acquire(path.join(directory, 'executors', 'app-fixture.lock'));
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      await assert.rejects(
        withUserOperationLockWait(() => withAppLifecycle('fixture', () => undefined, { store }),
          { signal: controller.signal }),
        AppLifecycleWaitCancelledError,
      );
      assert.ok(Date.now() - started < 2_000);
    } finally { lock.release(); }
  }));
