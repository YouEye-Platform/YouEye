/**
 * Core platform backup orchestrator.
 *
 * Backs up the YouEye platform infrastructure:
 * 1. Dump Authentik + youeye PostgreSQL databases (live, MVCC-safe)
 * 2. Collect youeye.yaml config
 * 3. Build installed-apps.json from install metadata
 * 4. Stage infra secrets, Caddy config, Pi-Hole config, Authentik media
 * 5. Call Spine for live volume backup of infrastructure directories
 * 6. Archive + encrypt
 * 7. Poll + relay events
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { spineClient } from '@/lib/spine/client';
import { execShell } from '@/lib/incus/server';
import { listInstalledApps } from '@/lib/market/metadata';
import { getRoutes, getConfig as getCaddyConfig } from '@/lib/caddy/client';
import type {
  CoreBackupConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';

const STAGING_BASE = '/tmp/youeye-backup';
const YOUEYE_DATA_DIR = '/var/lib/youeye';

/** Infrastructure containers to freeze during core backup */
const INFRA_CONTAINERS = [
  'youeye-postgres',
  'youeye-authentik',
  'youeye-caddy',
  'youeye-pihole',
];

/** Infrastructure volume paths to back up */
const INFRA_VOLUME_PATHS = [
  `${YOUEYE_DATA_DIR}/postgres/`,
  `${YOUEYE_DATA_DIR}/authentik/`,
  `${YOUEYE_DATA_DIR}/caddy/`,
  `${YOUEYE_DATA_DIR}/pihole/`,
  `${YOUEYE_DATA_DIR}/control/`,
];

/**
 * Back up the core YouEye platform.
 *
 * Uses live (freeze-based) backup via Spine so infrastructure
 * containers are only briefly paused.
 */
export async function backupCore(
  config: CoreBackupConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `core-${timestamp}`);

  const totalSteps = 7;
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

  try {
    // Create staging directory
    await mkdir(path.join(stagingDir, 'databases'), { recursive: true });
    await mkdir(path.join(stagingDir, 'configs'), { recursive: true });
    await mkdir(path.join(stagingDir, 'caddy'), { recursive: true });

    // ── Step 1: Dump PostgreSQL databases ──────────────────
    emit('dump-databases', 'Dumping infrastructure databases (Authentik, youeye)...');

    const dbNames = ['authentik', 'youeye'];
    for (const dbName of dbNames) {
      try {
        const dumpResult = await execShell(
          'youeye-postgres',
          `pg_dump -U postgres ${dbName}`,
          { timeout: 120000 }
        );
        if (dumpResult.exitCode === 0) {
          await writeFile(
            path.join(stagingDir, 'databases', `${dbName}-${timestamp}.sql`),
            dumpResult.stdout
          );
        } else {
          onEvent({
            step,
            totalSteps,
            status: 'progress',
            stage: 'dump-databases',
            message: `Warning: pg_dump for ${dbName} exited with code ${dumpResult.exitCode}`,
            detail: dumpResult.stderr,
          });
        }
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'dump-databases',
          message: `Warning: Failed to dump ${dbName}: ${err}`,
        });
      }
    }

    // ── Step 2: Collect youeye.yaml config ─────────────────
    emit('collect-config', 'Collecting platform configuration...');
    try {
      const spineConfig = await spineClient.getConfig();
      await writeFile(
        path.join(stagingDir, 'configs', 'youeye-config.json'),
        JSON.stringify(spineConfig, null, 2)
      );
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'collect-config',
        message: `Warning: Could not read Spine config: ${err}`,
      });
    }

    // ── Step 3: Build installed-apps.json ──────────────────
    emit('installed-apps', 'Building installed apps manifest...');
    try {
      const installedApps = await listInstalledApps();
      await writeFile(
        path.join(stagingDir, 'installed-apps.json'),
        JSON.stringify(installedApps, null, 2)
      );
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'installed-apps',
        message: `Warning: Could not enumerate installed apps: ${err}`,
      });
    }

    // ── Step 4: Stage Caddy config ─────────────────────────
    emit('stage-caddy', 'Staging Caddy configuration...');
    try {
      const caddyConfig = await getCaddyConfig();
      await writeFile(
        path.join(stagingDir, 'caddy', 'caddy-config.json'),
        JSON.stringify(caddyConfig, null, 2)
      );

      const routes = await getRoutes();
      await writeFile(
        path.join(stagingDir, 'caddy', 'routes.json'),
        JSON.stringify(routes, null, 2)
      );
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'stage-caddy',
        message: `Warning: Could not stage Caddy config: ${err}`,
      });
    }

    // ── Step 5: Stage Pi-Hole config ───────────────────────
    emit('stage-pihole', 'Staging Pi-Hole and Authentik configuration...');
    try {
      // Read pihole.toml from the container
      const piholeResult = await execShell(
        'youeye-pihole',
        'cat /etc/pihole/pihole.toml',
        { timeout: 10000 }
      );
      if (piholeResult.exitCode === 0) {
        await mkdir(path.join(stagingDir, 'pihole'), { recursive: true });
        await writeFile(
          path.join(stagingDir, 'pihole', 'pihole.toml'),
          piholeResult.stdout
        );
      }
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'stage-pihole',
        message: `Warning: Could not stage Pi-Hole config: ${err}`,
      });
    }

    // Write backup-meta.json
    let platformVersion = 'unknown';
    try {
      const spineVersion = await spineClient.version();
      platformVersion = spineVersion.version;
    } catch {
      // Non-fatal
    }

    await writeFile(
      path.join(stagingDir, 'backup-meta.json'),
      JSON.stringify({
        type: 'core',
        platformVersion,
        timestamp: new Date().toISOString(),
        hostname: config.hostname || os.hostname(),
        infraContainers: INFRA_CONTAINERS,
      }, null, 2)
    );

    // ── Step 6: Call Spine for live volume backup ───────────
    emit('spine-backup', 'Starting live infrastructure volume backup...');

    // Filter to only existing paths
    const existingVolumePaths = INFRA_VOLUME_PATHS.filter(p => existsSync(p));

    const hostname = config.hostname || os.hostname();
    const spineResult = await spineClient.startBackup({
      target_path: config.targetPath,
      passphrase: config.passphrase,
      containers: INFRA_CONTAINERS,
      volume_paths: existingVolumePaths,
      staging_dir: stagingDir,
      hostname,
    });

    // Poll Spine status until complete
    const backupId = spineResult.backup_id;
    let completed = false;
    const pollInterval = 2000;
    const maxPollTime = 30 * 60 * 1000;
    const startTime = Date.now();

    while (!completed && Date.now() - startTime < maxPollTime) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      try {
        const status = await spineClient.getBackupStatus();
        if (status.backup_id !== backupId) continue;

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
          emit('completed', 'Core platform backup completed successfully', 'completed');
          onEvent({
            step: totalSteps,
            totalSteps,
            status: 'completed',
            stage: 'completed',
            message: 'Core platform backup completed successfully',
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
            message: 'Core backup failed',
            detail: status.error,
          });
        }
      } catch (err) {
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
        message: 'Core backup timed out after 30 minutes',
      });
    }
  } finally {
    // Clean up staging directory
    try {
      if (existsSync(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }
  }
}
