export interface SetupRestoreStatus {
  status: 'running' | 'completed' | 'failed';
  message: string;
  operationId?: string;
  active?: boolean;
  recovery?: 'none' | 'resume' | 'finalize' | 'operator-required';
  mediaId?: string;
  backupId?: string;
  appIds?: string[];
  messageCode?: string;
}

export interface SetupRestoreSelection { mediaId: string; backupId: string; appIds: string[] }

/** Only an inactive, explicitly recoverable receipt can populate a resume.
 * Foreign or malformed receipts never enable replay.
 */
export function recoverableRestoreSelection(status: SetupRestoreStatus, operationId: string): SetupRestoreSelection | null {
  if (status.operationId !== operationId || status.status !== 'failed' || status.active !== false
    || !['resume', 'finalize'].includes(status.recovery ?? '')
    || typeof status.mediaId !== 'string' || !status.mediaId || status.mediaId.length > 256
    || typeof status.backupId !== 'string' || !/^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(status.backupId)
    || !Array.isArray(status.appIds) || status.appIds.length > 1000
    || status.appIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
    || new Set(status.appIds).size !== status.appIds.length) return null;
  return { mediaId: status.mediaId, backupId: status.backupId, appIds: [...status.appIds] };
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
    if (!response.ok) return null;
    const status = await response.json();
    return status?.operationId === operationId ? status : null;
  });
  const pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 2000)));
  const attempts = options.attempts ?? 900;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let value: SetupRestoreStatus | null = null;
    try { value = await read(); } catch { /* Routing can temporarily disconnect. */ }
    if (value?.operationId === operationId && ['completed', 'failed'].includes(value.status)
      && typeof value.message === 'string') return value;
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error('Restore status is unavailable. Check its status before starting another restore.');
}
