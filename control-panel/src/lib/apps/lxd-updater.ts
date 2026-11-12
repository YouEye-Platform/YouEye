/**
 * LXD Container Updater (managed Pointer)
 *
 * Updates LXD containers (full Debian OS with Node.js apps) that are registered
 * in the AppDefinition system (definitions.ts). Uses snapshot → update → verify
 * → rollback pattern, operating on systemd services inside containers.
 *
 * NOTE: Market-installed native apps go through market/updater.ts which
 * provides migration support, variable context, and DB version tracking.
 * This file handles infrastructure LXD apps (UI) and legacy definitions.
 *
 * Includes apt upgrade to keep base OS current inside LXD containers.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appUpdateJournalStore, withAppLifecycle } from '@/lib/market/update-admission';
import { resolveNativeProduct, stageVerifiedProductArtifact } from '@/lib/market/native-artifact';
import { acceptProductSequence, productReceipt } from '@/lib/releases/product-release';
import { publishProductProjection, verifyProductProjection } from '@/lib/releases/product-projection';
import { pointerRelease, readPointerReleaseState, savePointerReleaseState, updateIdenticalPointerRelease } from '@/lib/pointer/release-metadata';
import { execShell, incusUploadFile } from '@/lib/incus/server';
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  waitForContainerExec,
  getServiceWorkingDir,
  upgradeContainerOS,
  healthCheckViaExec,
} from '@/lib/incus/snapshot';
import { type AppDefinition } from './definitions';
import { markAppUpdated } from './update-cache';
import type { UpdateEvent } from './updater';
export type { UpdateEvent };
import { injectCaddyRootCA } from '@/lib/market/caddy-ca';
import { configurePointerService } from '@/lib/pointer/lifecycle';

type EventEmitter = (event: UpdateEvent) => void;

const SNAPSHOT_NAME = 'pre-update';
// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update a Control-Panel-managed LXD app to the release its product has on
 * the box's channel. Only Pointer qualifies: the UI is a member of the
 * System release and updates with it.
 */
export async function updateLXDApp(appDef: AppDefinition, emit: EventEmitter): Promise<void> {
  if (appDef.id !== 'pointer') {
    throw new Error(`${appDef.displayName} updates with the System release.`);
  }
  return withAppLifecycle(appDef.id, () => updateLXDAppUnderLifecycle(appDef, emit));
}

