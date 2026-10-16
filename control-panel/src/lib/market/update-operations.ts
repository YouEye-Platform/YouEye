import { PointerReleaseMetadataProvider } from '../pointer/release-metadata';
import { appUpdateJournalStore, withAppLifecycle } from './update-admission';
import { AppUpdateTransaction } from './update-transaction';
import type { AppUpdateRecord } from './update-journal';
import { IncusAppUpdateProvider } from './update-provider';
import { ReleaseMetadataUpdateProvider } from './update-release-metadata';
import { observeIssue, resolveIssue } from '@/lib/health/issues';

/** Authenticated routes expose this bounded payload-free status, never checkpoint handles. */
export function getAppUpdateOperation(appId: string) {
  const record = appUpdateJournalStore().list().filter(r => r.appId === appId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!record) return null;
  return {
    id: record.id, appId: record.appId, phase: record.phase, updatedAt: record.updatedAt,
    committed: !!record.commit, rolledBack: !!record.rollbackVerifiedAt,
    cleanupComplete: record.cleanupComplete, recoveryRequired: record.phase === 'recovery_required',
    pending: !record.cleanupComplete, errorCode: record.errorCode,
  };
}

export async function recoverAppUpdateOperation(appId: string, operationId: string): Promise<void> {
  const store = appUpdateJournalStore();
  const record = store.read(operationId);
  if (record.appId !== appId) throw new Error('Update operation does not belong to this app');
  if (record.cleanupComplete) {
    // Cleanup may have finished in another executor before this process could
    // acknowledge its health issue. Never clear a newer unfinished operation.
    const records = store.list().filter(r => r.appId === appId);
    const latest = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (latest?.id !== operationId || records.some(r => !r.cleanupComplete)
      || (!record.commit && !record.rollbackVerifiedAt)) {
      throw new Error('Application recovery is not verified complete');
    }
    await resolveIssue(`app.${appId}.update-recovery`);
    return;
  }
  await withAppLifecycle(appId, async () => {
    await store.withExecutor(operationId, async lease => {
      const provider = record.operationKind === 'release-metadata'
        ? new ReleaseMetadataUpdateProvider(store.directory) : record.operationKind === 'pointer-release-metadata'
          ? new PointerReleaseMetadataProvider(store.directory) : new IncusAppUpdateProvider();
      await new AppUpdateTransaction(lease, provider).recover();
    });
    await resolveIssue(`app.${appId}.update-recovery`);
  }, { store, recoveryOperationId: operationId });
}

/** Await before watchdogs/queues start; unfinished receipts remain exclusion evidence. */
export async function reconcileAppUpdateOperations(): Promise<void> {
  const records = appUpdateJournalStore().list();
  for (const record of records.filter(r => !r.cleanupComplete)) {
    try {
      await recoverAppUpdateOperation(record.appId, record.id);
    } catch {
      await observeIssue({
        id: `app.${record.appId}.update-recovery`, severity: 'critical', source: 'market-updater',
        title: `${record.appId} update recovery requires attention`,
        body: 'An interrupted application update could not be verified. Maintenance remains active and its recovery points are retained. Retry recovery from Market.',
        fixable: false, debounce: 1,
      });
    }
  }
  const latest = new Map<string, AppUpdateRecord>();
  for (const record of records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(record.appId, record);
  }
  for (const record of latest.values()) {
    if (record.cleanupComplete && (record.commit || record.rollbackVerifiedAt)) {
      await recoverAppUpdateOperation(record.appId, record.id);
    }
  }
}
