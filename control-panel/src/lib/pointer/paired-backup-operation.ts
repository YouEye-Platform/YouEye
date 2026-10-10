export interface PointerBackupRuntime {
  state(): Promise<string>;
  stop(): Promise<void>;
  start(): Promise<void>;
  waitRunning(): Promise<void>;
  maintenance(): { markFailed(error: string): void; release(): void };
}

/** Keep writers stopped across both captures; failed restart retains maintenance. */
export async function runPairedPointerBackup<T>(work: () => Promise<T>, runtime: PointerBackupRuntime): Promise<T> {
  const original = await runtime.state();
  // Supplied only after proving there is no Pointer database or engine state.
  if (original === 'Absent') return work();
  if (original !== 'Running' && original !== 'Stopped') throw new Error('Pointer backup runtime identity is unavailable');
  const lease = runtime.maintenance();
  try {
    if (original === 'Running') await runtime.stop();
    if (await runtime.state() !== 'Stopped') throw new Error('Pointer backup requires stopped engine writers');
    return await work();
  } finally {
    try {
      const current = await runtime.state();
      if (original === 'Running') {
        if (current === 'Stopped') await runtime.start();
        else if (current !== 'Running') throw new Error('Unknown Pointer runtime');
        await runtime.waitRunning();
      } else if (current !== 'Stopped') throw new Error('Pointer stopped intent changed');
    } catch {
      // release() marks completion, so keep the failed lease for reconciliation.
      lease.markFailed('Pointer restart after paired backup requires reconciliation');
      throw new Error('Pointer restart after paired backup requires reconciliation');
    }
    lease.release();
  }
}
