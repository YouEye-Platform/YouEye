/**
 * Backup Service — CP backup orchestrator.
 *
 * Orchestrates the backup pipeline:
 * 1. Enumerate backup targets (config, databases, app volumes)
 * 2. Dump PostgreSQL databases into staging area
 * 3. Collect platform configs into staging area
 * 4. Call Spine for host-level operations (stop containers, copy volumes, archive, encrypt)
 * 5. Poll Spine status and relay progress to the browser via SSE
 *
 * Uses poll-based progress (like the update flow), NOT direct SSE from Spine.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { spineClient } from '@/lib/spine/client';
import { execShell, getInstanceState } from '@/lib/incus/server';
import { listInstalledApps } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';
import type {
  BackupConfig,
  BackupEvent,
  BackupEventCallback,
  AppBackupPlan,
  ManifestBackupSection,
} from './types';

const STAGING_BASE = '/tmp/youeye-backup';
const YOUEYE_CONFIG_DIR = '/etc/youeye';
const YOUEYE_DATA_DIR = '/var/lib/youeye';

/**
 * Build a backup plan: enumerate what needs to be backed up.
 */
async function buildBackupPlan(): Promise<{
  configs: string[];
  apps: AppBackupPlan[];
  sharedDbNames: string[];
}> {
  const configs = [
    path.join(YOUEYE_CONFIG_DIR, 'youeye.yaml'),
  ];

  // Check for Caddy config
  const caddyConfigs = ['/etc/caddy/Caddyfile'];
  for (const c of caddyConfigs) {
    if (existsSync(c)) configs.push(c);
  }

  const apps: AppBackupPlan[] = [];
  const sharedDbNames: string[] = [];

  // List installed apps
  const installedApps = await listInstalledApps();

  for (const meta of installedApps) {
    // Try to fetch the manifest to get backup instructions
    let backupSection: ManifestBackupSection | undefined;
    let manifest: Awaited<ReturnType<typeof fetchManifest>> | undefined;
    try {
      manifest = await fetchManifest(meta.appId);
      // Read the typed backup section from the manifest
      if (manifest && 'backup' in manifest) {
        const raw = (manifest as Record<string, unknown>).backup;
        if (raw && typeof raw === 'object') {
          backupSection = raw as ManifestBackupSection;
        }
      }
    } catch {
      // Manifest not available — use defaults
    }

    const plan: AppBackupPlan = {
      appId: meta.appId,
      appName: meta.appId,
      containerNames: meta.containers || [],
      stopOrder: [],
      startOrder: [],
      useSharedPostgres: false,
      volumePaths: [],
      excludePaths: [],
    };

    if (backupSection) {
      // Use manifest-declared backup strategy
      plan.stopOrder = backupSection.stopOrder || [];
      plan.startOrder = backupSection.startOrder || [];
      plan.excludePaths = backupSection.exclude || [];

      if (backupSection.ownPostgres) {
        plan.ownPostgres = backupSection.ownPostgres;
      }

      if (backupSection.volumes && backupSection.volumes.length > 0) {
        // Map container-internal paths to host-side paths
        // Convention: host volumes are at /var/lib/youeye/app-{appId}-{container}/{path}
        // For now, collect the host-side paths from manifest containers
        plan.volumePaths = resolveHostVolumePaths(meta.appId, manifest, backupSection.volumes);
      } else {
        // Default: all volumes for this app
        plan.volumePaths = getDefaultVolumePaths(meta.appId, meta.containers);
      }
    } else {
      // Default strategy: stop all containers, export all volumes
      plan.stopOrder = [...meta.containers]; // stop all
      plan.startOrder = [...meta.containers].reverse(); // start in reverse
      plan.volumePaths = getDefaultVolumePaths(meta.appId, meta.containers);
    }

    // Check if app uses shared PostgreSQL
    if (manifest) {
      const features = (manifest as Record<string, unknown>).features as Record<string, unknown> | undefined;
      if (features?.requiresSharedPostgres) {
        plan.useSharedPostgres = true;
        plan.sharedDbName = meta.appId;
        sharedDbNames.push(meta.appId);
      }
    }

    apps.push(plan);
  }

  // Always include Authentik database
  sharedDbNames.push('authentik');

  return { configs, apps, sharedDbNames };
}