async function updateLXDAppUnderLifecycle(appDef: AppDefinition, emit: EventEmitter): Promise<void> {
  if (!appDef.lxdConfig) throw new Error(`App ${appDef.id} has no lxdConfig`);
  const containerName = appDef.containers[0].name;
  const { appDir: configuredAppDir, serviceName, healthEndpoint, migrationCommand } = appDef.lxdConfig;

  emit({ stage: 'starting', message: `Starting update for ${appDef.displayName}`, progress: 0 });

  // Resolve before any container mutation.
  const selected = await resolveNativeProduct('pointer');
  const before = await readPointerReleaseState();
  const installed = pointerRelease(before);
  if (installed?.manifestSHA256 === selected.manifestSHA256) {
    emit({ stage: 'completed', message: `${appDef.displayName} is already up to date (${selected.release.version})`, progress: 100 });
    return;
  }
  acceptProductSequence(before.floors, selected);
  if (await updateIdenticalPointerRelease(appUpdateJournalStore(), selected)) {
    markAppUpdated(appDef.id);
    emit({ stage: 'completed', message: `${appDef.displayName} release label updated to ${selected.release.version}`, progress: 100 });
    return;
  }

  const appDir = await getServiceWorkingDir(containerName, serviceName, configuredAppDir);
  emit({ stage: 'starting', message: `Current version: ${installed?.release.version ?? 'unknown'}`, progress: 5 });
  emit({ stage: 'starting', message: `Installing ${selected.release.tag}`, progress: 10 });

  emit({ stage: 'snapshot', message: `Creating snapshot of ${containerName}`, container: containerName, progress: 15 });
  await createSnapshot(containerName, SNAPSHOT_NAME);
  let stagedDirectory: string | undefined;

  try {
    try {
      await injectCaddyRootCA(containerName);
      emit({ stage: 'starting', message: `Caddy root CA trusted in ${containerName}`, progress: 18 });
    } catch (err) {
      emit({ stage: 'starting', message: `Caddy root CA trust repair skipped: ${err instanceof Error ? err.message : String(err)}`, progress: 18 });
    }

    // Download and verify the complete archive before stopping services or replacing files.
    emit({ stage: 'rebuilding', message: `Downloading ${selected.release.version}`, container: containerName, progress: 20 });
    stagedDirectory = await mkdtemp(join(tmpdir(), 'youeye-pointer-release-'));
    const staged = await stageVerifiedProductArtifact(stagedDirectory, containerName, selected);
    await incusUploadFile(containerName, '/tmp/update.tar', await readFile(staged.path), { mode: '0600' });
    const digest = await execShell(containerName, 'sha256sum /tmp/update.tar', { timeout: 30_000 });
    if (digest.exitCode !== 0 || digest.stdout.split(/\s+/)[0] !== staged.artifactSHA256) throw new Error('Pointer upload differs from verified artifact');
    emit({ stage: 'rebuilding', message: 'Release artifact digest verified', container: containerName, progress: 30 });

    emit({ stage: 'rebuilding', message: 'Upgrading system packages...', container: containerName, progress: 35 });
    try {
      await upgradeContainerOS(containerName);
    } catch (err) {
      emit({ stage: 'rebuilding', message: `System upgrade skipped: ${err instanceof Error ? err.message : String(err)}`, progress: 38 });
    }

    emit({ stage: 'stopping', message: `Stopping ${serviceName} service`, container: containerName, progress: 40 });
    await execShell(containerName, `systemctl stop ${serviceName}`, { timeout: 30_000 });
    await execShell(containerName, `rm -rf ${appDir}`, { timeout: 30_000 });
    await execShell(containerName, `mkdir -p ${appDir}`, { timeout: 10_000 });

    emit({ stage: 'rebuilding', message: 'Extracting files', container: containerName, progress: 55 });
    const extractResult = await execShell(containerName, `tar -xf /tmp/update.tar -C ${appDir} --no-same-owner`, { timeout: 60_000 });
    if (extractResult.exitCode !== 0) throw new Error(`Extraction failed: ${extractResult.stderr}`);
    await execShell(containerName, 'rm -f /tmp/update.tar', { timeout: 10_000 });

    if (migrationCommand) {
      emit({ stage: 'rebuilding', message: 'Applying database migrations', container: containerName, progress: 65 });
      const migration = await execShell(containerName, migrationCommand, { timeout: 120_000 });
      if (migration.exitCode !== 0) throw new Error('Database migration failed');
    }

    await configurePointerService();
    emit({ stage: 'starting-container', message: `Starting ${serviceName} service`, container: containerName, progress: 70 });
    await execShell(containerName, `systemctl start ${serviceName}`, { timeout: 30_000 });

    emit({ stage: 'verifying', message: 'Verifying app is running', container: containerName, progress: 80 });
    await healthCheckViaExec(containerName, appDef.webPort ?? 3000, healthEndpoint || '/api/health', 15);

    const receipt = productReceipt(selected);
    const runtimeUUID = await publishProductProjection(containerName, receipt);
    await verifyProductProjection(containerName, receipt, runtimeUUID);
    await savePointerReleaseState({ schema: 'youeye.installed-pointer.v1', installed: { receipt, runtimeUUID, acceptedAt: new Date().toISOString() }, floors: acceptProductSequence(before.floors, selected) });

    await deleteSnapshot(containerName, SNAPSHOT_NAME);
    markAppUpdated(appDef.id);
    emit({ stage: 'completed', message: `${appDef.displayName} updated to ${selected.release.version}`, progress: 100 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    emit({ stage: 'rolling-back', message: `Update failed, rolling back: ${errMsg}`, container: containerName });
    try {
      await restoreSnapshot(containerName, SNAPSHOT_NAME);
      await waitForContainerExec(containerName, 30);
      const current = await readPointerReleaseState();
      await savePointerReleaseState({ ...before, floors: current.floors });
      if (before.installed) await verifyProductProjection(containerName, before.installed.receipt, before.installed.runtimeUUID);
      await deleteSnapshot(containerName, SNAPSHOT_NAME);
    } catch (rollbackErr) {
      console.error(`[lxd-updater] Rollback failed for ${containerName}:`, rollbackErr);
    }
    emit({ stage: 'failed', message: errMsg, error: errMsg, progress: 0 });
    throw error;
  } finally {
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
  }
}
