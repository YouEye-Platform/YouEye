/**
 * Per-app restore orchestrator.
 *
 * Restores a single app from a backup archive:
 * 1. Call Spine to decrypt + extract archive to staging
 * 2. Read backup-meta.json — validate app ID
 * 3. Read frozen manifest + install.json from staging
 * 4. Uninstall current app if it exists
 * 5. Restore secrets to /var/lib/youeye/app-{appId}/
 * 6. Restore database from dump
 * 7. Reinstall app via engine (restoreMode)
 * 8. Call Spine to restore volume data
 * 9. Restart containers to pick up restored data
 * 10. Health check
 */

import { readFile, writeFile, mkdir, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { spineClient } from '@/lib/spine/client';
import { incusRequest } from '@/lib/incus/server';
import { waitForOperation } from '@/lib/incus/snapshot';
import { readInstallMetadata, removeInstallMetadataRecord } from '@/lib/market/metadata';
import { uninstallApp } from '@/lib/market/uninstaller';
import { installApp } from '@/lib/market/engine';
import { fetchManifest } from '@/lib/market/catalog';
import { getContainerName } from '@/lib/market/engine-helpers';
import type { AppManifest, InstallConfig } from '@/lib/market/types';
import { addRoute } from '@/lib/caddy/client';
import type {
  AppRestoreConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';
import { BACKUP_STAGING_ROOT, runningContainers } from './workspace';
import { assessBackupCompatibility, readCurrentBackupSourceIdentity } from './compatibility';
import { replacePlatformAppDatabase, restoreOwnPostgresDatabase } from './postgres';
import { backupApp } from './app-backup';
import { probeInstalledApps } from '@/lib/market/app-prober';
import { resolveOwnPostgres, resolveSharedDatabasePasswordFile } from './manifest-values';
import { finishTracking, startTracking, trackEvent } from '@/lib/market/install-tracker';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { deleteCreatedRecoveryStorage, listStorageLocations } from '@/lib/market/storage';

const STAGING_BASE = path.join(BACKUP_STAGING_ROOT, 'restore');
const YOUEYE_DATA_DIR = '/var/lib/youeye';
const RESTORE_CONTAINER_STATE_ATTEMPTS = 5;
const RESTORE_CONTAINER_STATE_DELAY_MS = 1500;

async function stopContainerForRestore(container: string): Promise<void> {
  const response = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(container)}/state`, {
    action: 'stop', force: true, timeout: 60,
  });
  if (response.type === 'error') throw new Error(`Could not stop restored container ${container}`);
  if (response.type === 'async' && response.operation) await waitForOperation(response.operation, 60);
  if ((await runningContainers([container])).includes(container)) {
    throw new Error(`Restored container did not stop: ${container}`);
  }
}

async function startContainerAfterRestore(container: string): Promise<void> {
  for (let attempt = 1; attempt <= RESTORE_CONTAINER_STATE_ATTEMPTS; attempt++) {
    try {
      const response = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(container)}/state`, {
        action: 'start', timeout: 60,
      });
      if (response.type === 'async' && response.operation) await waitForOperation(response.operation, 60);
      if (response.type !== 'error' && (await runningContainers([container])).includes(container)) return;
    } catch {
      // Incus can reject a start briefly while the old monitor cgroup drains.
    }
    if (attempt < RESTORE_CONTAINER_STATE_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, RESTORE_CONTAINER_STATE_DELAY_MS));
    }
  }
  throw new Error(`Restored container did not start: ${container}`);
}

async function validateOwnPostgresStorageContract(
  manifest: AppManifest,
  appId: string,
  databaseContainer: string,
): Promise<void> {
  const databaseSpec = manifest.containers.find(spec =>
    getContainerName(appId, spec.name, manifest.containers.length) === databaseContainer,
  );
  if (!databaseSpec) throw new Error('Backup own-database container is absent from the frozen manifest');
  const hasDatabaseVolume = databaseSpec.volumes
    .filter(volume => !volume.storageGroup)
    .some(volume => volume.container === '/var/lib/postgresql/data'
      || volume.container.startsWith('/var/lib/postgresql/data/')
      || volume.container === '/bitnami/postgresql'
      || volume.container.startsWith('/bitnami/postgresql/'));
  if (!hasDatabaseVolume) {
    throw new Error('Backup own-database manifest does not declare a supported PostgreSQL data volume');
  }
}

/**
 * Restore a single app from a backup archive.
 */