/**
 * Resolve host-side volume paths from manifest container volume definitions.
 */
function resolveHostVolumePaths(
  appId: string,
  manifest: unknown,
  declaredVolumes: string[]
): string[] {
  const hostPaths: string[] = [];
  const manifestObj = manifest as Record<string, unknown>;
  const containers = manifestObj?.containers as Array<Record<string, unknown>> | undefined;

  if (!containers) return hostPaths;

  for (const container of containers) {
    const volumes = container.volumes as Array<{ host: string; container: string }> | undefined;
    if (!volumes) continue;

    for (const vol of volumes) {
      // Check if this container path is in the declared volumes list
      if (declaredVolumes.some(dv => vol.container.endsWith(dv) || vol.container === dv)) {
        // Resolve the host path with variable substitution
        const hostPath = vol.host
          .replace(/\$\{app\.id\}/g, appId)
          .replace(/\$\{app\.name\}/g, appId);
        hostPaths.push(hostPath);
      }
    }
  }

  return hostPaths;
}

/**
 * Get default volume paths for an app's containers.
 */
function getDefaultVolumePaths(appId: string, containers: string[]): string[] {
  const paths: string[] = [];
  for (const container of containers) {
    const basePath = path.join(YOUEYE_DATA_DIR, container);
    if (existsSync(basePath)) {
      paths.push(basePath);
    }
  }
  // Also check the app-{id} base path
  const appPath = path.join(YOUEYE_DATA_DIR, `app-${appId}`);
  if (existsSync(appPath)) {
    paths.push(appPath);
  }
  return paths;
}

/**
 * Run a full backup. This is the main entry point.
 *
 * @param config - Backup configuration (target path, passphrase)
 * @param onEvent - Callback for progress events (sent to browser via SSE)
 */
