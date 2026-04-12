/**
 * App Market Updater — Update engine for marketplace (external) apps.
 *
 * Supports two strategies:
 *   - "replace": Stop containers → pull new images → rebuild → start → health check
 *   - "migrate": Run migration steps (exec commands, SQL) → replace containers
 *
 * Key design decisions:
 *   - Secrets are ALWAYS preserved across updates (never regenerated)
 *   - Data volumes are preserved by default (configurable via manifest)
 *   - SSO configuration is preserved (Authentik app not recreated)
 *   - Rollback via Incus snapshots on failure
 *   - Emits SSE events matching the install flow pattern
 */

import { incusRequest, execShell } from '@/lib/incus/server';
import { fetchManifest, clearCatalogCache } from './catalog';
import { readInstallMetadata } from './metadata';
import { getInstalledApp, updateInstalledVersion } from './installed-apps';
import { resolveVariables, resolveEnvironment } from './variables';
import { buildVariableContext } from './platform-env';
import { getOrCreateSecret } from '../infrastructure/secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
  MigrationStep,
  VariableContext,
} from './types';
import { isNewer, compareVersions } from '@/lib/version';

// ─── Types ────────────────────────────────────────────────

export interface UpdateConfig {
  appId: string;
  /** Force update even if versions match */
  force?: boolean;
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  migrationsRun: number;
  error?: string;
}

// ─── Incus Helpers ────────────────────────────────────────

async function waitForOperation(operationPath: string, timeoutSeconds = 300): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  const resp = await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });
  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (!meta) return;
  if ((meta.status as string) === 'Failure') {
    throw new Error(`Operation failed: ${(meta.err as string) || 'unknown'}`);
  }
}

async function containerState(name: string): Promise<string> {
  try {
    const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${name}/state`);
    return ((resp.metadata as Record<string, unknown>)?.status as string) ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function stopContainer(name: string): Promise<void> {
  if ((await containerState(name)) !== 'Running') return;
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}/state`,
    { action: 'stop', force: true, timeout: 30 }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
}

async function startContainer(name: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}/state`,
    { action: 'start' }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
}

async function createSnapshot(name: string, snapshotName: string): Promise<void> {
  try { await incusRequest('DELETE', `/1.0/instances/${name}/snapshots/${snapshotName}`); } catch { /* ok */ }
  await new Promise((r) => setTimeout(r, 500));
  const resp = await incusRequest<Record<string, unknown>>(
    'POST', `/1.0/instances/${name}/snapshots`,
    { name: snapshotName, stateful: false }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 120);
}

async function restoreSnapshot(name: string, snapshotName: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}`,
    { restore: snapshotName }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 300);
}

async function deleteSnapshot(name: string, snapshotName: string): Promise<void> {
  try {
    const resp = await incusRequest<Record<string, unknown>>(
      'DELETE', `/1.0/instances/${name}/snapshots/${snapshotName}`
    );
    if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
  } catch { /* non-critical */ }
}

/**
 * Rebuild an existing container with a new OCI image.
 * Uses Incus 6.x rebuild API — preserves volumes and config.
 */
async function rebuildContainer(name: string, image: string): Promise<void> {
  // Parse OCI image reference
  const parts = image.split('/');
  const server = parts.length > 1 ? `https://${parts[0]}` : 'https://docker.io';
  const alias = parts.length > 1 ? parts.slice(1).join('/') : parts[0];

  const resp = await incusRequest<Record<string, unknown>>(
    'POST', `/1.0/instances/${name}/rebuild`,
    {
      source: {
        type: 'image',
        mode: 'pull',
        server,
        protocol: 'oci',
        alias,
      },
    },
    { timeout: 660_000 }
  );

  if (resp.error && resp.error !== '') throw new Error(`Rebuild failed: ${resp.error}`);
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 600);
}

// ─── Emit Helper ──────────────────────────────────────────

function emit(
  cb: InstallEventCallback,
  step: number,
  totalSteps: number,
  status: InstallEvent['status'],
  message: string,
  detail?: string
) {
  cb({ step, totalSteps, status, message, detail });
}

// ─── Container Naming ─────────────────────────────────────

function getContainerName(appId: string, containerName: string, totalContainers: number): string {
  return totalContainers === 1 ? `app-${appId}` : `app-${appId}-${containerName}`;
}

// ─── Migration Helpers ────────────────────────────────────

/**
 * Find and sort migration steps that apply to the version transition.
 * Uses semver comparison: finds migrations where fromVersion <= installedVersion
 * and toVersion <= targetVersion, sorted by toVersion ascending.
 */
