import { logOperationFailure } from './install-tracker';
import { PointerReleaseMetadataProvider } from '../pointer/release-metadata';
import { appUpdateJournalStore, withAppLifecycle } from './update-admission';
import { AppUpdateTransaction } from './update-transaction';
import type { AppUpdateRecord } from './update-journal';
import { IncusAppUpdateProvider } from './update-provider';
import { ReleaseMetadataUpdateProvider } from './update-release-metadata';
import { observeIssue, resolveIssue } from '@/lib/health/issues';

/** Authenticated routes expose this bounded payload-free status, never checkpoint handles. */
export function getAppUpdateOperation(appId: string) {
  const record = appUpdateJournalStore().list(appId).filter(r => r.appId === appId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!record) return null;
  return {
    id: record.id, appId: record.appId, phase: record.phase, updatedAt: record.updatedAt,
    committed: !!record.commit, rolledBack: !!record.rollbackVerifiedAt,
    cleanupComplete: record.cleanupComplete, recoveryRequired: record.phase === 'recovery_required',
    pending: !record.cleanupComplete, errorCode: record.errorCode,
    reopened: record.steps.some(s => s.id === 'reopen-compatible-app' && s.state === 'completed'),
  };
}

export async function recoverAppUpdateOperation(appId: string, operationId: string): Promise<void> {
  const store = appUpdateJournalStore();
  const record = store.read(operationId);
  if (record.appId !== appId) throw new Error('Update operation does not belong to this app');
  if (record.cleanupComplete) {
    // Cleanup may have finished in another executor before this process could
    // acknowledge its health issue. Never clear a newer unfinished operation.
    const records = store.list(appId).filter(r => r.appId === appId);
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
  const { records: scanned, damaged } = appUpdateJournalStore().scan();
  for (const { file, appId } of damaged) {
    console.error(`[app-updates] update receipt ${file} can't be read; ${appId ? `${appId} stays blocked` : 'every app stays blocked'}`);
    await observeIssue({
      id: appId ? `app.${appId}.update-recovery` : 'market.update-journal.damaged', severity: 'critical', source: 'market-updater',
      title: appId ? `${appId} update record is damaged` : 'An app update record is damaged',
      body: `/var/lib/youeye/state/app-updates/operations/${file} can't be read (corrupt, or wrong owner or mode). ${appId
        ? `Updates, installs and removal of ${appId} are refused until it is fixed (then \`youeye app recover ${appId}\` or a Control Panel restart closes this); other apps are not affected.`
        : 'It names no app, so every app update and install is refused until it is fixed and the Control Panel restarted.'} Its recovery points are kept.`,
      fixable: false, debounce: 1,
    });
  }
  // A receipt with no app in its name could be any app's: nothing can be recovered safely (as before 0.6.9).
  if (damaged.some(d => !d.appId)) throw new Error('An app update receipt that names no app is damaged');
  await resolveIssue('market.update-journal.damaged');
  const blocked = new Set(damaged.map(d => d.appId));
  const records = scanned.filter(r => !blocked.has(r.appId));
  for (const record of records.filter(r => !r.cleanupComplete)) {
    try {
      await recoverAppUpdateOperation(record.appId, record.id);
    } catch (error) {
      logOperationFailure(`Recovery of the ${record.appId} update ${record.id} at start`, error);
      await observeIssue({
        id: `app.${record.appId}.update-recovery`, severity: 'critical', source: 'market-updater',
        title: `${record.appId} update recovery requires attention`,
        body: 'An interrupted application update could not be verified. Maintenance remains active and its recovery points are retained. Retry recovery from Market.',
        fixable: false, debounce: 1,
      });
    }
  }
  // Operations finished by builds before 0.6.9 left their recovery labels on restored app containers, which blocks
  // every System update's checkpoint. Clear them for finished operations (the provider does it at cleanup now).
  const labelsCleared = new Set<string>();
  for (const record of records.filter(r => r.cleanupComplete)) {
    try {
      const { clearRecoveryLabels } = await import('./update-provider');
      await clearRecoveryLabels(record.id, Object.keys(record.originalRunning));
      labelsCleared.add(record.id);
    } catch (error) {
      logOperationFailure(`Clearing recovery labels of the ${record.appId} update ${record.id}`, error);
    }
  }
  const latest = new Map<string, AppUpdateRecord>();
  for (const record of records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(record.appId, record);
  }
  pruneFinishedOperations(records, latest, labelsCleared);
  for (const record of latest.values()) {
    if (record.cleanupComplete && (record.commit || record.rollbackVerifiedAt)) {
      await recoverAppUpdateOperation(record.appId, record.id);
    }
  }
}

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Finished receipts older than 30 days go, except each app's latest (its update status) and any whose recovery labels
 * could not be cleared (Spine's checkpoint accepts such labels only while the receipt says the operation finished).
 */
export function pruneFinishedOperations(records: AppUpdateRecord[], latest: Map<string, AppUpdateRecord>,
  labelsCleared: Set<string>, now = Date.now()): number {
  const store = appUpdateJournalStore();
  let pruned = 0;
  for (const record of records) {
    if (!record.cleanupComplete || latest.get(record.appId)?.id === record.id || !labelsCleared.has(record.id)
      || now - Date.parse(record.updatedAt) < PRUNE_AFTER_MS) continue;
    try {
      if (store.prune(record.id)) pruned++;
    } catch (error) {
      logOperationFailure(`Pruning the finished ${record.appId} update ${record.id}`, error);
    }
  }
  if (pruned) console.log(`[app-updates] pruned ${pruned} finished update receipts older than 30 days`);
  return pruned;
}
