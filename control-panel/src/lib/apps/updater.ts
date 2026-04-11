/**
 * OCI Container Updater
 *
 * Updates OCI containers managed by the Control Panel via the Incus REST API.
 * Uses snapshot → stop → rebuild → start → verify with automatic rollback on failure.
 *
 * For multi-container apps (Authentik), all containers are updated atomically:
 * snapshot all → stop all → rebuild all → start all → verify all.
 */

import { incusRequest } from '@/lib/incus/server';
import { type AppDefinition, imageRefToIncusSource } from './definitions';
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

// ─── Incus Operation Helpers ──────────────────────────────────────────────────

async function waitForOperation(operationPath: string, timeoutSeconds = 300): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  const resp = await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });

  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (!meta) return;

  if ((meta.status as string) === 'Failure') {
    const errMsg = (meta.err as string) || 'unknown error';
    throw new Error(`Operation failed: ${errMsg}`);
  }
}

async function containerState(name: string): Promise<string> {
  try {
    const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${name}/state`);
    const meta = resp.metadata as Record<string, unknown> | undefined;
    return (meta?.status as string) ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function stopContainer(name: string): Promise<void> {
  const state = await containerState(name);
  if (state !== 'Running') return;

  const resp = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${name}/state`,
    { action: 'stop', force: true, timeout: 30 }
  );
  if (resp.type === 'async' && resp.operation) {
    await waitForOperation(resp.operation, 60);
  }
}

async function startContainer(name: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${name}/state`,
    { action: 'start' }
  );
  if (resp.type === 'async' && resp.operation) {
    await waitForOperation(resp.operation, 60);
  }
}

async function createSnapshot(name: string, snapshotName: string): Promise<void> {
  // Delete existing snapshot with the same name (ignore errors)
  try {
    await incusRequest('DELETE', `/1.0/instances/${name}/snapshots/${snapshotName}`);
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // fine — snapshot didn't exist
  }

  const resp = await incusRequest<Record<string, unknown>>(
    'POST',
    `/1.0/instances/${name}/snapshots`,
    { name: snapshotName, stateful: false }
  );
  if (resp.type === 'async' && resp.operation) {
    await waitForOperation(resp.operation, 120);
  }
}

async function restoreSnapshot(name: string, snapshotName: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${name}`,
    { restore: snapshotName }
  );
  if (resp.type === 'async' && resp.operation) {
    await waitForOperation(resp.operation, 300);
  }
}

async function deleteSnapshot(name: string, snapshotName: string): Promise<void> {
  try {
    const resp = await incusRequest<Record<string, unknown>>(
      'DELETE',
      `/1.0/instances/${name}/snapshots/${snapshotName}`
    );
    if (resp.type === 'async' && resp.operation) {
      await waitForOperation(resp.operation, 60);
    }
  } catch {
    // non-critical
  }
}

/**
 * Rebuild a container with a new OCI image source.
 * Uses POST /1.0/instances/{name}/rebuild (Incus 6.x).
 */
async function rebuildContainer(name: string, imageRef: string): Promise<void> {
  const source = imageRefToIncusSource(imageRef);

  const resp = await incusRequest<Record<string, unknown>>(
    'POST',
    `/1.0/instances/${name}/rebuild`,
    {
      source: {
        type: 'image',
        ...source,
      },
    },
    { timeout: 660_000 } // 11 min for image download
  );

  if (resp.error && resp.error !== '') {
    throw new Error(`Rebuild failed: ${resp.error}`);
  }

  if (resp.type === 'async' && resp.operation) {
    await waitForOperation(resp.operation, 600);
  }
}

async function waitForRunning(name: string, maxWait = 30): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const state = await containerState(name);
    if (state === 'Running') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container ${name} did not reach Running state within ${maxWait}s`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update an OCI app by rebuilding its containers with the latest image.
 *
 * Flow:
 *   1. Snapshot all containers  (rollback point)
 *   2. Stop all containers
 *   3. Rebuild each container with new image
 *   4. Start all containers
 *   5. Verify all running
 *   6. Cleanup snapshots
 *
 * On failure at any step: rollback all containers to snapshots.
 */
export async function updateOCIApp(
  appDef: AppDefinition,
  emit: EventEmitter
): Promise<void> {
  if (!appDef.imageRef) {
    throw new Error(`App ${appDef.id} has no imageRef`);
  }

  const containers = appDef.containers.map((c) => c.name);
  const totalSteps = containers.length * 4 + 2; // snapshot + stop + rebuild + start per container + verify + cleanup
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

    // 3. Rebuild all containers
    for (const name of containers) {
      emit({ stage: 'rebuilding', message: `Rebuilding ${name} with latest image`, container: name, progress: progress() });
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

    // Mark as updated in cache
    markAppUpdated(appDef.id);

    emit({ stage: 'completed', message: `${appDef.displayName} updated successfully`, progress: 100 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    emit({ stage: 'rolling-back', message: `Update failed, rolling back: ${errMsg}`, progress: progress() });

    // Attempt rollback for all containers
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
