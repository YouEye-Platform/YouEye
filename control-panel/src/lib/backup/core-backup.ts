/**
 * Core platform backup orchestrator.
 *
 * Backs up the YouEye platform infrastructure:
 * 1. Dump the YouEye ID, UI, and AI PostgreSQL databases (live, MVCC-safe)
 * 2. Collect youeye.yaml config
 * 3. Build installed-apps.json from install metadata
 * 4. Stage infra secrets, Caddy config, Pi-Hole config, identity media
 * 5. Call Spine for live volume backup of infrastructure directories
 * 6. Archive + encrypt
 * 7. Poll + relay events
 */

import { chmod, copyFile, readdir, writeFile, mkdir, rm, stat } from 'fs/promises';
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
import { BACKUP_STAGING_ROOT, runningContainers, volumeMappings } from './workspace';
import {
  dumpPostgresDatabase,
  platformDatabaseExists,
  PLATFORM_DATABASES,
  PLATFORM_POSTGRES_ADMIN,
  PLATFORM_POSTGRES_CONTAINER,
} from './postgres';
import { readCurrentBackupSourceIdentity } from './compatibility';

const STAGING_BASE = path.join(BACKUP_STAGING_ROOT, 'create');
const YOUEYE_DATA_DIR = '/var/lib/youeye';

/** Infrastructure containers to freeze during core backup */
const INFRA_CONTAINERS = [
  'youeye-postgres',
  'youeye-caddy',
  'youeye-pihole',
  'youeye-pointer',
];

/** Infrastructure volume paths to back up */
const INFRA_VOLUME_PATHS = [
  `${YOUEYE_DATA_DIR}/caddy/`,
  `${YOUEYE_DATA_DIR}/pihole/`,
  `${YOUEYE_DATA_DIR}/config/`,
  `${YOUEYE_DATA_DIR}/networks/`,
  `${YOUEYE_DATA_DIR}/ui/`,
  `${YOUEYE_DATA_DIR}/pointer/`,
];

async function stageAppNetworkRecoveryState(stagingDir: string): Promise<void> {
  const source = `${YOUEYE_DATA_DIR}/networks`;
  if (!existsSync(source)) return;
  const destination = path.join(stagingDir, 'networks');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);

  const copyProtectedJson = async (input: string, output: string): Promise<void> => {
    const inputStat = await stat(input);
    if (!inputStat.isFile() || (inputStat.mode & 0o077) !== 0) {
      throw new Error(`Refusing to back up app network state with insecure permissions: ${path.basename(input)}`);
    }
    await copyFile(input, output);
    await chmod(output, 0o600);
  };

  const ipam = path.join(source, 'ipam.json');
  if (existsSync(ipam)) await copyProtectedJson(ipam, path.join(destination, 'ipam.json'));

  const operations = path.join(source, 'operations');
  if (existsSync(operations)) {
    const outputOperations = path.join(destination, 'operations');
    await mkdir(outputOperations, { recursive: true, mode: 0o700 });
    await chmod(outputOperations, 0o700);
    for (const entry of await readdir(operations, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      await copyProtectedJson(
        path.join(operations, entry.name),
        path.join(outputOperations, entry.name),
      );
    }
  }
}

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
    emit('dump-databases', 'Dumping YouEye ID, UI, and AI databases...');

    const backedUpDatabases: string[] = [];
    for (const dbName of PLATFORM_DATABASES) {
      try {
        // Appliances updating from a pre-AI release legitimately have no
        // Pointer database until infrastructure reconciliation provisions it.
        if (dbName === 'pointer' && !(await platformDatabaseExists(dbName))) {
          continue;
        }
        const dump = await dumpPostgresDatabase({
          container: PLATFORM_POSTGRES_CONTAINER,
          database: dbName,
          user: PLATFORM_POSTGRES_ADMIN,
        });
        await writeFile(
          path.join(stagingDir, 'databases', `${dbName}-${timestamp}.sql`),
          dump
        );
        backedUpDatabases.push(dbName);
      } catch (err) {
        throw new Error(`Failed to dump ${dbName}: ${err}`);
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
    } catch (error) {
      throw new Error(`Could not read persistent platform configuration: ${error}`);
    }

    // ── Step 3: Build installed-apps.json ──────────────────
    emit('installed-apps', 'Building installed apps manifest...');
    try {
      const installedApps = await listInstalledApps();
      await writeFile(
        path.join(stagingDir, 'installed-apps.json'),
        JSON.stringify(installedApps, null, 2)
      );
    } catch (error) {
      throw new Error(`Could not freeze the installed-app inventory: ${error}`);
    }
    // Atomic JSON files are copied individually into the encrypted staging
    // archive. Transient allocator/per-app lock directories are intentionally
    // excluded so a restored PID can never inherit a stale lock owner.
    await stageAppNetworkRecoveryState(stagingDir);

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
	  throw new Error(`Could not back up the server routing configuration: ${err}`);
    }

    // ── Step 5: Stage Pi-Hole config ───────────────────────
    emit('stage-pihole', 'Staging Network shield configuration...');
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
	  } else {
		throw new Error('Network shield did not return its configuration');
      }
    } catch (err) {
	  throw new Error(`Could not back up the network shield configuration: ${err}`);
    }

    // Write backup-meta.json
    const sourceIdentity = config.sourceIdentity ?? await readCurrentBackupSourceIdentity();

    await writeFile(
      path.join(stagingDir, 'backup-meta.json'),
      JSON.stringify({
        schema: 'youeye.backup.core-meta.v1',
        type: 'core',
        source: sourceIdentity,
        databases: backedUpDatabases,
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
      use_stored_passphrase: config.useStoredPassphrase,
      containers: await runningContainers([...INFRA_CONTAINERS, 'youeye-control', 'youeye-ui']),
      volume_mappings: volumeMappings(existingVolumePaths),
      staging_dir: stagingDir,
      hostname,
      backup_type: 'core',
    });

    // Poll Spine status until complete
    const backupId = spineResult.backup_id;
    let completed = false;
    let terminalError = '';
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
          terminalError = status.error || 'Core backup failed';
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

    if (terminalError) throw new Error(terminalError);

    if (!completed) {
      onEvent({
        step,
        totalSteps,
        status: 'error',
        stage: 'timeout',
        message: 'Core backup timed out after 30 minutes',
      });
      throw new Error('Core backup timed out after 30 minutes');
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
