import { execCommand, incusRequest } from '@/lib/incus/server';
import {
  rebuildContainer,
  startContainer,
  stopContainer,
  stopTimeoutSec,
  waitForRunning,
} from '@/lib/incus/snapshot';
import { applyResourcePolicy } from './resource-policy';
import { generatePassword, getOrCreateSecret, readSecret } from './secrets';
import { waitForCaddy, waitForPiHole, waitForPostgres } from './health-checks';
import {
  RECORDED_IMAGE_KEY,
  RECORDED_VERSION_KEY,
  recordSystemContainerImage,
  SYSTEM_IMAGE_IDS,
  SYSTEM_IMAGES,
  type SystemImageId,
} from './system-images';

type SystemId = SystemImageId;

type TrackingStatus = 'tracked' | 'untracked' | 'missing';

interface IncusInstanceMetadata {
  config?: Record<string, string>;
}

export interface SystemUpdatePlan {
  id: SystemId;
  containerName: string;
  desiredImage: string;
  desiredVersion: string;
  exists: boolean;
  running: boolean;
  trackingStatus: TrackingStatus;
  currentImage?: string;
  currentVersion?: string;
  recordedImage?: string;
  recordedVersion?: string;
  updateAvailable: boolean;
  recreateRecommended: boolean;
  reason: string;
}

export interface SystemUpdateOptions {
  systemId: SystemId;
  hostIP: string;
  adoptUntracked?: boolean;
  allowDatabaseUpdate?: boolean;
  confirmMaintenanceWindow?: boolean;
  confirmContainerName?: string;
  dryRun?: boolean;
}

export interface SystemUpdateResult {
  success: boolean;
  systemId: SystemId;
  previousVersion?: string;
  newVersion?: string;
  message: string;
  plan: SystemUpdatePlan;
  error?: string;
}

type EventCallback = (event: {
  step: number;
  totalSteps: number;
  status: 'running' | 'success' | 'error' | 'skipped';
  message: string;
  detail?: string;
}) => void;

function emit(
  cb: EventCallback,
  step: number,
  totalSteps: number,
  status: 'running' | 'success' | 'error' | 'skipped',
  message: string,
  detail?: string,
) {
  cb({ step, totalSteps, status, message, detail });
}

async function getInstanceMetadata(containerName: string): Promise<IncusInstanceMetadata | null> {
  try {
    const response = await incusRequest<IncusInstanceMetadata>(
      'GET',
      `/1.0/instances/${containerName}`,
      undefined,
      { timeout: 30_000 },
    );
    if (response.error) return null;
    return response.metadata ?? null;
  } catch {
    return null;
  }
}

async function isRunning(containerName: string): Promise<boolean> {
  try {
    const response = await incusRequest<Record<string, unknown>>(
      'GET',
      `/1.0/instances/${containerName}/state`,
      undefined,
      { timeout: 10_000 },
    );
    return (response.metadata?.status as string | undefined) === 'Running';
  } catch {
    return false;
  }
}

function describePlan(
  systemId: SystemId,
  metadata: IncusInstanceMetadata | null,
  running: boolean,
): SystemUpdatePlan {
  const desired = SYSTEM_IMAGES[systemId];
  const containerName = desired.containerName;
  const config = metadata?.config ?? {};
  const recordedImage = config[RECORDED_IMAGE_KEY];
  const recordedVersion = config[RECORDED_VERSION_KEY];

  if (!metadata) {
    return {
      id: systemId,
      containerName,
      desiredImage: desired.image,
      desiredVersion: desired.version,
      exists: false,
      running: false,
      trackingStatus: 'missing',
      updateAvailable: false,
      recreateRecommended: false,
      reason: 'Container is missing; run infrastructure reconcile to create it from the pinned image.',
    };
  }

  if (recordedImage) {
    const updateAvailable = recordedImage !== desired.image || recordedVersion !== desired.version;
    return {
      id: systemId,
      containerName,
      desiredImage: desired.image,
      desiredVersion: desired.version,
      exists: true,
      running,
      trackingStatus: 'tracked',
      currentImage: recordedImage,
      currentVersion: recordedVersion,
      recordedImage,
      recordedVersion,
      updateAvailable,
      recreateRecommended: updateAvailable,
      reason: updateAvailable
        ? 'Container image differs from the image pinned by this YouEye release.'
        : 'Container matches the image pinned by this YouEye release.',
    };
  }

  return {
    id: systemId,
    containerName,
    desiredImage: desired.image,
    desiredVersion: desired.version,
    exists: true,
    running,
    trackingStatus: 'untracked',
    updateAvailable: false,
    recreateRecommended: true,
    reason: 'Container has no recorded image; adopt it with a recreate only during a maintenance window.',
  };
}

export async function planSystemUpdates(): Promise<SystemUpdatePlan[]> {
  const plans: SystemUpdatePlan[] = [];

  for (const id of SYSTEM_IMAGE_IDS) {
    const { containerName } = SYSTEM_IMAGES[id];
    const metadata = await getInstanceMetadata(containerName);
    plans.push(describePlan(id, metadata, await isRunning(containerName)));
  }

  return plans;
}

async function verifySystemHealth(systemId: SystemId): Promise<boolean> {
  if (systemId === 'postgresql') {
    const password = await readSecret('postgres', '.pg_password');
    return password ? waitForPostgres(password) : false;
  }
  if (systemId === 'caddy') return waitForCaddy();
  return waitForPiHole();
}

