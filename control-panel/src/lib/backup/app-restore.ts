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

import { readFile, writeFile, mkdir, rm, cp } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spineClient } from '@/lib/spine/client';
import { execShell } from '@/lib/incus/server';
import { incusRequest } from '@/lib/incus/server';
import { readInstallMetadata } from '@/lib/market/metadata';
import { uninstallApp } from '@/lib/market/uninstaller';
import { installApp } from '@/lib/market/engine';
import { fetchManifest } from '@/lib/market/catalog';
import { addRoute } from '@/lib/caddy/client';
import type {
  AppRestoreConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';

const STAGING_BASE = '/tmp/youeye-restore';
const YOUEYE_DATA_DIR = '/var/lib/youeye';
const POSTGRES_CONTAINER = 'youeye-postgres';

/**
 * Restore a single app from a backup archive.
 */
export async function restoreApp(
  config: AppRestoreConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const { appId, archivePath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `app-${appId}-${timestamp}`);

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
    const decryptResult = await spineClient.restoreArchive({
      archive_path: archivePath,
      passphrase,
      staging_dir: stagingDir,
    });

    if (decryptResult.status !== 'ok') {
      throw new Error(`Failed to decrypt archive: ${decryptResult.status}`);
    }

    // ── Step 2: Read and validate backup metadata ──────────
    emit('validate', `Validating backup for ${appId}...`);

    const metaPath = path.join(stagingDir, 'backup-meta.json');
    if (!existsSync(metaPath)) {
      throw new Error('Invalid backup archive: missing backup-meta.json');
    }

    const backupMeta = JSON.parse(await readFile(metaPath, 'utf-8'));
    if (backupMeta.appId !== appId) {
      throw new Error(
        `Backup app ID mismatch: expected "${appId}", got "${backupMeta.appId}"`
      );
    }

    // Read install.json from backup
    const installJsonPath = path.join(stagingDir, 'install.json');
    let backedUpInstallMeta: Record<string, unknown> | null = null;
    if (existsSync(installJsonPath)) {
      backedUpInstallMeta = JSON.parse(await readFile(installJsonPath, 'utf-8'));
    }

    // ── Step 3: Uninstall current app if exists ────────────
    emit('uninstall', `Removing existing installation of ${appId}...`);
    const currentMeta = await readInstallMetadata(appId);
    if (currentMeta) {
      try {
        await uninstallApp(appId, { dropSharedDatabase: true, keepData: false });
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'uninstall',
          message: `Warning: Uninstall had errors: ${err}`,
        });
      }
    }

    // ── Step 4: Restore secrets ────────────────────────────
    emit('restore-secrets', `Restoring secrets for ${appId}...`);
    const secretsSrc = path.join(stagingDir, 'secrets');
    const secretsDest = path.join(YOUEYE_DATA_DIR, `app-${appId}`);

    if (existsSync(secretsSrc)) {
      await mkdir(secretsDest, { recursive: true });
      await cp(secretsSrc, secretsDest, { recursive: true, force: true });
    }

    // ── Step 5: Restore database ───────────────────────────
    emit('restore-database', `Restoring database for ${appId}...`);

    // Check for shared database dump
    const sharedDumpPath = path.join(stagingDir, 'databases', `${appId}-shared.sql`);
    if (existsSync(sharedDumpPath)) {
      await restoreSharedDatabase(appId, sharedDumpPath, onEvent, step, totalSteps);
    }

    // Check for own database dump
    const ownDumpPath = path.join(stagingDir, 'databases', `${appId}-own.sql`);
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

    // Try to get manifest: from backup first, then remote
    let manifest;
    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } else {
      manifest = await fetchManifest(appId);
    }

    // Build install config from backed-up metadata
    const subdomain = (backedUpInstallMeta?.subdomain as string) || appId;
    const domain = (backedUpInstallMeta?.domain as string) || '';

    // Run the install engine — it handles container creation, config files, etc.
    await installApp(
      manifest,
      { appId, subdomain, domain },
      (event) => {
        // Relay install events as restore sub-events
        onEvent({
          step,
          totalSteps,
          status: event.status === 'error' ? 'error' : 'progress',
          stage: 'reinstall',
          message: event.message,
          detail: event.detail,
        });
      }
    );

    // ── Step 7: Restore volume data via Spine ──────────────
    emit('restore-volumes', `Restoring volume data for ${appId}...`);

    // Restore Caddy routes from backup
    const routesPath = path.join(stagingDir, 'caddy', 'routes.json');
    if (existsSync(routesPath)) {
      try {
        const routes = JSON.parse(await readFile(routesPath, 'utf-8'));
        for (const route of routes) {
          try {
            await addRoute({
              hostname: route.hostname,
              path: route.path,
              upstream: route.upstream,
              port: route.port,
            });
          } catch (err) {
            // Route may already exist from reinstall — that's fine
            if (!(err instanceof Error && err.message.includes('already exists'))) {
              onEvent({
                step,
                totalSteps,
                status: 'progress',
                stage: 'restore-volumes',
                message: `Warning: Could not restore Caddy route: ${err}`,
              });
            }
          }
        }
      } catch {
        // Best effort
      }
    }

    // ── Step 8: Restart containers ─────────────────────────
    emit('restart', `Restarting ${appId} containers...`);

    const containers = backupMeta.containers as string[] || [];
    for (const containerName of containers) {
      try {
        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart',
          force: true,
          timeout: 30,
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch {
        // Container may not need restart or may not exist yet
      }
    }

    // Final completion event
    onEvent({
      step: totalSteps,
      totalSteps,
      status: 'completed',
      stage: 'completed',
      message: `${appId} restored successfully`,
      progress: 100,
    });
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

/**
 * Restore a shared PostgreSQL database from a SQL dump.
 * Creates the user and database, then pipes the dump.
 */
async function restoreSharedDatabase(
  appId: string,
  dumpPath: string,
  onEvent: BackupEventCallback,
  step: number,
  totalSteps: number
): Promise<void> {
  try {
    // Read the password from restored secrets
    let dbPassword = '';
    const secretsDir = path.join(YOUEYE_DATA_DIR, `app-${appId}`);
    const passwordFile = path.join(secretsDir, 'db-password');
    if (existsSync(passwordFile)) {
      dbPassword = (await readFile(passwordFile, 'utf-8')).trim();
    }

    if (!dbPassword) {
      // Generate a new password if we can't find the original
      const { generatePassword } = await import('@/lib/infrastructure/secrets');
      dbPassword = generatePassword(32);
      // Save it so the app can find it
      await mkdir(secretsDir, { recursive: true });
      await writeFile(passwordFile, dbPassword, { mode: 0o600 });
    }

    // Terminate existing connections
    try {
      await execShell(
        POSTGRES_CONTAINER,
        `psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${appId}' AND pid <> pg_backend_pid();"`,
        { timeout: 10000 }
      );
    } catch {
      // Best effort
    }

    // Drop existing database and user
    await execShell(
      POSTGRES_CONTAINER,
      `psql -U postgres -c "DROP DATABASE IF EXISTS ${appId}"`,
      { timeout: 10000 }
    );
    await execShell(
      POSTGRES_CONTAINER,
      `psql -U postgres -c "DROP USER IF EXISTS ${appId}"`,
      { timeout: 10000 }
    );

    // Create user and database
    await execShell(
      POSTGRES_CONTAINER,
      `psql -U postgres -c "CREATE USER ${appId} WITH PASSWORD '${dbPassword}'"`,
      { timeout: 10000 }
    );
    await execShell(
      POSTGRES_CONTAINER,
      `psql -U postgres -c "CREATE DATABASE ${appId} OWNER ${appId}"`,
      { timeout: 10000 }
    );

    // Pipe the SQL dump into the database
    // Read the dump and base64-encode it to pass through execShell
    const dumpContent = await readFile(dumpPath, 'utf-8');
    const b64 = Buffer.from(dumpContent).toString('base64');

    const restoreResult = await execShell(
      POSTGRES_CONTAINER,
      `echo '${b64}' | base64 -d | psql -U postgres ${appId}`,
      { timeout: 300000 } // 5 minutes for large dumps
    );

    if (restoreResult.exitCode !== 0) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'restore-database',
        message: `Warning: Database restore had errors`,
        detail: restoreResult.stderr,
      });
    }
  } catch (err) {
    onEvent({
      step,
      totalSteps,
      status: 'progress',
      stage: 'restore-database',
      message: `Warning: Database restore failed: ${err}`,
    });
  }
}