function findApplicableMigrations(
  migrations: Array<{ fromVersion: string; toVersion: string; steps: MigrationStep[] }>,
  fromVersion: string,
  toVersion: string
): Array<{ fromVersion: string; toVersion: string; steps: MigrationStep[] }> {
  if (!migrations || migrations.length === 0) return [];

  return migrations
    .filter((m) => {
      // Migration applies if:
      // - fromVersion is <= installed version (covers the installed version range)
      // - toVersion is > installed version (actually upgrades something)
      // - toVersion is <= target version (doesn't go past the target)
      const fromCoversInstalled = compareVersions(m.fromVersion, fromVersion) <= 0
        || compareVersions(fromVersion, m.fromVersion) >= 0;
      const toIsUpgrade = isNewer(m.toVersion, fromVersion);
      const toWithinTarget = compareVersions(m.toVersion, toVersion) <= 0;
      return fromCoversInstalled && toIsUpgrade && toWithinTarget;
    })
    .sort((a, b) => compareVersions(a.toVersion, b.toVersion));
}

/**
 * Execute a single migration step.
 */
async function executeMigrationStep(
  step: MigrationStep,
  appId: string,
  totalContainers: number,
  ctx: Partial<VariableContext>
): Promise<void> {
  if (step.type === 'exec') {
    const containerName = getContainerName(appId, step.container, totalContainers);
    const command = resolveVariables(step.command, ctx);
    const result = await execShell(containerName, command, {
      timeout: step.timeout || 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Migration exec failed in ${containerName}: ${result.stderr || result.stdout}`);
    }
  } else if (step.type === 'sql') {
    const dbName = resolveVariables(step.database, ctx);
    const sql = resolveVariables(step.command, ctx);
    const escaped = sql.replace(/'/g, "'\\''");
    const result = await execShell(
      'youeye-postgres',
      `psql -U youeye -d '${dbName}' -c '${escaped}'`,
      { timeout: 30_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Migration SQL failed on ${dbName}: ${result.stderr || result.stdout}`);
    }
  }
}

// ─── Main Update Function ─────────────────────────────────

const SNAPSHOT_PREFIX = 'pre-update';

/**
 * Update an installed marketplace app to the latest version from the catalog.
 *
 * Flow:
 *   1. Fetch latest manifest from catalog
 *   2. Compare versions — skip if already up to date (unless force)
 *   3. Rebuild variable context (preserving existing secrets)
 *   4. Snapshot all containers (rollback point)
 *   5. If strategy=migrate: run migration steps while containers are still running
 *   6. Stop all containers
 *   7. Rebuild containers with new images
 *   8. Start containers
 *   9. Run health checks
 *  10. Update installed version in DB
 *  11. Cleanup snapshots
 *
 * On failure: rollback all containers to pre-update snapshots.
 */
