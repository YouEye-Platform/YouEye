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
import { execShell } from '@/lib/incus/server';
import { readInstallMetadata } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';
import { getRoutes } from '@/lib/caddy/client';
import type {
  AppBackupConfig,
  BackupEvent,
  BackupEventCallback,
  ManifestBackupSection,
} from './types';

const STAGING_BASE = '/tmp/youeye-backup';
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
    try {
      const manifest = await fetchManifest(appId);
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
    } catch {
      // Manifest not available from remote — continue without it
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'fetch-manifest',
        message: `Warning: Could not fetch manifest for ${appId} — continuing with defaults`,
      });
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
    const manifest = await fetchManifest(appId).catch(() => null);
    const features = manifest
      ? (manifest as Record<string, unknown>).features as Record<string, unknown> | undefined
      : undefined;

    if (features?.requiresSharedPostgres) {
      try {
        const dumpResult = await execShell(
          'youeye-postgres',
          `pg_dump -U postgres ${appId}`,
          { timeout: 120000 }
        );
        if (dumpResult.exitCode === 0) {
          await writeFile(
            path.join(stagingDir, 'databases', `${appId}-shared.sql`),
            dumpResult.stdout
          );
        } else {
          onEvent({
            step,
            totalSteps,
            status: 'progress',
            stage: 'dump-databases',
            message: `Warning: pg_dump for shared DB ${appId} returned exit code ${dumpResult.exitCode}`,
            detail: dumpResult.stderr,
          });
        }
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'dump-databases',
          message: `Warning: Failed to dump shared DB ${appId}: ${err}`,
        });
      }
    }

    // Own PostgreSQL dump (from manifest backup section)
    if (backupSection?.ownPostgres) {
      const { container, database } = backupSection.ownPostgres;
      try {
        const dumpResult = await execShell(
          container,
          `pg_dump -U postgres ${database}`,
          { timeout: 120000 }
        );
        if (dumpResult.exitCode === 0) {
          await writeFile(
            path.join(stagingDir, 'databases', `${appId}-own.sql`),
            dumpResult.stdout
          );
        }
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'dump-databases',
          message: `Warning: Failed to dump own DB for ${appId}: ${err}`,
        });
      }
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
        appId,
        appVersion: manifestVersion,
        platformVersion,
        timestamp: new Date().toISOString(),
        containers: installMeta.containers.map((c: any) => typeof c === 'string' ? c : c.containerName),
        subdomain: installMeta.subdomain,
        domain: installMeta.domain,
      }, null, 2)
    );

    // ── Step 5: Call Spine for live volume backup ───────────
    emit('spine-backup', `Starting live volume backup for ${appId}...`);

    // Collect volume paths (skip cache volumes from manifest)
    const volumePaths: string[] = [];
    const cacheVolumePaths = new Set<string>();
    if (manifest) {
      const manifestContainers = (manifest as Record<string, unknown>).containers as Array<Record<string, unknown>> | undefined;
      if (manifestContainers) {
        for (const mc of manifestContainers) {
          const volumes = mc.volumes as Array<Record<string, unknown>> | undefined;
          if (!volumes) continue;
          for (const vol of volumes) {
            if (vol.type === 'cache') {
              const hostPath = (vol.host as string || '')
                .replace(/\$\{app\.id\}/g, appId)
                .replace(/\$\{app\.name\}/g, appId);
              if (hostPath) cacheVolumePaths.add(hostPath);
            }
          }
        }
      }
    }

    // Secrets directory
    const secretsPath = path.join(YOUEYE_DATA_DIR, `app-${appId}`);
    if (existsSync(secretsPath)) {
      volumePaths.push(secretsPath);
    }

    // App data directory
    const appDataPath = path.join(YOUEYE_DATA_DIR, 'apps', appId);
    if (existsSync(appDataPath)) {
      volumePaths.push(appDataPath);
    }

    // Get container names for volume paths (v2 format: objects, v1: strings)
    const volumeContainerNames = installMeta.containers.map((c: any) =>
      typeof c === 'string' ? c : c.containerName
    );

    // Per-container volume paths for multi-container apps
    for (const containerName of volumeContainerNames) {
      const containerPath = path.join(YOUEYE_DATA_DIR, `app-${appId}-${containerName}`);
      if (existsSync(containerPath) && !cacheVolumePaths.has(containerPath)) {
        volumePaths.push(containerPath);
      }
      // Also check the bare container path
      const barePath = path.join(YOUEYE_DATA_DIR, containerName);
      if (existsSync(barePath) && !cacheVolumePaths.has(barePath)) {
        volumePaths.push(barePath);
      }
    }

    // Start backup on Spine with live mode (freeze instead of stop)
    const spineResult = await spineClient.startBackup({
      target_path: config.targetPath,
      passphrase: config.passphrase,
      containers: volumeContainerNames,
      volume_paths: volumePaths,
      staging_dir: stagingDir,
      hostname: `app-${appId}`,
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

    if (!completed) {
      onEvent({
        step,
        totalSteps,
        status: 'error',
        stage: 'timeout',
        message: `App backup for ${appId} timed out after 30 minutes`,
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
