import { startContainer, waitForRunning, waitForOperation } from '@/lib/incus/snapshot';
import { lstat, readdir } from 'node:fs/promises';
import { incusRequest, execCommand } from '@/lib/incus/server';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { withAppLifecycle } from '@/lib/market/update-admission';
import { runPairedPointerBackup } from './paired-backup-operation';
import { platformDatabaseExists } from '@/lib/backup/postgres';
import { POINTER_STORAGE } from './storage';
import { waitForPointer } from './lifecycle';

async function pointerBackupState(): Promise<string> {
  const response = await incusRequest<{status: string}>('GET', '/1.0/instances/youeye-pointer/state');
  if (!response.error && response.metadata?.status) return response.metadata.status;
  if (response.error_code !== 404 || await platformDatabaseExists('pointer')) return 'Unknown';
  try {
    const root = await lstat(POINTER_STORAGE);
    if (!root.isDirectory() || root.isSymbolicLink() || (await readdir(POINTER_STORAGE)).length) return 'Unknown';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return 'Absent';
}

/** Hold the engine stopped from SQL dump through encrypted file capture. */
export async function withPairedPointerBackup<T>(work: () => Promise<T>): Promise<T> {
  return withAppLifecycle('pointer', async () => {
    let firstObservation = true;
    let serviceWasActive = false;
    return runPairedPointerBackup(work, {
    state: async () => {
      const state = await pointerBackupState();
      if (firstObservation && state === 'Running') {
        const service = await execCommand('youeye-pointer', ['/usr/bin/systemctl', 'is-active', 'youeye-pointer.service'], { timeout: 10_000 });
        serviceWasActive = service.exitCode === 0;
      }
      firstObservation = false;
      return state;
    },
    stop: async () => {
      // Graceful shutdown drains Pointer's SQL writes before engine capture.
      const response = await incusRequest('PUT', '/1.0/instances/youeye-pointer/state', { action: 'stop', force: false, timeout: 60 });
      if (response.type === 'async' && response.operation) await waitForOperation(response.operation, 90);
    },
    start: () => startContainer('youeye-pointer'),
    waitRunning: async () => {
      await waitForRunning('youeye-pointer');
      if (serviceWasActive && !await waitForPointer()) throw new Error('Pointer readiness after backup failed');
    },
    maintenance: () => beginContainerMaintenance(['youeye-pointer'], { operation: 'pointer-paired-backup' }),
    });
  });
}
