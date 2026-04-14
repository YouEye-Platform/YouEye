/**
 * OCI Container Updater (Infrastructure)
 *
 * Updates OCI containers managed by the Control Panel via the Incus REST API.
 * Uses snapshot → stop → rebuild → start → verify with automatic rollback on failure.
 *
 * For multi-container apps (Authentik), all containers are updated atomically:
 * snapshot all → stop all → rebuild all → start all → verify all.
 *
 * NOTE: This handles INFRASTRUCTURE OCI apps (Authentik, Caddy, PiHole, Postgres).
 * Marketplace and native app updates go through market/updater.ts which supports
 * both OCI and LXD paths with migrations, variable context, and DB tracking.
 */

import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  stopContainer,
  startContainer,
  rebuildContainer,
  waitForRunning,
} from '@/lib/incus/snapshot';
import { type AppDefinition } from './definitions';
import { markAppUpdated } from './update-cache';

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

const SNAPSHOT_NAME = 'pre-update';

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

  emit({ stage: 'starting', message: `Starting update for ${appDef.displayName}`, progress: 0 });

  try {
    // 1. Snapshot all containers
    for (const name of containers) {
      emit({ stage: 'snapshot', message: `Creating snapshot of ${name}`, container: name, progress: progress() });
      await createSnapshot(name, SNAPSHOT_NAME);
      currentStep++;
    }

    // 2. Stop all containers
    for (const name of containers) {
      emit({ stage: 'stopping', message: `Stopping ${name}`, container: name, progress: progress() });
      await stopContainer(name);
      currentStep++;
    }

    // 3. Rebuild all containers (snapshots must be deleted first)
    for (const name of containers) {
      emit({ stage: 'rebuilding', message: `Rebuilding ${name} with latest image`, container: name, progress: progress() });
      await deleteSnapshot(name, SNAPSHOT_NAME);
      await rebuildContainer(name, appDef.imageRef);
      currentStep++;
    }

    // 4. Start all containers
    for (const name of containers) {
      emit({ stage: 'starting-container', message: `Starting ${name}`, container: name, progress: progress() });
      await startContainer(name);
      currentStep++;
    }

    // 5. Verify
    emit({ stage: 'verifying', message: 'Verifying containers are running', progress: progress() });
    for (const name of containers) {
      await waitForRunning(name, 30);
    }
    currentStep++;

    // 6. Cleanup snapshots
    for (const name of containers) {
      await deleteSnapshot(name, SNAPSHOT_NAME);
    }
    currentStep++;

    markAppUpdated(appDef.id);

    emit({ stage: 'completed', message: `${appDef.displayName} updated successfully`, progress: 100 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    emit({ stage: 'rolling-back', message: `Update failed, rolling back: ${errMsg}`, progress: progress() });

    for (const name of containers) {
      try {
        await restoreSnapshot(name, SNAPSHOT_NAME);
        await startContainer(name);
      } catch (rollbackErr) {
        console.error(`[updater] Rollback failed for ${name}:`, rollbackErr);
      }
    }

    emit({ stage: 'failed', message: errMsg, error: errMsg, progress: 0 });
    throw error;
  }
}
