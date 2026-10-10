export interface OwnedPostgresBackupRuntime {
  state(): Promise<string>;
  start(): Promise<void>;
  ready(): Promise<void>;
  stop(): Promise<void>;
  maintenance(): { markFailed(error: string): void; release(): void };
}

/** Temporarily open a stopped database for its logical dump, preserving intent. */
export async function runOwnedPostgresBackup<T>(
  work: () => Promise<T>, runtime: OwnedPostgresBackupRuntime,
): Promise<T> {
  const original = await runtime.state();
  if (original === 'Running') return work();
  if (original !== 'Stopped') throw new Error('Application database backup runtime identity is unavailable');
  const lease = runtime.maintenance();
  let attemptedStart = false;
  try {
    if (await runtime.state() !== 'Stopped') throw new Error('Application database stopped intent changed');
    attemptedStart = true;
    await runtime.start();
    if (await runtime.state() !== 'Running') throw new Error('Application database did not start for backup');
    await runtime.ready();
    return await work();
  } finally {
    try {
      const current = await runtime.state();
      if (attemptedStart && current === 'Running') await runtime.stop();
      else if (current !== 'Stopped') throw new Error('Application database stopped intent changed');
      if (await runtime.state() !== 'Stopped') throw new Error('Application database did not stop after backup');
    } catch {
      lease.markFailed('Application database stopped intent after backup requires reconciliation');
      throw new Error('Application database stopped intent after backup requires reconciliation');
    }
    lease.release();
  }
}