async function postUpdateRepair(systemId: SystemId): Promise<void> {
  const { containerName } = SYSTEM_IMAGES[systemId];
  await applyResourcePolicy(containerName, 'critical');

  if (systemId === 'pihole') {
    const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
    const result = await execCommand(containerName, [
      '/bin/sh', '-c', 'pihole setpassword "$YOUEYE_PIHOLE_PASSWORD"',
    ], {
      environment: { YOUEYE_PIHOLE_PASSWORD: webPassword },
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`pihole setpassword failed after update: ${result.stderr || result.stdout}`);
    }
  }
}

export async function updateSystemContainer(
  options: SystemUpdateOptions,
  onEvent: EventCallback,
): Promise<SystemUpdateResult> {
  const plans = await planSystemUpdates();
  const plan = plans.find((item) => item.id === options.systemId);
  if (!plan) {
    throw new Error(`Unknown system app "${options.systemId}"`);
  }

  const totalSteps = options.dryRun ? 1 : 6;
  emit(onEvent, 1, totalSteps, 'running', `Planning ${plan.id} system update`, JSON.stringify(plan));

  if (!plan.exists) {
    return {
      success: false,
      systemId: plan.id,
      message: plan.reason,
      plan,
      error: plan.reason,
    };
  }

  if (!options.dryRun) {
    if (!options.confirmMaintenanceWindow) {
      const message = 'System rebuilds require confirmMaintenanceWindow because they stop and recreate critical infrastructure containers.';
      emit(onEvent, 1, totalSteps, 'error', message);
      return { success: false, systemId: plan.id, message, plan, error: message };
    }

    if (options.confirmContainerName !== plan.containerName) {
      const message = `System rebuild confirmation must match ${plan.containerName}.`;
      emit(onEvent, 1, totalSteps, 'error', message);
      return { success: false, systemId: plan.id, message, plan, error: message };
    }
  }

  if (plan.id === 'postgresql' && !options.allowDatabaseUpdate) {
    const message = 'PostgreSQL system updates require allowDatabaseUpdate because database image replacement needs an explicit maintenance decision.';
    emit(onEvent, 1, totalSteps, 'error', message);
    return { success: false, systemId: plan.id, message, plan, error: message };
  }

  if (plan.trackingStatus !== 'tracked' && !options.adoptUntracked) {
    const message = `${plan.containerName} is ${plan.trackingStatus}; pass adoptUntracked to adopt it during a maintenance window.`;
    emit(onEvent, 1, totalSteps, 'error', message);
    return { success: false, systemId: plan.id, message, plan, error: message };
  }

  if (!plan.updateAvailable && plan.trackingStatus === 'tracked') {
    const message = `${plan.containerName} already runs its pinned image.`;
    emit(onEvent, 1, totalSteps, 'skipped', message);
    return {
      success: true,
      systemId: plan.id,
      previousVersion: plan.currentVersion,
      newVersion: plan.desiredVersion,
      message,
      plan,
    };
  }

  if (options.dryRun) {
    const message = `Dry run: ${plan.containerName} would rebuild to ${plan.desiredImage}.`;
    emit(onEvent, 1, totalSteps, 'success', message);
    return {
      success: true,
      systemId: plan.id,
      previousVersion: plan.currentVersion,
      newVersion: plan.desiredVersion,
      message,
      plan,
    };
  }

  try {
    emit(onEvent, 2, totalSteps, 'running', `Stopping ${plan.containerName}`);
    // Clean stop; a timeout fails the update here, before the rebuild.
    await stopContainer(plan.containerName, { timeoutSec: stopTimeoutSec(plan.id === 'postgresql' ? 'database' : undefined) });

    emit(onEvent, 3, totalSteps, 'running', `Rebuilding ${plan.containerName}`, plan.desiredImage);
    await rebuildContainer(plan.containerName, plan.desiredImage);
    // A new root file system brings Pi-hole's own update check back; it goes off before the first start. The edit
    // never stops the update: Pi-hole is the LAN's DNS, so it starts whatever the edit did.
    if (plan.id === 'pihole') {
      await import('./pihole-update-check').then(m => m.turnOffPiholeUpdateCheck(plan.containerName))
        .catch(error => console.warn('[SystemUpdater] Pi-hole update check left as it is:', error));
    }

    emit(onEvent, 4, totalSteps, 'running', `Starting ${plan.containerName}`);
    await startContainer(plan.containerName);
    await waitForRunning(plan.containerName, 60);

    emit(onEvent, 5, totalSteps, 'running', `Verifying ${plan.containerName}`);
    const healthy = await verifySystemHealth(plan.id);
    if (!healthy) {
      throw new Error(`${plan.containerName} did not pass its post-update health check`);
    }
    await postUpdateRepair(plan.id);

    await recordSystemContainerImage(plan.id);

    emit(onEvent, 6, totalSteps, 'success', `${plan.containerName} now tracks ${plan.desiredImage}`);
    return {
      success: true,
      systemId: plan.id,
      previousVersion: plan.currentVersion,
      newVersion: plan.desiredVersion,
      message: `${plan.containerName} updated to its pinned image`,
      plan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(onEvent, 0, totalSteps, 'error', `System update failed: ${message}`);
    return {
      success: false,
      systemId: plan.id,
      previousVersion: plan.currentVersion,
      newVersion: plan.desiredVersion,
      message,
      plan,
      error: message,
    };
  }
}
