export interface SetupRestoreStatus {
  status: 'running' | 'completed' | 'failed';
  message: string;
}

/** A lost progress connection never authorizes another restore submission. */
export async function waitForSetupRestoreStatus(operationId: string, options: {
  read?: () => Promise<SetupRestoreStatus | null>;
  pause?: () => Promise<void>;
  attempts?: number;
} = {}): Promise<SetupRestoreStatus> {
  const read = options.read ?? (async () => {
    const response = await fetch(`/api/setup/restore?operationId=${encodeURIComponent(operationId)}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    return response.ok ? response.json() : null;
  });
  const pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 2000)));
  for (let attempt = 0; attempt < (options.attempts ?? 900); attempt++) {
    let value: SetupRestoreStatus | null = null;
    try { value = await read(); } catch { /* Routing can temporarily disconnect. */ }
    if (value && ['completed', 'failed'].includes(value.status) && typeof value.message === 'string') return value;
    await pause();
  }
  throw new Error('Restore status is unavailable. Check its status before starting another restore.');
}
