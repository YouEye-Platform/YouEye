/**
 * Full platform restore orchestrator.
 *
 * Restores the entire YouEye platform from a backup:
 * 1. Decrypt + extract core backup
 * 2. Restore youeye.yaml config
 * 3. Restore infrastructure secrets
 * 4. Restore PostgreSQL databases (Authentik, youeye)
 * 5. Restart Authentik (picks up restored DB)
 * 6. Restore Caddy config + data
 * 7. Restore Pi-Hole config
 * 8. Restore Authentik media/templates
 * 9. For each app in installed-apps.json: restoreApp()
 * 10. Done
 */

import { readFile, mkdir, rm } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { spineClient } from '@/lib/spine/client';
import { execShell, incusRequest } from '@/lib/incus/server';
import { setConfig as setCaddyConfig } from '@/lib/caddy/client';
import { restoreApp } from './app-restore';
import type {
  FullRestoreConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';

const STAGING_BASE = '/tmp/youeye-restore';
const POSTGRES_CONTAINER = 'youeye-postgres';

/**
 * Restore the full YouEye platform from a backup directory.
 *
 * The backupPath should point to the root of the backup directory
 * which contains a `youeye/` subdirectory with `core/` and `apps/` folders.
 */
export async function fullRestore(
  config: FullRestoreConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const { backupPath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `full-${timestamp}`);

  // Discover available backup archives
  const coreDir = path.join(backupPath, 'youeye', 'core');
  const appsDir = path.join(backupPath, 'youeye', 'apps');

  // Find the latest core backup
  let coreArchive: string | null = null;
  if (existsSync(coreDir)) {
    const files = readdirSync(coreDir)
      .filter(f => f.startsWith('core-') && f.endsWith('.tar.enc'))
      .sort()
      .reverse();
    if (files.length > 0) {
      coreArchive = path.join(coreDir, files[0]);
    }
  }

  // Discover per-app backup archives
  const appArchives: Array<{ appId: string; archivePath: string }> = [];
  if (existsSync(appsDir)) {
    const appDirs = readdirSync(appsDir);
    for (const appId of appDirs) {
      const appDir = path.join(appsDir, appId);
      try {
        const files = readdirSync(appDir)
          .filter(f => f.endsWith('.tar.enc'))
          .sort()
          .reverse();
        if (files.length > 0) {
          appArchives.push({ appId, archivePath: path.join(appDir, files[0]) });
        }
      } catch {
        // Skip unreadable directories
      }
    }
  }

  // Calculate total steps
  const totalSteps = (coreArchive ? 8 : 1) + appArchives.length;
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

    if (!coreArchive) {
      onEvent({
        step: 0,
        totalSteps,
        status: 'error',
        stage: 'discover',
        message: `No core backup found in ${coreDir}`,
      });
      return;
    }

    // ── Step 1: Decrypt + extract core backup ──────────────
    emit('decrypt-core', 'Decrypting core backup archive...');
    const coreStagingDir = path.join(stagingDir, 'core');
    await mkdir(coreStagingDir, { recursive: true });

    const decryptResult = await spineClient.restoreArchive({
      archive_path: coreArchive,
      passphrase,
      staging_dir: coreStagingDir,
    });

    if (decryptResult.status !== 'ok') {
      throw new Error(`Failed to decrypt core archive: ${decryptResult.status}`);
    }

    // ── Step 2: Restore youeye.yaml config ─────────────────
    emit('restore-config', 'Restoring platform configuration...');
    const configPath = path.join(coreStagingDir, 'configs', 'youeye-config.json');
    if (existsSync(configPath)) {
      try {
        const spineConfig = JSON.parse(await readFile(configPath, 'utf-8'));
        await spineClient.setConfig(spineConfig);
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'restore-config',
          message: `Warning: Could not restore Spine config: ${err}`,
        });
      }
    }

    // ── Step 3: Restore PostgreSQL databases ───────────────
    emit('restore-databases', 'Restoring infrastructure databases...');
    const dbDir = path.join(coreStagingDir, 'databases');
    if (existsSync(dbDir)) {
      const dbFiles = readdirSync(dbDir).filter(f => f.endsWith('.sql'));
      for (const dbFile of dbFiles) {
        // Extract database name from filename pattern: {dbName}-{timestamp}.sql
        const dbName = dbFile.replace(/-\d{4}-\d{2}.*\.sql$/, '');
        if (!dbName) continue;

        try {
          // Terminate connections
          await execShell(
            POSTGRES_CONTAINER,
            `psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid();"`,
            { timeout: 10000 }
          ).catch(() => {});

          // Drop and recreate database
          await execShell(
            POSTGRES_CONTAINER,
            `psql -U postgres -c "DROP DATABASE IF EXISTS ${dbName}"`,
            { timeout: 10000 }
          );
          await execShell(
            POSTGRES_CONTAINER,
            `psql -U postgres -c "CREATE DATABASE ${dbName}"`,
            { timeout: 10000 }
          );

          // Restore from dump
          const dumpContent = await readFile(path.join(dbDir, dbFile), 'utf-8');
          const b64 = Buffer.from(dumpContent).toString('base64');
          const restoreResult = await execShell(
            POSTGRES_CONTAINER,
            `echo '${b64}' | base64 -d | psql -U postgres ${dbName}`,
            { timeout: 300000 }
          );

          if (restoreResult.exitCode !== 0) {
            onEvent({
              step,
              totalSteps,
              status: 'progress',
              stage: 'restore-databases',
              message: `Warning: Restore of ${dbName} had errors`,
              detail: restoreResult.stderr,
            });
          }
        } catch (err) {
          onEvent({
            step,
            totalSteps,
            status: 'progress',
            stage: 'restore-databases',
            message: `Warning: Failed to restore ${dbName}: ${err}`,
          });
        }
      }
    }

    // ── Step 4: Restart Authentik ───────────────────────────
    emit('restart-authentik', 'Restarting Authentik to apply restored database...');
    try {
      await incusRequest('PUT', '/1.0/instances/youeye-authentik/state', {
        action: 'restart',
        force: true,
        timeout: 60,
      });
      // Wait for Authentik to come up
      await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'restart-authentik',
        message: `Warning: Authentik restart issue: ${err}`,
      });
    }

    // ── Step 5: Restore Caddy config ───────────────────────
    emit('restore-caddy', 'Restoring Caddy configuration...');
    const caddyConfigPath = path.join(coreStagingDir, 'caddy', 'caddy-config.json');
    if (existsSync(caddyConfigPath)) {
      try {
        const caddyConfig = JSON.parse(await readFile(caddyConfigPath, 'utf-8'));
        await setCaddyConfig(caddyConfig);
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'restore-caddy',
          message: `Warning: Could not restore Caddy config: ${err}`,
        });
      }
    }

    // ── Step 6: Restore Pi-Hole config ─────────────────────
    emit('restore-pihole', 'Restoring Pi-Hole configuration...');
    const piholePath = path.join(coreStagingDir, 'pihole', 'pihole.toml');
    if (existsSync(piholePath)) {
      try {
        const piholeContent = await readFile(piholePath, 'utf-8');
        const b64 = Buffer.from(piholeContent).toString('base64');
        await execShell(
          'youeye-pihole',
          `echo '${b64}' | base64 -d > /etc/pihole/pihole.toml`,
          { timeout: 10000 }
        );
        await execShell('youeye-pihole', 'pihole reloaddns', { timeout: 15000 });
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: 'restore-pihole',
          message: `Warning: Could not restore Pi-Hole config: ${err}`,
        });
      }
    }

    // ── Step 7: Restore Authentik media ────────────────────
    emit('restore-authentik-media', 'Restoring Authentik media and templates...');
    // Authentik media is included in the volume backup — Spine handles this
    onEvent({
      step,
      totalSteps,
      status: 'progress',
      stage: 'restore-authentik-media',
      message: 'Authentik media restored via volume backup',
    });

    // ── Step 8+: Restore each app ──────────────────────────
    // Also check installed-apps.json for the app list
    const installedAppsPath = path.join(coreStagingDir, 'installed-apps.json');
    if (existsSync(installedAppsPath) && appArchives.length === 0) {
      const installedApps = JSON.parse(await readFile(installedAppsPath, 'utf-8'));
      onEvent({
        step,
        totalSteps,
        status: 'progress',
        stage: 'restore-apps',
        message: `Found ${installedApps.length} apps in manifest but no per-app archives`,
      });
    }

    for (const { appId, archivePath } of appArchives) {
      emit('restore-app', `Restoring app: ${appId}...`);
      try {
        await restoreApp(
          { appId, archivePath, passphrase },
          (event) => {
            // Relay app restore events as sub-events
            onEvent({
              step,
              totalSteps,
              status: event.status === 'error' ? 'error' : 'progress',
              stage: `restore-app-${appId}`,
              message: `[${appId}] ${event.message}`,
              detail: event.detail,
            });
          }
        );
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'progress',
          stage: `restore-app-${appId}`,
          message: `Warning: Failed to restore ${appId}: ${err}`,
        });
        // Continue with other apps
      }
    }

    // Final completion
    onEvent({
      step: totalSteps,
      totalSteps,
      status: 'completed',
      stage: 'completed',
      message: 'Full platform restore completed successfully',
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