export async function restoreApp(
  config: AppRestoreConfig,
  onEvent: BackupEventCallback,
  protectCurrentState = true,
): Promise<void> {
  return restoreAppOnce(config, onEvent, protectCurrentState);
}

async function restoreAppOnce(
  config: AppRestoreConfig,
  onEvent: BackupEventCallback,
  protectCurrentState: boolean,
): Promise<void> {
  const { appId, archivePath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const operationID = randomUUID();
  const stagingDir = path.join(STAGING_BASE, `app-${appId}-${timestamp}-${operationID}`);
  const rollbackRoot = path.join('/var/lib/youeye/backups/.rollback', `app-${appId}-${timestamp}-${operationID}`);
  let rollbackArchive = '';
  let retainRollbackPoint = false;
  let installedDuringRestore = false;
  let createdRecoveryStorage: Array<{ pool: string; name: string }> = [];

  const totalSteps = 8;
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
    await mkdir(stagingDir, { recursive: true });

    // ── Step 1: Decrypt + extract archive ──────────────────
    emit('decrypt', `Decrypting backup archive for ${appId}...`);
    await spineClient.restoreArchive({
      archive_path: archivePath,
      passphrase,
      staging_dir: stagingDir,
    });

    // ── Step 2: Read and validate backup metadata ──────────
    emit('validate', `Validating backup for ${appId}...`);

    const metaPath = path.join(stagingDir, 'backup-meta.json');
    if (!existsSync(metaPath)) {
      throw new Error('Invalid backup archive: missing backup-meta.json');
    }

    const backupMeta = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    if (backupMeta.schema !== 'youeye.backup.app-meta.v1') {
      throw new Error('App backup has an unsupported compatibility record.');
    }
    if (backupMeta.appId !== appId) {
      throw new Error(
        `Backup app ID mismatch: expected "${appId}", got "${backupMeta.appId}"`
      );
    }
    const compatibility = assessBackupCompatibility(backupMeta.source, await readCurrentBackupSourceIdentity());
    if (!compatibility.compatible) throw new Error(compatibility.summary);

    // Read install.json from backup
    const installJsonPath = path.join(stagingDir, 'install.json');
    let backedUpInstallMeta: Record<string, unknown> | null = null;
    if (existsSync(installJsonPath)) {
      backedUpInstallMeta = JSON.parse(await readFile(installJsonPath, 'utf-8'));
    }

    // Freeze and validate the manifest input before removing the current app.
    // Database restore must use the exact secret filename that reinstall reads.
    let manifest;
    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } else {
      manifest = await fetchManifest(appId);
    }

    const ownDumpPath = path.join(stagingDir, 'databases', `${appId}-own.sql`);
    if (existsSync(ownDumpPath)) {
      const backupSection = (manifest as Record<string, unknown>).backup as { ownPostgres?: { container?: string; database?: string; user?: string } } | undefined;
      if (!backupSection?.ownPostgres?.container || !backupSection.ownPostgres.database) {
        throw new Error('Backup is missing own-database restore metadata');
      }
      const ownPostgres = resolveOwnPostgres({
        container: backupSection.ownPostgres.container,
        database: backupSection.ownPostgres.database,
        user: backupSection.ownPostgres.user,
      }, appId);
      await validateOwnPostgresStorageContract(manifest, appId, ownPostgres.container);
    }

    // ── Step 3: Uninstall current app if exists ────────────
    emit('uninstall', `Removing existing installation of ${appId}...`);
    const currentMeta = await readInstallMetadata(appId);
    if (currentMeta && protectCurrentState) {
      onEvent({ step, totalSteps, status: 'progress', stage: 'rollback-point', message: `Protecting the current ${appId} state before restore`, progress: Math.round((step / totalSteps) * 100) });
      await backupApp({ appId, targetPath: rollbackRoot, passphrase }, () => undefined);
      const rollbackDirectory = path.join(rollbackRoot, 'youeye', 'apps', appId);
      const rollbackFiles = (await readdir(rollbackDirectory)).filter(file => file.endsWith('.tar.enc')).sort().reverse();
      if (!rollbackFiles[0]) throw new Error(`Could not create a rollback point for ${appId}`);
      rollbackArchive = path.join(rollbackDirectory, rollbackFiles[0]);
    }
    if (currentMeta) {
      const removal = await uninstallApp(appId, { dropSharedDatabase: true, keepData: false });
      if (!removal.success) {
        throw new Error(`Could not clear the current ${appId} installation before restore`);
      }
    }

    const availableStorage = new Set((await listStorageLocations()).map((location) => location.id));
    if (!availableStorage.has('default')) throw new Error('Internal app storage is unavailable for restore');
    const sourcePools = Array.isArray(backedUpInstallMeta?.storageVolumes)
      ? backedUpInstallMeta.storageVolumes
        .map((volume) => volume && typeof volume === 'object' ? (volume as Record<string, unknown>).pool : undefined)
        .filter((pool): pool is string => typeof pool === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(pool))
      : [];
    const poolMap = Object.fromEntries(
      [...new Set(sourcePools)]
        .filter((pool) => !availableStorage.has(pool))
        .map((pool) => [pool, 'default']),
    );
    const incusRecovery = await spineClient.prepareIncusRecovery(stagingDir, poolMap);
    if (incusRecovery.status !== 'prepared') {
      throw new Error('Backup does not contain the required self-contained app runtime');
    }
    createdRecoveryStorage = incusRecovery.volumes.filter((volume) => volume.created);
    const runtimeImages = Object.fromEntries(
      incusRecovery.runtimes
        .filter((runtime) => runtime.type === 'oci' && runtime.fingerprint)
        .map((runtime) => [runtime.name, runtime.fingerprint!]),
    );
    const runtimeInstances = Object.fromEntries(
      incusRecovery.runtimes
        .filter((runtime) => runtime.type === 'lxd' && runtime.archive_path)
        .map((runtime) => [runtime.name, { archivePath: runtime.archive_path!, pool: 'default' }]),
    );

    // ── Step 4: Restore volumes before reinstall ───────────
    // The installer reads restored secrets and configuration while creating
    // containers. Applying volumes after install would bind newly-generated
    // credentials into those containers and then overwrite them on disk.
    emit('restore-volumes', `Restoring volume data for ${appId}...`);
    await spineClient.applyBackupVolumes(stagingDir);
    // App data, secrets, and install.json intentionally share the same owned
    // root. The frozen install.json above is an input to reinstall, not active
    // lifecycle state; leaving its restored copy live makes preflight reject
    // the app as already installed. Remove only that file, never the data root.
    await removeInstallMetadataRecord(appId);

    // ── Step 5: Restore database ───────────────────────────
    emit('restore-database', `Restoring database for ${appId}...`);

    // Check for shared database dump
    const sharedDumpPath = path.join(stagingDir, 'databases', `${appId}-shared.sql`);
    if (existsSync(sharedDumpPath)) {
      const database = typeof backedUpInstallMeta?.databaseName === 'string'
        ? backedUpInstallMeta.databaseName
        : appId;
      const user = typeof backedUpInstallMeta?.databaseUser === 'string'
        ? backedUpInstallMeta.databaseUser
        : appId;
      await restoreSharedDatabase(appId, database, user, sharedDumpPath, manifest, onEvent, step, totalSteps);
    }

    // Check for own database dump
    if (existsSync(ownDumpPath)) {
      // Own database restore requires the app's own postgres container to be running.
      // This happens after reinstall — we defer it.
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'restore-database',
        message: 'Own database dump found — will restore after container deploy',
      });
    }

    // ── Step 6: Reinstall app ──────────────────────────────
    emit('reinstall', `Reinstalling ${appId} from manifest...`);

    // Build install config from backed-up metadata
    const subdomain = (backedUpInstallMeta?.subdomain as string) || appId;
    const domain = (backedUpInstallMeta?.domain as string) || '';
    const selectedIntegrations = Array.isArray(backedUpInstallMeta?.selectedIntegrations)
      ? backedUpInstallMeta.selectedIntegrations.filter((value): value is string => typeof value === 'string')
      : undefined;
    const backedUpAI = backedUpInstallMeta?.aiConnection as { modelGroupId?: unknown } | undefined;
    const installConfig: InstallConfig = {
      appId,
      subdomain,
      domain,
      ...(typeof backedUpInstallMeta?.catalogKey === 'string' ? { catalogKey: backedUpInstallMeta.catalogKey } : {}),
      ...(typeof backedUpInstallMeta?.sourceId === 'string' ? { sourceId: backedUpInstallMeta.sourceId } : {}),
      ...(typeof backedUpInstallMeta?.sourceName === 'string' ? { sourceName: backedUpInstallMeta.sourceName } : {}),
      ...(typeof backedUpInstallMeta?.sourceRepoUrl === 'string' ? { sourceRepoUrl: backedUpInstallMeta.sourceRepoUrl } : {}),
      ...(typeof backedUpInstallMeta?.manifestPath === 'string' ? { manifestPath: backedUpInstallMeta.manifestPath } : {}),
      ...(typeof backedUpInstallMeta?.manifestRepo === 'string' ? { manifestRepo: backedUpInstallMeta.manifestRepo } : {}),
      ...(typeof backedUpInstallMeta?.manifestBranch === 'string' ? { manifestBranch: backedUpInstallMeta.manifestBranch } : {}),
      ...(typeof backedUpInstallMeta?.manifestDigest === 'string' ? { manifestDigest: backedUpInstallMeta.manifestDigest } : {}),
      ...(selectedIntegrations ? { selectedIntegrations } : {}),
      ...(typeof backedUpInstallMeta?.protectWithAccountLogin === 'boolean'
        ? { protectWithAccountLogin: backedUpInstallMeta.protectWithAccountLogin }
        : {}),
      ...(typeof backedUpInstallMeta?.forwardAuthEnabled === 'boolean'
        ? { forwardAuthGate: backedUpInstallMeta.forwardAuthEnabled }
        : {}),
      ...(typeof backedUpAI?.modelGroupId === 'string'
        ? { aiSettings: { enabled: true, modelGroupId: backedUpAI.modelGroupId } }
        : {}),
    };

    // Run the install engine — it handles container creation, config files, etc.
    const installAbortController = startTracking(appId, manifest.metadata.name);
    try {
      await installApp(
        manifest,
        installConfig,
        (event) => {
          trackEvent(appId, event);
          // Relay install events as restore sub-events
          onEvent({
            step,
            totalSteps,
            status: event.status === 'error' ? 'error' : 'progress',
            stage: 'reinstall',
            message: event.message,
            detail: event.detail,
          });
        },
        installAbortController.signal,
        {
          skipSecrets: true,
          skipDatabase: true,
          skipConfigFiles: true,
          runtimeImages,
          runtimeInstances,
          recoveryCreatedStorage: createdRecoveryStorage.map((volume) => `${volume.pool}/${volume.name}`),
        },
      );
      finishTracking(appId);
    } catch (error) {
      finishTracking(appId, 'Restore reinstall failed');
      throw error;
    }
    installedDuringRestore = true;

    const containers: string[] = (Array.isArray(backupMeta.containers) ? backupMeta.containers : []).map((candidate: unknown) =>
      typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).containerName : undefined
    ).filter((name: unknown): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name));

    let postInstallOwnDatabaseRestore = false;
    if (existsSync(ownDumpPath)) {
      const backupSection = (manifest as Record<string, unknown>).backup as { ownPostgres?: { container?: string; database?: string; user?: string } } | undefined;
      if (!backupSection?.ownPostgres?.container || !backupSection.ownPostgres.database) {
        throw new Error('Backup is missing own-database restore metadata');
      }
      const { container, database, user } = resolveOwnPostgres({
        container: backupSection.ownPostgres.container,
        database: backupSection.ownPostgres.database,
        user: backupSection.ownPostgres.user,
      }, appId);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(container) || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
        throw new Error('Backup contains invalid own-database restore metadata');
      }
      const dependentContainers = containers.filter(containerName => containerName !== container);
      // The database remains running while its logical dump is replaced, but
      // it is still part of the maintenance boundary. Otherwise the watchdog
      // can race the brief database/client transition and restart the one
      // container whose exec channel is applying the recovery.
      const maintenance = beginContainerMaintenance(containers, { operation: `backup-restore-${appId}` });
      const stoppedContainers: string[] = [];
      try {
        for (const containerName of dependentContainers) {
          await stopContainerForRestore(containerName);
          stoppedContainers.push(containerName);
        }
        await restoreOwnPostgresDatabase({
          container,
          database,
          user,
          dump: await readFile(ownDumpPath),
        });
      } finally {
        const startFailures: string[] = [];
        for (const containerName of stoppedContainers) {
          try {
            await startContainerAfterRestore(containerName);
          } catch {
            startFailures.push(containerName);
          }
        }
        maintenance.release();
        if (startFailures.length > 0) {
          throw new Error(`Restored ${appId} containers did not start: ${startFailures.join(', ')}`);
        }
      }
      postInstallOwnDatabaseRestore = true;
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'restore-database',
        message: `Restored the encrypted database dump for ${appId}`,
      });
    }

    // ── Step 7: Restore routing ─────────────────────────────
    emit('restore-routing', `Restoring routes for ${appId}...`);

    // Restore any additional routes captured with the app. The installer has
    // already recreated the primary manifest route.
    const routesPath = path.join(stagingDir, 'caddy', 'routes.json');
    if (existsSync(routesPath)) {
      const routes = JSON.parse(await readFile(routesPath, 'utf-8')) as unknown;
      if (!Array.isArray(routes)) throw new Error(`Backup routes for ${appId} are invalid`);
      for (const route of routes) {
        if (!route || typeof route !== 'object') throw new Error(`Backup routes for ${appId} are invalid`);
        const candidate = route as { hostname?: unknown; path?: unknown; upstream?: unknown; port?: unknown };
        try {
          await addRoute({
            hostname: String(candidate.hostname ?? ''),
            path: String(candidate.path ?? ''),
            upstream: String(candidate.upstream ?? ''),
            port: Number(candidate.port),
          });
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('already exists'))) throw err;
        }
      }
    }

    // ── Step 8: Verify the exact restored state ───────────────
    // Shared databases and volumes were restored before install. For an
    // app-owned database, dependants were stopped while the logical dump
    // replaced the freshly initialized database and then started exactly once.
    emit('restart', postInstallOwnDatabaseRestore
      ? `Verifying ${appId} after database restore...`
      : `Verifying restored ${appId}...`);

    if (containers.length > 0) await new Promise(resolve => setTimeout(resolve, 3000));

    let healthy = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = (await probeInstalledApps()).find(item => item.appId === appId);
      if (result?.state === 'running') {
        healthy = true;
        break;
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!healthy) throw new Error(`${appId} did not pass its post-restore health check`);

    // Final completion event
    onEvent({
      step: totalSteps,
      totalSteps,
      status: 'completed',
      stage: 'completed',
      message: `${appId} restored successfully`,
      progress: 100,
    });
  } catch (error) {
    if (!installedDuringRestore && createdRecoveryStorage.length > 0) {
      await deleteCreatedRecoveryStorage(appId, createdRecoveryStorage).catch(() => undefined);
    }
    if (rollbackArchive && protectCurrentState) {
      onEvent({ step, totalSteps, status: 'progress', stage: 'rollback', message: `Restore failed; returning ${appId} to its previous state`, progress: Math.round((step / totalSteps) * 100) });
      try {
        await restoreAppOnce({ appId, archivePath: rollbackArchive, passphrase }, () => undefined, false);
      } catch (rollbackError) {
        retainRollbackPoint = true;
        throw new Error(`Restore failed (${error}); rollback also failed (${rollbackError})`);
      }
      throw new Error(`Restore failed and ${appId} was returned to its previous state: ${error}`);
    }
    if (installedDuringRestore) {
      await uninstallApp(appId, { dropSharedDatabase: true, keepData: false }).catch(() => undefined);
    }
    throw error;
  } finally {
    // Clean up staging directory
    try {
      if (existsSync(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }
    if (protectCurrentState && !retainRollbackPoint) await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Restore a shared PostgreSQL database from a SQL dump.
 * Creates the user and database, then pipes the dump.
 */
async function restoreSharedDatabase(
  appId: string,
  database: string,
  user: string,
  dumpPath: string,
  manifest: Parameters<typeof resolveSharedDatabasePasswordFile>[0],
  onEvent: BackupEventCallback,
  step: number,
  totalSteps: number
): Promise<void> {
  // Read the password from restored secrets
  let dbPassword = '';
  const secretsDir = path.join(YOUEYE_DATA_DIR, `app-${appId}`);
  const passwordFile = path.join(secretsDir, resolveSharedDatabasePasswordFile(manifest));
  if (existsSync(passwordFile)) {
    dbPassword = (await readFile(passwordFile, 'utf-8')).trim();
  }

  if (!dbPassword) {
    const { generatePassword } = await import('@/lib/infrastructure/secrets');
    dbPassword = generatePassword(32);
    await mkdir(secretsDir, { recursive: true });
    await writeFile(passwordFile, dbPassword, { mode: 0o600 });
  }

  await replacePlatformAppDatabase({
    database,
    user,
    password: dbPassword,
    dump: await readFile(dumpPath),
  });
  onEvent({ step, totalSteps, status: 'progress', stage: 'restore-database', message: `Database restored for ${appId}` });
}