export async function updateMarketplaceApp(
  config: UpdateConfig,
  onEvent: InstallEventCallback
): Promise<UpdateResult> {
  const { appId } = config;

  // ── Preflight checks ────────────────────────────────────

  const installedApp = await getInstalledApp(appId);
  if (!installedApp) {
    throw new Error(`App "${appId}" is not installed`);
  }

  const installMeta = await readInstallMetadata(appId);
  if (!installMeta) {
    throw new Error(`No install metadata found for "${appId}"`);
  }

  // Clear catalog cache to get fresh manifest
  clearCatalogCache();

  let manifest: AppManifest;
  try {
    manifest = await fetchManifest(appId);
  } catch (err) {
    throw new Error(`Failed to fetch manifest for "${appId}": ${err}`);
  }

  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = manifest.version || '0.0.0';

  if (!config.force && !isNewer(targetVersion, installedVersion)) {
    emit(onEvent, 1, 1, 'success', `${appId} is already up to date (v${installedVersion})`);
    return {
      success: true,
      previousVersion: installedVersion,
      newVersion: installedVersion,
      migrationsRun: 0,
    };
  }

  const strategy = manifest.update?.strategy || 'replace';
  const containerSpecs = manifest.containers || [];
  const containerNames = containerSpecs.map((c) =>
    getContainerName(appId, c.name, containerSpecs.length)
  );

  // Count total steps
  const migrations = strategy === 'migrate'
    ? findApplicableMigrations(manifest.update?.migrations || [], installedVersion, targetVersion)
    : [];
  const migrationStepCount = migrations.reduce((sum, m) => sum + m.steps.length, 0);

  let totalSteps = 1; // preflight
  totalSteps += containerNames.length; // snapshots
  totalSteps += migrationStepCount; // migration steps
  totalSteps += containerNames.length; // stop
  totalSteps += containerNames.length; // rebuild
  totalSteps += containerNames.length; // start
  totalSteps += containerSpecs.filter((c) => c.healthCheck).length; // health checks
  totalSteps += 1; // save metadata
  totalSteps += 1; // cleanup

  let step = 0;

  // ── Step 1: Preflight ──────────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running',
    `Updating ${appId} from v${installedVersion} to v${targetVersion} (strategy: ${strategy})`);

  // Build variable context — preserves existing secrets
  const ctx = await buildVariableContext(
    {
      appId,
      subdomain: installMeta.subdomain,
      domain: installMeta.domain,
    },
    manifest
  );
  if (!ctx.secrets) ctx.secrets = {};

  // Reload existing secrets (they were generated at install time)
  for (const secret of manifest.secrets) {
    try {
      const { getOrCreateSecret: getSecret } = await import('../infrastructure/secrets');
      const value = await getSecret(`app-${appId}`, secret.file, () => '');
      if (value) ctx.secrets[secret.name] = value;
    } catch { /* secret may not exist */ }
  }

  emit(onEvent, step, totalSteps, 'success', 'Preflight checks passed');

  try {
    // ── Step 2: Snapshot all containers ───────────────────

    for (const name of containerNames) {
      step++;
      emit(onEvent, step, totalSteps, 'running', `Creating snapshot of ${name}...`);
      await createSnapshot(name, SNAPSHOT_PREFIX);
      emit(onEvent, step, totalSteps, 'success', `Snapshot created for ${name}`);
    }

    // ── Step 3: Run migrations (if strategy=migrate) ─────

    if (strategy === 'migrate' && migrations.length > 0) {
      for (const migration of migrations) {
        for (const migrationStep of migration.steps) {
          step++;
          const stepDesc = migrationStep.type === 'exec'
            ? `Running migration in ${migrationStep.container}`
            : `Running SQL migration on ${migrationStep.database}`;
          emit(onEvent, step, totalSteps, 'running', stepDesc);

          await executeMigrationStep(migrationStep, appId, containerSpecs.length, ctx);
          emit(onEvent, step, totalSteps, 'success', stepDesc);
        }
      }
    }

    // ── Step 4: Stop all containers ──────────────────────

    for (const name of containerNames) {
      step++;
      emit(onEvent, step, totalSteps, 'running', `Stopping ${name}...`);
      await stopContainer(name);
      emit(onEvent, step, totalSteps, 'success', `${name} stopped`);
    }

    // ── Step 5: Rebuild containers with new images ───────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      step++;
      emit(onEvent, step, totalSteps, 'running', `Rebuilding ${name} with ${spec.image}...`);
      await rebuildContainer(name, spec.image);
      emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);
    }

    // ── Step 6: Start all containers ─────────────────────

    for (const name of containerNames) {
      step++;
      emit(onEvent, step, totalSteps, 'running', `Starting ${name}...`);
      await startContainer(name);
      emit(onEvent, step, totalSteps, 'success', `${name} started`);
    }

    // ── Step 7: Health checks ────────────────────────────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];

      if (!spec.healthCheck) continue;

      step++;
      emit(onEvent, step, totalSteps, 'running', `Waiting for ${name} to be healthy...`);

      let healthy = false;
      if (spec.healthCheck.type === 'http') {
        healthy = await waitForAppHealth(
          name,
          spec.port || 80,
          spec.healthCheck.path,
          spec.healthCheck.timeout
        );
      } else if (spec.healthCheck.type === 'postgres') {
        healthy = await waitForPostgresHealth(
          name,
          spec.healthCheck.user,
          spec.healthCheck.timeout
        );
      }

      emit(
        onEvent, step, totalSteps,
        healthy ? 'success' : 'error',
        healthy ? `${name} is healthy` : `${name} health check timed out`
      );

      if (!healthy) throw new Error(`Health check failed for ${name}`);
    }

    // ── Step 8: Update version in DB ─────────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Updating version records...');
    await updateInstalledVersion(appId, targetVersion);
    emit(onEvent, step, totalSteps, 'success', 'Version updated');

    // ── Step 9: Cleanup snapshots ────────────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Cleaning up snapshots...');
    for (const name of containerNames) {
      await deleteSnapshot(name, SNAPSHOT_PREFIX);
    }
    emit(onEvent, step, totalSteps, 'success', 'Snapshots cleaned up');

    emit(onEvent, step, totalSteps, 'success',
      `${appId} updated successfully from v${installedVersion} to v${targetVersion}`);

    return {
      success: true,
      previousVersion: installedVersion,
      newVersion: targetVersion,
      migrationsRun: migrations.length,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // ── Rollback ─────────────────────────────────────────
    emit(onEvent, step, totalSteps, 'error', `Update failed, rolling back: ${errMsg}`);

    for (const name of containerNames) {
      try {
        await restoreSnapshot(name, SNAPSHOT_PREFIX);
        await startContainer(name);
      } catch (rollbackErr) {
        console.error(`[market-updater] Rollback failed for ${name}:`, rollbackErr);
      }
    }

    return {
      success: false,
      previousVersion: installedVersion,
      newVersion: installedVersion,
      error: errMsg,
      migrationsRun: 0,
    };
  }
}
