import { incusRequest, execShell } from '@/lib/incus/server';
import {
  rebuildContainer,
  startContainer,
  stopContainer,
  waitForRunning,
} from '@/lib/incus/snapshot';
import { applyResourcePolicy } from './resource-policy';
import { generatePassword, getOrCreateSecret } from './secrets';
import { waitForCaddy, waitForPiHole, waitForPostgres } from './health-checks';
import {
  getRequiredSystemContainerName,
  recordSystemContainerManifest,
  REQUIRED_SYSTEM_APP_IDS,
  resolveSystemImageOverrides,
  type SystemImageOverrides,
} from './system-market-manifests';

type SystemId = keyof SystemImageOverrides;

type TrackingStatus = 'tracked' | 'legacy-compatible' | 'legacy-untracked' | 'missing';

interface IncusInstanceMetadata {
  config?: Record<string, string>;
}

export interface SystemUpdatePlan {
  id: SystemId;
  containerName: string;
  desiredImage: string;
  desiredVersion: string;
  sourceId?: string;
  manifestPath?: string;
  manifestDigest?: string;
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
  forceLegacy?: boolean;
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

function imageFromLegacyConfig(config: Record<string, string>, systemId: SystemId): string | undefined {
  const imageId = config['image.id'];
  if (!imageId) return undefined;
  if (imageId.includes('/')) return `docker.io/${imageId}`;
  if (systemId === 'caddy') return `docker.io/library/${imageId}`;
  if (systemId === 'postgresql') return `docker.io/library/${imageId}`;
  return `docker.io/${imageId}`;
}

function versionFromLegacyConfig(config: Record<string, string>, systemId: SystemId): string | undefined {
  if (systemId === 'postgresql') return config['environment.PG_VERSION'];
  if (systemId === 'caddy') return config['environment.CADDY_VERSION']?.replace(/^v/, '');
  return undefined;
}

function describePlan(
  systemId: SystemId,
  desired: SystemImageOverrides[SystemId],
  metadata: IncusInstanceMetadata | null,
  running: boolean,
): SystemUpdatePlan {
  const containerName = getRequiredSystemContainerName(systemId);
  const config = metadata?.config ?? {};
  const recordedImage = config['user.youeye.market.image'];
  const recordedVersion = config['user.youeye.market.version'];
  const currentVersion = recordedVersion ?? versionFromLegacyConfig(config, systemId);
  const currentImage = recordedImage ?? imageFromLegacyConfig(config, systemId);

  if (!metadata) {
    return {
      id: systemId,
      containerName,
      desiredImage: desired.image,
      desiredVersion: desired.version,
      sourceId: desired.sourceId,
      manifestPath: desired.manifestPath,
      manifestDigest: desired.manifestDigest,
      exists: false,
      running: false,
      trackingStatus: 'missing',
      updateAvailable: false,
      recreateRecommended: false,
      reason: 'Container is missing; run infrastructure reconcile to create it from the Market system manifest.',
    };
  }

  if (recordedImage) {
    const updateAvailable = recordedImage !== desired.image || recordedVersion !== desired.version;
    return {
      id: systemId,
      containerName,
      desiredImage: desired.image,
      desiredVersion: desired.version,
      sourceId: desired.sourceId,
      manifestPath: desired.manifestPath,
      manifestDigest: desired.manifestDigest,
      exists: true,
      running,
      trackingStatus: 'tracked',
      currentImage,
      currentVersion,
      recordedImage,
      recordedVersion,
      updateAvailable,
      recreateRecommended: updateAvailable,
      reason: updateAvailable
        ? 'Tracked container image/version differs from the Market system manifest.'
        : 'Tracked container matches the Market system manifest.',
    };
  }

  const compatible = currentVersion === desired.version;
  return {
    id: systemId,
    containerName,
    desiredImage: desired.image,
    desiredVersion: desired.version,
    sourceId: desired.sourceId,
    manifestPath: desired.manifestPath,
    manifestDigest: desired.manifestDigest,
    exists: true,
    running,
    trackingStatus: compatible ? 'legacy-compatible' : 'legacy-untracked',
    currentImage,
    currentVersion,
    updateAvailable: false,
    recreateRecommended: true,
    reason: compatible
      ? 'Container predates Market tracking but runtime version matches the Market manifest; force a legacy adoption recreate only during a maintenance window.'
      : 'Container predates Market tracking and cannot be proven to match the Market manifest; force a legacy adoption recreate only during a maintenance window.',
  };
}

export async function planSystemUpdates(): Promise<SystemUpdatePlan[]> {
  const desired = await resolveSystemImageOverrides();
  const plans: SystemUpdatePlan[] = [];

  for (const id of REQUIRED_SYSTEM_APP_IDS) {
    const containerName = getRequiredSystemContainerName(id);
    const metadata = await getInstanceMetadata(containerName);
    plans.push(describePlan(id, desired[id], metadata, await isRunning(containerName)));
  }

  return plans;
}

async function verifySystemHealth(systemId: SystemId): Promise<boolean> {
  if (systemId === 'postgresql') return waitForPostgres();
  if (systemId === 'caddy') return waitForCaddy();
  return waitForPiHole();
}

async function postUpdateRepair(systemId: SystemId): Promise<void> {
  const containerName = getRequiredSystemContainerName(systemId);
  await applyResourcePolicy(containerName, 'critical');

  if (systemId === 'pihole') {
    const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
    const result = await execShell(containerName, `pihole setpassword ${webPassword}`, { timeout: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`pihole setpassword failed after update: ${result.stderr || result.stdout}`);
    }
  }
}

export async function updateSystemFromMarket(
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

  if (plan.trackingStatus !== 'tracked' && !options.forceLegacy) {
    const message = `${plan.containerName} is ${plan.trackingStatus}; pass forceLegacy to adopt it into Market tracking during a maintenance window.`;
    emit(onEvent, 1, totalSteps, 'error', message);
    return { success: false, systemId: plan.id, message, plan, error: message };
  }

  if (!plan.updateAvailable && plan.trackingStatus === 'tracked' && !options.forceLegacy) {
    const message = `${plan.containerName} already matches the Market system manifest.`;
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
    await stopContainer(plan.containerName);

    emit(onEvent, 3, totalSteps, 'running', `Rebuilding ${plan.containerName}`, plan.desiredImage);
    await rebuildContainer(plan.containerName, plan.desiredImage);

    emit(onEvent, 4, totalSteps, 'running', `Starting ${plan.containerName}`);
    await startContainer(plan.containerName);
    await waitForRunning(plan.containerName, 60);

    emit(onEvent, 5, totalSteps, 'running', `Verifying ${plan.containerName}`);
    const healthy = await verifySystemHealth(plan.id);
    if (!healthy) {
      throw new Error(`${plan.containerName} did not pass its post-update health check`);
    }
    await postUpdateRepair(plan.id);

    const desired = await resolveSystemImageOverrides();
    await recordSystemContainerManifest(plan.id, desired[plan.id]);

    emit(onEvent, 6, totalSteps, 'success', `${plan.containerName} now tracks ${plan.desiredImage}`);
    return {
      success: true,
      systemId: plan.id,
      previousVersion: plan.currentVersion,
      newVersion: plan.desiredVersion,
      message: `${plan.containerName} updated from Market system manifest`,
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
