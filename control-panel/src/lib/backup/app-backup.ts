/**
 * Per-app backup orchestrator.
 *
 * Backs up a single installed app:
 * 1. Read install metadata + frozen manifest
 * 2. Extract Caddy routes for the app's subdomain
 * 3. Dump databases (shared and/or own PostgreSQL)
 * 4. Stage all metadata, configs, and DB dumps
 * 5. Call Spine for live volume backup + archive + encrypt
 * 6. Poll Spine status and relay events via onEvent
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spineClient } from '@/lib/spine/client';
import { readInstallMetadata } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';
import { getRoutes } from '@/lib/caddy/client';
import type {
  AppBackupConfig,
  BackupEvent,
  BackupEventCallback,
  ManifestBackupSection,
} from './types';
import { BACKUP_STAGING_ROOT, runningContainers, volumeMappings } from './workspace';
import { readCurrentBackupSourceIdentity } from './compatibility';
import { dumpPostgresDatabase, PLATFORM_POSTGRES_ADMIN, PLATFORM_POSTGRES_CONTAINER } from './postgres';
import { resolveOwnPostgres } from './manifest-values';

const STAGING_BASE = path.join(BACKUP_STAGING_ROOT, 'create');
const YOUEYE_DATA_DIR = '/var/lib/youeye';

/**
 * Back up a single installed app.
 *
 * Uses live (freeze-based) backup via Spine so the app containers
 * are only briefly paused rather than fully stopped.
 */
