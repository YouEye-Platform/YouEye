import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AppUpdateExecutorLock, withAppUpdateExecutorLock,
} from '../src/lib/market/update-executor-lock';

const modulePath = path.resolve('src/lib/market/update-executor-lock.ts');

test('the parent retains the OS lock after flock exits; two processes contend on a stable inode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-executor-'));
  const file = path.join(directory, 'executor.lock');
  const lock = AppUpdateExecutorLock.acquire(file);
  try {
    const inode = lstatSync(file).ino;
    const source = `
      const { AppUpdateExecutorLock } = require(${JSON.stringify(modulePath)});
      try { AppUpdateExecutorLock.acquire(process.argv[1]); process.exit(1); }
      catch (error) { process.exit(error.message.includes('busy') ? 0 : 2); }
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', source, file], { timeout: 5000 });
    assert.equal(child.status, 0, child.stderr.toString());
    lock.release();
    const successor = AppUpdateExecutorLock.acquire(file);
    successor.release();
    assert.equal(lstatSync(file).ino, inode);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.throws(() => lock.assertHeld(), /released/);
  } finally {
    lock.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGKILL releases a real process lock without a surviving keeper or expiry', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-executor-'));
  const file = path.join(directory, 'executor.lock');
  const source = `
    const { AppUpdateExecutorLock } = require(${JSON.stringify(modulePath)});
    const lock = AppUpdateExecutorLock.acquire(process.argv[1]);
    process.stdout.write('ready\\n');
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', source, file]);
  t.after(() => { child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  const output = await Promise.race([
    once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Lock owner exited before readiness'); }),
  ]);
  assert.match(String(output[0]), /ready/);
  const inode = lstatSync(file).ino;
  assert.throws(() => AppUpdateExecutorLock.acquire(file), /busy/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  const successor = AppUpdateExecutorLock.acquire(file);
  try { assert.equal(lstatSync(file).ino, inode); } finally { successor.release(); }
});

test('async callbacks retain exclusion until success or rejection and sync exceptions release', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-executor-'));
  const file = path.join(directory, 'executor.lock');
  try {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const pending = withAppUpdateExecutorLock(file, async () => { await wait; return 42; });
    assert.throws(() => AppUpdateExecutorLock.acquire(file), /busy/);
    finish();
    assert.equal(await pending, 42);
    await assert.rejects(withAppUpdateExecutorLock(file, async () => { throw new Error('callback-failed'); }), /callback-failed/);
    assert.throws(() => withAppUpdateExecutorLock(file, () => { throw new Error('sync-failed'); }), /sync-failed/);
    AppUpdateExecutorLock.acquire(file).release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('symlinks, hard links, public files, FIFO files and replacement inodes fail closed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-executor-'));
  const file = path.join(directory, 'executor.lock');
  try {
    writeFileSync(file, '', { mode: 0o600 });
    const alias = path.join(directory, 'alias');
    symlinkSync(file, alias);
    assert.throws(() => AppUpdateExecutorLock.acquire(alias));
    rmSync(alias);
    linkSync(file, alias);
    assert.throws(() => AppUpdateExecutorLock.acquire(file), /corrupt or insecure/);
    rmSync(alias);
    chmodSync(file, 0o644);
    assert.throws(() => AppUpdateExecutorLock.acquire(file), /corrupt or insecure/);
    chmodSync(file, 0o600);
    const lock = AppUpdateExecutorLock.acquire(file);
    rmSync(file);
    writeFileSync(file, '', { mode: 0o600 });
    try { assert.throws(() => lock.assertHeld(), /corrupt or insecure/); } finally { lock.release(); }
    rmSync(file);
    const fifo = spawnSync('mkfifo', ['-m', '600', file]);
    assert.equal(fifo.status, 0, fifo.stderr.toString());
    assert.throws(() => AppUpdateExecutorLock.acquire(file), /corrupt or insecure/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
