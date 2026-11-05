/**
 * OCI Container Updater (Infrastructure)
 *
 * Updates OCI containers managed by the Control Panel via the Incus REST API.
 * Uses independent instance backup → rebuild → verify with automatic rollback.
 *
 * For multi-container infrastructure apps, all containers are updated atomically:
 * stop/copy all → rebuild all → restore desired runtime state → verify all.
 *
 * NOTE: This handles INFRASTRUCTURE OCI apps (Caddy, PiHole, Postgres).
 * Market-installed and native app updates go through market/updater.ts which supports
 * both OCI and LXD paths with migrations, variable context, and DB tracking.
 */

import {
  stopContainer,
  startContainer,
  rebuildContainer,
  waitForRunning,
  containerState,
  createRollbackInstanceBackup,
  deleteInstance,
  restoreRollbackInstanceBackup,
} from '@/lib/incus/snapshot';
import { type AppDefinition } from './definitions';
import { markAppUpdated } from './update-cache';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { observeIssue, resolveIssue } from '@/lib/health/issues';

export type UpdateStage =
  | 'starting'
  | 'snapshot'
  | 'stopping'
  | 'rebuilding'
  | 'starting-container'
  | 'verifying'
  | 'rolling-back'
  | 'completed'
  | 'failed';

export interface UpdateEvent {
  stage: UpdateStage;
  message: string;
  container?: string;
  progress?: number; // 0-100
  error?: string;
}

type EventEmitter = (event: UpdateEvent) => void;

/**
 * Update an OCI app by rebuilding its containers with the latest image.
 */
export async function updateOCIApp(
  appDef: AppDefinition,
  emit: EventEmitter
): Promise<void> {
  if (!appDef.imageRef) {
    throw new Error(`App ${appDef.id} has no imageRef`);
  }

  const containers = appDef.containers.map((c) => c.name);
  const totalSteps = containers.length * 4 + 2;
  let currentStep = 0;

  const progress = () => Math.min(Math.round((currentStep / totalSteps) * 100), 99);
  const originalStates = new Map<string, string>();
  const rollbackBackups = new Map<string, string>();
  const rebuildStarted = new Set<string>();
  const maintenance = beginContainerMaintenance(containers, {
    operation: `infrastructure-update:${appDef.id}`,
  });
  let retainMaintenance = false;

  emit({ stage: 'starting', message: `Starting update for ${appDef.displayName}`, progress: 0 });

  try {
    // 1. Stop and independently copy every rootfs before any rebuild.
    for (let index = 0; index < containers.length; index++) {
      const name = containers[index];
      originalStates.set(name, await containerState(name));
      emit({ stage: 'snapshot', message: `Creating independent rollback copy of ${name}`, container: name, progress: progress() });
      await stopContainer(name);
      const backup = `ye-rollback-${maintenance.id.replaceAll('-', '').slice(0, 12)}-${index}`;
      await createRollbackInstanceBackup(name, backup);
      rollbackBackups.set(name, backup);
      currentStep++;
    }

    // 2. Rebuild only after all rollback datasets have verified.
    for (const name of containers) {
      emit({ stage: 'rebuilding', message: `Rebuilding ${name} with latest image`, container: name, progress: progress() });
      rebuildStarted.add(name);
      await rebuildContainer(name, appDef.imageRef);
      currentStep++;
    }

    // 3. Restore the exact pre-update desired runtime state.
    for (const name of containers) {
      if (originalStates.get(name) === 'Running') {
        emit({ stage: 'starting-container', message: `Starting ${name}`, container: name, progress: progress() });
        await startContainer(name);
      } else {
        emit({ stage: 'starting-container', message: `${name} remains stopped`, container: name, progress: progress() });
      }
      currentStep++;
    }

    // 4. Verify every container that was originally running.
    emit({ stage: 'verifying', message: 'Verifying containers are running', progress: progress() });
    for (const name of containers) {
      if (originalStates.get(name) === 'Running') await waitForRunning(name, 30);
    }
    currentStep++;

    markAppUpdated(appDef.id);

    // 5. Commit cleanup happens only after runtime and metadata succeed.
    const cleanupFailures: string[] = [];
    for (const backup of rollbackBackups.values()) {
      try {
        await deleteInstance(backup);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupFailures.length > 0) {
      await observeIssue({
        id: `service.${appDef.id}.update-rollback-cleanup`,
        severity: 'warning',
        source: 'infrastructure-updater',
        title: `${appDef.displayName} retained a rollback copy after update`,
        body: 'The update committed, but one or more stopped rollback copies require cleanup.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`service.${appDef.id}.update-rollback-cleanup`);
    }
    currentStep++;

    emit({ stage: 'completed', message: `${appDef.displayName} updated successfully`, progress: 100 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    emit({ stage: 'rolling-back', message: `Update failed, rolling back: ${errMsg}`, progress: progress() });
    maintenance.markRollback(errMsg);
    const rollbackFailures: string[] = [];
    const rollbackCleanupFailures: string[] = [];

    for (const name of containers) {
      try {
        const backup = rollbackBackups.get(name);
        if (rebuildStarted.has(name)) {
          if (!backup) throw new Error('verified rollback instance is missing');
          await restoreRollbackInstanceBackup(name, backup);
        } else if (backup) {
          try {
            await deleteInstance(backup);
          } catch (cleanupError) {
            rollbackCleanupFailures.push(`${name}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
        if (originalStates.get(name) === 'Running') {
          await startContainer(name);
          await waitForRunning(name, 30);
        }
      } catch (rollbackErr) {
        console.error(`[updater] Rollback failed for ${name}:`, rollbackErr);
        rollbackFailures.push(`${name}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }

    if (rollbackFailures.length > 0) {
      retainMaintenance = true;
      maintenance.markFailed(rollbackFailures.join('; '));
      await observeIssue({
        id: `service.${appDef.id}.update-rollback-failed`,
        severity: 'critical',
        source: 'infrastructure-updater',
        title: `${appDef.displayName} update rollback requires attention`,
        body: 'Automatic rollback was incomplete. Watchdog recovery remains suppressed by the durable maintenance record.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`service.${appDef.id}.update-rollback-failed`);
    }
    if (rollbackCleanupFailures.length > 0) {
      await observeIssue({
        id: `service.${appDef.id}.update-rollback-cleanup`,
        severity: 'warning',
        source: 'infrastructure-updater',
        title: `${appDef.displayName} retained an unused rollback copy`,
        body: 'The original container remained intact, but a stopped rollback copy requires cleanup.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`service.${appDef.id}.update-rollback-cleanup`);
    }

    const finalError = rollbackFailures.length > 0
      ? `${errMsg}; rollback incomplete: ${rollbackFailures.join('; ')}`
      : errMsg;
    emit({ stage: 'failed', message: finalError, error: finalError, progress: 0 });
    throw new Error(finalError, { cause: error });
  } finally {
    if (!retainMaintenance) maintenance.release();
  }
}