export async function backupApp(
  config: AppBackupConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const { appId } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `app-${appId}-${timestamp}`);

  // Estimate total steps
  const totalSteps = 6; // metadata, manifest, caddy, db dump, spine backup, completion
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
    await mkdir(path.join(stagingDir, 'secrets'), { recursive: true });
    await mkdir(path.join(stagingDir, 'caddy'), { recursive: true });

    // ── Step 1: Read install metadata ──────────────────────
    emit('read-metadata', `Reading install metadata for ${appId}...`);
    const installMeta = await readInstallMetadata(appId);
    if (!installMeta) {
      throw new Error(`No install metadata found for app: ${appId}`);
    }
    await writeFile(
      path.join(stagingDir, 'install.json'),
      JSON.stringify(installMeta, null, 2)
    );

    // ── Step 2: Fetch and freeze manifest ──────────────────
    emit('fetch-manifest', `Fetching manifest for ${appId}...`);
    let backupSection: ManifestBackupSection | undefined;
    let manifestVersion = installMeta.installedVersion || 'unknown';
    let frozenManifest: Awaited<ReturnType<typeof fetchManifest>> | null = null;
    try {
      const manifest = await fetchManifest(appId);
      frozenManifest = manifest;
      // Save a frozen copy of the manifest
      await writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );
      manifestVersion = manifest.version || manifestVersion;

      // Extract backup section
      if (manifest && 'backup' in manifest) {
        const raw = (manifest as Record<string, unknown>).backup;
        if (raw && typeof raw === 'object') {
          backupSection = raw as ManifestBackupSection;
        }
      }
    } catch (error) {
      throw new Error(`Could not freeze the installed manifest for ${appId}: ${error}`);
    }

    // ── Step 3: Extract Caddy routes ───────────────────────
    emit('caddy-routes', `Extracting Caddy routes for ${appId}...`);
    try {
      const allRoutes = await getRoutes();
      const hostname = installMeta.subdomain && installMeta.domain
        ? `${installMeta.subdomain}.${installMeta.domain}`
        : undefined;

      // Get container names from metadata (v2 format: objects, v1: strings)
      const containerNames = installMeta.containers.map((c: any) =>
        typeof c === 'string' ? c : c.containerName
      );

      const appRoutes = allRoutes.filter(route => {
        if (hostname && route.hostname === hostname) return true;
        // Also match by upstream container name
        return containerNames.some((c: string) => route.upstream === c);
      });

      if (appRoutes.length > 0) {
        await writeFile(
          path.join(stagingDir, 'caddy', 'routes.json'),
          JSON.stringify(appRoutes, null, 2)
        );
      }
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'caddy-routes',
        message: `Warning: Could not extract Caddy routes: ${err}`,
      });
    }

    // ── Step 4: Dump databases ─────────────────────────────
    emit('dump-databases', `Dumping databases for ${appId}...`);

    // Shared PostgreSQL dump
    const manifest = frozenManifest;
    const features = manifest
      ? (manifest as Record<string, unknown>).features as Record<string, unknown> | undefined
      : undefined;

    if (features?.requiresSharedPostgres || typeof installMeta.databaseName === 'string') {
      try {
        const manifestDatabase = (manifest as Record<string, unknown>).database as Record<string, unknown> | undefined;
        const database = typeof installMeta.databaseName === 'string'
          ? installMeta.databaseName
          : typeof manifestDatabase?.name === 'string' ? manifestDatabase.name : appId;
        const dump = await dumpPostgresDatabase({
          container: PLATFORM_POSTGRES_CONTAINER,
          database,
          user: PLATFORM_POSTGRES_ADMIN,
        });
        await writeFile(path.join(stagingDir, 'databases', `${appId}-shared.sql`), dump);
      } catch (err) {
		throw new Error(`Required shared database dump failed for ${appId}: ${err}`);
      }
    }

    // Own PostgreSQL dump (from manifest backup section)
    if (backupSection?.ownPostgres) {
      const { container, database, user } = resolveOwnPostgres(backupSection.ownPostgres, appId);
      try {
        const dump = await dumpPostgresDatabase({ container, database, user });
        await writeFile(path.join(stagingDir, 'databases', `${appId}-own.sql`), dump);
      } catch (err) {
		throw new Error(`Required application database dump failed for ${appId}: ${err}`);
      }
    }

    // Write backup-meta.json
    const sourceIdentity = config.sourceIdentity ?? await readCurrentBackupSourceIdentity();

    await writeFile(
      path.join(stagingDir, 'backup-meta.json'),
      JSON.stringify({
        schema: 'youeye.backup.app-meta.v1',
        appId,
        appVersion: manifestVersion,
        source: sourceIdentity,
        timestamp: new Date().toISOString(),
        containers: installMeta.containers.map((c: any) => typeof c === 'string' ? c : c.containerName),
        subdomain: installMeta.subdomain,
        domain: installMeta.domain,
      }, null, 2)
    );

    // ── Step 5: Call Spine for live volume backup ───────────
    emit('spine-backup', `Starting live volume backup for ${appId}...`);

    // Host paths now contain only protected YouEye metadata/secrets. App
    // persistence is exported from Incus custom volumes below.
    const volumePaths: string[] = [];

    // Secrets directory
    const secretsPath = path.join(YOUEYE_DATA_DIR, `app-${appId}`);
    if (existsSync(secretsPath)) {
      volumePaths.push(secretsPath);
    }

    // Get container names for runtime quiescing (object and historical string
    // metadata both normalize to the exact Incus instance name here).
    const volumeContainerNames = installMeta.containers.map((c: any) =>
      typeof c === 'string' ? c : c.containerName
    );

    // An app-owned PostgreSQL container is recovered from the required logical
    // dump above. Exporting its crash-consistent raw data volume as well would
    // replay an old database runtime before importing that dump.
    const logicalDatabaseContainer = backupSection?.ownPostgres
      ? resolveOwnPostgres(backupSection.ownPostgres, appId).container
      : null;

    // Start backup on Spine with live mode (freeze instead of stop)
    const spineResult = await spineClient.startBackup({
      target_path: config.targetPath,
      passphrase: config.passphrase,
      use_stored_passphrase: config.useStoredPassphrase,
      containers: await runningContainers(volumeContainerNames),
      volume_mappings: volumeMappings(volumePaths),
      incus_runtimes: installMeta.containers.map((container: any) => ({
        name: typeof container === 'string' ? container : container.containerName,
        type: typeof container === 'string' ? 'lxd' : container.type,
      })),
      incus_volumes: [...new Map(
        (installMeta.storageVolumes ?? [])
          .filter((volume) => !volume.attachmentOnly && volume.containerName !== logicalDatabaseContainer)
          .map((volume) => [`${volume.pool}/${volume.name}`, { pool: volume.pool, name: volume.name }]),
      ).values()],
      staging_dir: stagingDir,
      hostname: `app-${appId}`,
      backup_type: 'app',
      app_id: appId,
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
          emit('completed', `Backup of ${appId} completed successfully`, 'completed');
          onEvent({
            step: totalSteps,
            totalSteps,
            status: 'completed',
            stage: 'completed',
            message: `Backup of ${appId} completed successfully`,
            archivePath: status.archive_path,
            archiveSize: status.archive_size,
            progress: 100,
          });
        } else if (status.status === 'failed') {
          completed = true;
          terminalError = status.error || `Backup of ${appId} failed`;
          onEvent({
            step,
            totalSteps,
            status: 'error',
            stage: 'spine-backup',
            message: `Backup of ${appId} failed`,
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
        message: `App backup for ${appId} timed out after 30 minutes`,
      });
      throw new Error(`App backup for ${appId} timed out after 30 minutes`);
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