export async function runBackup(
  config: BackupConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const { configs, apps, sharedDbNames } = await buildBackupPlan();

  // Calculate total steps
  const totalSteps =
    1 + // collect configs
    (sharedDbNames.length > 0 ? 1 : 0) + // shared PG dumps
    apps.filter(a => a.ownPostgres).length + // own PG dumps
    1 + // call Spine (volume export + archive + encrypt + write)
    1; // completion

  let step = 0;

  const emit = (stage: string, message: string, status: BackupEvent['status'] = 'progress') => {
    step++;
    onEvent({
      step,
      totalSteps,
      status,
      stage,
      message,
      progress: Math.round((step / totalSteps) * 100),
    });
  };

  // Create staging directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `backup-${timestamp}`);
  await mkdir(path.join(stagingDir, 'configs'), { recursive: true });
  await mkdir(path.join(stagingDir, 'databases'), { recursive: true });
  await mkdir(path.join(stagingDir, 'volumes'), { recursive: true });

  // Step 1: Collect platform configs
  emit('collect-configs', 'Collecting platform configuration...');
  for (const configPath of configs) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const destPath = path.join(stagingDir, 'configs', path.basename(configPath));
      await writeFile(destPath, content);
    } catch {
      // Config file may not exist — skip
    }
  }

  // Step 2: Dump shared PostgreSQL databases
  if (sharedDbNames.length > 0) {
    emit('dump-shared-postgres', `Dumping shared PostgreSQL databases (${sharedDbNames.length})...`);
    for (const dbName of sharedDbNames) {
      try {
        const dumpResult = await execShell(
          'youeye-postgres',
          `pg_dump -U postgres ${dbName}`,
          { timeout: 120000 }
        );
        if (dumpResult.exitCode !== 0) {
          onEvent({
            step,
            totalSteps,
            status: 'progress',
            stage: 'dump-shared-postgres',
            message: `Warning: pg_dump for ${dbName} returned exit code ${dumpResult.exitCode}`,
            detail: dumpResult.stderr,
          });
        }
        const dumpPath = path.join(stagingDir, 'databases', `${dbName}-${timestamp}.sql`);
        await writeFile(dumpPath, dumpResult.stdout);
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'dump-shared-postgres',
          message: `Warning: Failed to dump ${dbName}: ${err}`,
        });
      }
    }
  }

  // Step 3: Dump own PostgreSQL databases (apps with their own PG)
  for (const app of apps) {
    if (!app.ownPostgres) continue;
    const { container, database } = app.ownPostgres;
    emit('dump-own-postgres', `Dumping ${app.appName} own PostgreSQL (${database})...`);
    try {
      // Check if the container is running
      const state = await getInstanceState(container);
      if (state.metadata && (state.metadata as Record<string, unknown>).status === 'Running') {
        const dumpResult = await execShell(
          container,
          `pg_dump -U postgres ${database}`,
          { timeout: 120000 }
        );
        const dumpPath = path.join(stagingDir, 'databases', `${app.appId}-own-db-${timestamp}.sql`);
        await writeFile(dumpPath, dumpResult.stdout);
      }
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'dump-own-postgres',
        message: `Warning: Failed to dump ${app.appName} own DB: ${err}`,
      });
    }
  }

  // Step 4: Call Spine for host-level operations
  emit('spine-backup', 'Starting host-level backup operations...');

  // Collect all containers to stop and volumes to export
  const allContainersToStop: string[] = [];
  const allVolumePaths: string[] = [];

  for (const app of apps) {
    if (app.stopOrder.length > 0) {
      allContainersToStop.push(...app.stopOrder);
    }
    allVolumePaths.push(...app.volumePaths);
  }

  // Get hostname
  let hostname: string;
  try {
    hostname = config.hostname || os.hostname();
  } catch {
    hostname = 'youeye';
  }

  // Start backup on Spine
  const spineResult = await spineClient.startBackup({
    target_path: config.targetPath,
    passphrase: config.passphrase,
    containers: allContainersToStop,
    volume_paths: allVolumePaths,
    staging_dir: stagingDir,
    hostname,
  });

  // Poll Spine status until backup completes
  const backupId = spineResult.backup_id;
  let completed = false;
  const pollInterval = 2000; // 2 seconds
  const maxPollTime = 30 * 60 * 1000; // 30 minutes max
  const startTime = Date.now();

  while (!completed && Date.now() - startTime < maxPollTime) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const status = await spineClient.getBackupStatus();
      if (status.backup_id !== backupId) continue;

      // Relay progress to browser
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: status.stage || 'spine-backup',
        message: status.message,
        progress: status.progress,
      });

      if (status.status === 'completed') {
        completed = true;
        emit('completed', 'Backup completed successfully', 'completed');
        onEvent({
          step: totalSteps,
          totalSteps,
          status: 'completed',
          stage: 'completed',
          message: 'Backup completed successfully',
          archivePath: status.archive_path,
          archiveSize: status.archive_size,
          progress: 100,
        });
      } else if (status.status === 'failed') {
        completed = true;
        onEvent({
          step,
          totalSteps,
          status: 'error',
          stage: 'spine-backup',
          message: 'Backup failed',
          detail: status.error,
        });
      }
    } catch (err) {
      // Spine might be temporarily unavailable during container operations
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'spine-backup',
        message: `Polling Spine status... (${err})`,
      });
    }
  }

  if (!completed) {
    onEvent({
      step,
      totalSteps,
      status: 'error',
      stage: 'timeout',
      message: 'Backup timed out after 30 minutes',
    });
  }
}
