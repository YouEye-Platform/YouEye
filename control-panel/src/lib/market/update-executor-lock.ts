import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function insecure(): never {
  throw new Error('App update executor lock is corrupt or insecure; recovery must remain blocked');
}

/**
 * Linux flock locks the open file description, shared with inherited fd 3.
 * The short-lived util-linux helper takes the lock; THIS process keeps it by
 * retaining its descriptor. No keeper process, PID checks or expiry are needed.
 *
 * Never unlink/replace these files, including after cleanup: contenders must
 * always open the same inode. This requires a local filesystem supporting flock
 * and /usr/bin/flock (already part of the appliance), and fails closed otherwise.
 */
export class AppUpdateExecutorLock {
  private constructor(private readonly file: string, private fd: number | undefined) {}

  static acquire(file: string, mode: 'shared' | 'exclusive' = 'exclusive'): AppUpdateExecutorLock {
    const directory = lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.uid !== process.geteuid?.()
      || (directory.mode & 0o777) !== 0o700) insecure();
    const fd = openSync(file,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const lock = new AppUpdateExecutorLock(file, fd);
    try {
      lock.assertHeld();
      const result = spawnSync('/usr/bin/flock', [mode === 'shared' ? '--shared' : '--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000, maxBuffer: 4096,
      });
      if (result.error || result.signal || (result.status !== 0 && result.status !== 75)) {
        throw new Error('App update executor OS lock unavailable; recovery must remain blocked');
      }
      if (result.status === 75) throw new Error('App update executor lock is busy');
      lock.assertHeld();
      fsyncSync(fd);
      const parent = openSync(path.dirname(file),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      return lock;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  /** Use immediately before an external effect, especially after an await. */
  assertHeld(): void {
    if (this.fd === undefined) throw new Error('App update executor lease is released');
    const stat = fstatSync(this.fd);
    const current = lstatSync(this.file);
    if (!stat.isFile() || stat.uid !== process.geteuid?.()
      || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size !== 0
      || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) insecure();
  }

  release(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

/** Retain the descriptor for the full callback, including asynchronous work. */
export function withAppUpdateExecutorLock<T>(file: string, work: () => T): T {
  const lock = AppUpdateExecutorLock.acquire(file);
  try {
    const result = work();
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return Promise.resolve(result).finally(() => lock.release()) as T;
    }
    lock.release();
    return result;
  } catch (error) {
    lock.release();
    throw error;
  }
}
