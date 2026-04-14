/**
 * Unified App Updater — Handles both OCI (marketplace) and LXD (native) apps.
 *
 * Supports three update paths:
 *   - OCI: Stop containers → pull new images → rebuild → start → health check
 *   - LXD tarball: apt upgrade → stop service → download tarball → start → health check
 *   - OCI transition: Native app moved to OCI — signals fresh install required
 *
 * Both paths support:
 *   - Migration steps (exec commands, SQL) before container rebuild/replace
 *   - Snapshot-based rollback on failure
 *   - SSE event emission for real-time progress
 *   - Version tracking in installed_apps DB
 *
 * Key design decisions:
 *   - Secrets are ALWAYS preserved across updates (never regenerated)
 *   - Data volumes are preserved by default (configurable via manifest)
 *   - SSO configuration is preserved (Authentik app not recreated)
 *   - LXD updates include apt upgrade (base OS kept current)
 *   - Rollback via Incus snapshots on failure
 */

import { execShell } from '@/lib/incus/server';
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  stopContainer,
  startContainer,
  rebuildContainer,
  upgradeContainerOS,
  getServiceWorkingDir,
  healthCheckViaExec,
  waitForContainerExec,
} from '@/lib/incus/snapshot';
import { fetchManifest, clearCatalogCache } from './catalog';
import { readInstallMetadata } from './metadata';
import { getInstalledApp, updateInstalledVersion } from './installed-apps';
import { resolveVariables, resolveEnvironment } from './variables';
import { buildVariableContext } from './platform-env';
import { getOrCreateSecret } from '../infrastructure/secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { settingsService } from '@/lib/settings';
import { isNewer, compareVersions, sortVersionsDesc } from '@/lib/version';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
  MigrationStep,
  VariableContext,
} from './types';

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

// ─── Image Type Detection ─────────────────────────────────

/**
 * Returns true if the image string is an LXD image (e.g. "debian/12", "ubuntu/24.04").
 * OCI images contain dots in the registry part (e.g. "docker.io/...", "ghcr.io/...").
 */
function isLXDImage(image: string): boolean {
  return /^[a-z]+\/[\d.]+$/.test(image);
}

// ─── Migration Helpers ────────────────────────────────────

function findApplicableMigrations(
  migrations: Array<{ fromVersion: string; toVersion: string; steps: MigrationStep[] }>,
  fromVersion: string,
  toVersion: string
): Array<{ fromVersion: string; toVersion: string; steps: MigrationStep[] }> {
  if (!migrations || migrations.length === 0) return [];

  return migrations
    .filter((m) => {
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
 * For native apps, the container field maps directly to native.containerName.
 */
async function executeMigrationStep(
  step: MigrationStep,
  appId: string,
  totalContainers: number,
  ctx: Partial<VariableContext>,
  nativeContainerName?: string
): Promise<void> {
  if (step.type === 'exec') {
    const containerName = nativeContainerName || getContainerName(appId, step.container, totalContainers);
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

// ─── Gitea Release Helpers (for LXD tarball updates) ─────

const GITEA_API = 'https://git.byka.wtf/api/v1';
const GITEA_ORG = 'potemsla';

interface ReleaseInfo {
  version: string;
  downloadURL: string;
}

async function getReleaseBranch(): Promise<string> {
  try {
    const config = await settingsService.getRaw();
    return config.release_branch || '';
  } catch {
    return '';
  }
}

function isMainTag(tag: string): boolean {
  return /^v\d/.test(tag);
}

/**
 * Get the latest release from Gitea for an LXD app.
 * Branch-aware: checks branch-prefixed tags first, falls back to main.
 */
async function getLatestGiteaRelease(
  containerName: string,
  giteaRepo: string,
  branch?: string,
  tagPrefix?: string
): Promise<ReleaseInfo | null> {
  const releasesURL = `${GITEA_API}/repos/${GITEA_ORG}/${giteaRepo}/releases?limit=50`;

  // Fetch releases from inside the container (has internet access)
  const result = await execShell(
    containerName,
    `curl -sSL '${releasesURL}'`,
    { timeout: 30_000 }
  );

  if (result.exitCode !== 0 || !result.stdout) return null;

  try {
    const allReleases = JSON.parse(result.stdout);
    if (!Array.isArray(allReleases) || allReleases.length === 0) return null;

    const pfx = tagPrefix ? `${tagPrefix}-` : '';
    const releases = pfx
      ? allReleases.filter((r: { tag_name: string }) => r.tag_name.startsWith(pfx))
      : allReleases;

    const stripPfx = (tag: string) => pfx ? tag.slice(pfx.length) : tag;
    const effectiveBranch = branch || '';
    let matchedRelease = null;

    // Collect main releases
    const mainReleases = releases.filter((r: { tag_name: string }) => isMainTag(stripPfx(r.tag_name)));
    let bestMainVersion: string | null = null;
    let bestMainRelease = null;
    if (mainReleases.length > 0) {
      const sortedMain = sortVersionsDesc(
        mainReleases.map((r: { tag_name: string }) => stripPfx(r.tag_name).replace(/^v/, ''))
      );
      bestMainVersion = sortedMain[0];
      bestMainRelease = mainReleases.find(
        (r: { tag_name: string }) => stripPfx(r.tag_name) === `v${bestMainVersion}`
      );
    }

    // Try branch-specific releases
    if (effectiveBranch && effectiveBranch !== 'main') {
      const branchTagPrefix = `${effectiveBranch}-v`;
      const branchReleases = releases.filter((r: { tag_name: string }) =>
        stripPfx(r.tag_name).startsWith(branchTagPrefix)
      );
      if (branchReleases.length > 0) {
        const sortedBranch = sortVersionsDesc(
          branchReleases.map((r: { tag_name: string }) => stripPfx(r.tag_name).replace(branchTagPrefix, ''))
        );
        const bestBranchVersion = sortedBranch[0];
        const bestBranchRelease = branchReleases.find(
          (r: { tag_name: string }) => stripPfx(r.tag_name) === `${branchTagPrefix}${bestBranchVersion}`
        );

        if (bestMainVersion && isNewer(bestMainVersion, bestBranchVersion)) {
          matchedRelease = bestMainRelease;
        } else {
          matchedRelease = bestBranchRelease;
        }
      }
    }

    if (!matchedRelease && bestMainRelease) matchedRelease = bestMainRelease;
    if (!matchedRelease && releases.length > 0) matchedRelease = releases[0];
    if (!matchedRelease) return null;

    // Extract version from tag
    const tag = matchedRelease.tag_name as string || '';
    const strippedTag = stripPfx(tag);
    let version: string;
    if (effectiveBranch && effectiveBranch !== 'main' && strippedTag.startsWith(`${effectiveBranch}-v`)) {
      version = strippedTag.replace(`${effectiveBranch}-v`, '');
    } else {
      version = strippedTag.replace(/^v/, '');
    }

    // Find standalone.tar in assets
    const assets = matchedRelease.assets as Array<{ name: string; browser_download_url: string }>;
    const tarAsset = assets?.find((a) => a.name === 'standalone.tar');
    if (!tarAsset || !version) return null;

    return { version, downloadURL: tarAsset.browser_download_url };
  } catch {
    return null;
  }
}

// ─── LXD Tarball Update ──────────────────────────────────

/**
 * Update an LXD container by downloading a new release tarball.
 * Includes apt upgrade to keep base OS current.
 */
async function updateLXDContainer(
  containerName: string,
  giteaRepo: string,
  appDir: string,
  serviceName: string,
  port: number,
  healthEndpoint: string,
  tagPrefix: string | undefined,
  onEvent: InstallEventCallback,
  step: number,
  totalSteps: number,
): Promise<{ step: number; version: string }> {
  // Resolve real app dir from systemd service
  const resolvedDir = await getServiceWorkingDir(containerName, serviceName, appDir);
  if (resolvedDir !== appDir) {
    emit(onEvent, step, totalSteps, 'running', `Service runs from ${resolvedDir} (configured: ${appDir})`);
  }

  const branch = await getReleaseBranch();

  // Get latest release
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Fetching latest release from Gitea...');
  const release = await getLatestGiteaRelease(containerName, giteaRepo, branch, tagPrefix);
  if (!release) throw new Error('Could not fetch latest release from Gitea');
  emit(onEvent, step, totalSteps, 'success', `Latest version: v${release.version}`);

  // Upgrade base OS packages
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Upgrading system packages...');
  try {
    await upgradeContainerOS(containerName);
    emit(onEvent, step, totalSteps, 'success', 'System packages upgraded');
  } catch (err) {
    // Non-fatal — log and continue (app update is more important)
    emit(onEvent, step, totalSteps, 'success', `System upgrade skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stop systemd service (NOT the container)
  step++;
  emit(onEvent, step, totalSteps, 'running', `Stopping ${serviceName} service...`);
  await execShell(containerName, `systemctl stop ${serviceName}`, { timeout: 30_000 });
  emit(onEvent, step, totalSteps, 'success', `${serviceName} stopped`);

  // Download new tarball
  step++;
  emit(onEvent, step, totalSteps, 'running', `Downloading v${release.version}...`);
  await execShell(containerName, `rm -rf ${resolvedDir}`, { timeout: 30_000 });
  await execShell(containerName, `mkdir -p ${resolvedDir}`, { timeout: 10_000 });

  const downloadResult = await execShell(
    containerName,
    `curl -sSL "${release.downloadURL}" -o /tmp/update.tar`,
    { timeout: 300_000 }
  );
  if (downloadResult.exitCode !== 0) {
    throw new Error(`Download failed: ${downloadResult.stderr}`);
  }
  emit(onEvent, step, totalSteps, 'success', 'Download complete');

  // Extract tarball
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Extracting files...');
  const extractResult = await execShell(
    containerName,
    `tar -xf /tmp/update.tar -C ${resolvedDir} --no-same-owner`,
    { timeout: 60_000 }
  );
  if (extractResult.exitCode !== 0) {
    throw new Error(`Extraction failed: ${extractResult.stderr}`);
  }
  await execShell(containerName, 'rm -f /tmp/update.tar', { timeout: 10_000 });

  // Install styled-jsx (required by Next.js standalone but sometimes missing)
  await execShell(
    containerName,
    `cd ${resolvedDir} && mkdir -p node_modules/styled-jsx && ` +
    `TARBALL=$(curl -sSL https://registry.npmjs.org/styled-jsx/latest | ` +
    `grep -o '"tarball":"[^"]*"' | head -1 | cut -d'"' -f4) && ` +
    `[ -n "$TARBALL" ] && curl -sSL "$TARBALL" | tar -xzf - -C node_modules/styled-jsx --strip-components=1 || true`,
    { timeout: 30_000 }
  );
  emit(onEvent, step, totalSteps, 'success', 'Files extracted');

  // Start service
  step++;
  emit(onEvent, step, totalSteps, 'running', `Starting ${serviceName} service...`);
  await execShell(containerName, `systemctl start ${serviceName}`, { timeout: 30_000 });
  emit(onEvent, step, totalSteps, 'success', `${serviceName} started`);

  // Health check
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Verifying app is running...');
  await healthCheckViaExec(containerName, port, healthEndpoint, 15);
  emit(onEvent, step, totalSteps, 'success', 'Health check passed');

  return { step, version: release.version };
}

// ─── Main Update Function ─────────────────────────────────

const SNAPSHOT_PREFIX = 'pre-update';

/**
 * Update an installed app to the latest version from the catalog.
 * Handles both OCI (marketplace) and LXD (native) apps through a unified flow.
 *
 * Flow:
 *   1. Fetch latest manifest from catalog, compare versions
 *   2. Rebuild variable context (preserving existing secrets)
 *   3. Snapshot container(s) — rollback point
 *   4. If strategy=migrate: run migration steps while containers are still running
 *   5a. OCI path: stop → rebuild with new image → start → health check
 *   5b. LXD path: apt upgrade → stop service → download tarball → start → health check
 *   6. Update installed version in DB
 *   7. Cleanup snapshots
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
  if (!installedApp) throw new Error(`App "${appId}" is not installed`);

  const installMeta = await readInstallMetadata(appId);
  if (!installMeta) throw new Error(`No install metadata found for "${appId}"`);

  clearCatalogCache();

  let manifest: AppManifest;
  try {
    manifest = await fetchManifest(appId);
  } catch (err) {
    throw new Error(`Failed to fetch manifest for "${appId}": ${err}`);
  }

  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = manifest.version || '0.0.0';
  const isNativeApp = !!manifest.native;

  if (!config.force && !isNewer(targetVersion, installedVersion)) {
    emit(onEvent, 1, 1, 'success', `${appId} is already up to date (v${installedVersion})`);
    return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0 };
  }

  // ── OCI transition detection ────────────────────────────
  // If a native app's manifest now uses an OCI image, it needs a fresh install
  if (isNativeApp && !isLXDImage(manifest.native!.image)) {
    emit(onEvent, 1, 1, 'error',
      `${appId} has been converted to OCI packaging. Please uninstall and reinstall for the new format.`);
    return {
      success: false, previousVersion: installedVersion, newVersion: targetVersion,
      migrationsRun: 0, error: 'OCI conversion requires fresh install',
    };
  }

  // ── Determine update path ──────────────────────────────

  const strategy = manifest.update?.strategy || 'replace';
  const containerSpecs = manifest.containers || [];

  // For native apps, the container name comes from manifest.native
  const nativeContainerName = isNativeApp ? manifest.native!.containerName : undefined;
  const containerNames = isNativeApp
    ? [nativeContainerName!]
    : containerSpecs.map((c) => getContainerName(appId, c.name, containerSpecs.length));

  // ── Count total steps ──────────────────────────────────

  const migrations = strategy === 'migrate'
    ? findApplicableMigrations(manifest.update?.migrations || [], installedVersion, targetVersion)
    : [];
  const migrationStepCount = migrations.reduce((sum, m) => sum + m.steps.length, 0);

  let totalSteps = 1; // preflight
  totalSteps += containerNames.length; // snapshots
  totalSteps += migrationStepCount; // migration steps

  if (isNativeApp) {
    // LXD path: fetch release + apt upgrade + stop service + download + extract + start + health
    totalSteps += 7;
  } else {
    // OCI path: stop + rebuild + start + health per container
    totalSteps += containerNames.length * 3; // stop + rebuild + start
    totalSteps += containerSpecs.filter((c) => c.healthCheck).length; // health checks
  }
  totalSteps += 2; // save metadata + cleanup

  let step = 0;

  // ── Step 1: Preflight ──────────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running',
    `Updating ${appId} from v${installedVersion} to v${targetVersion} (${isNativeApp ? 'LXD' : 'OCI'}, strategy: ${strategy})`);

  // Build variable context — preserves existing secrets
  const ctx = await buildVariableContext(
    { appId, subdomain: installMeta.subdomain, domain: installMeta.domain },
    manifest
  );
  if (!ctx.secrets) ctx.secrets = {};

  // Reload existing secrets
  for (const secret of manifest.secrets) {
    try {
      const value = await getOrCreateSecret(`app-${appId}`, secret.file, () => '');
      if (value) ctx.secrets[secret.name] = value;
    } catch { /* secret may not exist */ }
  }

  emit(onEvent, step, totalSteps, 'success', 'Preflight checks passed');

  try {
    // ── Step 2: Snapshot container(s) ─────────────────────

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
          await executeMigrationStep(migrationStep, appId, containerSpecs.length, ctx, nativeContainerName);
          emit(onEvent, step, totalSteps, 'success', stepDesc);
        }
      }
    }

    // ── Step 4/5: Update path (OCI or LXD) ───────────────

    if (isNativeApp) {
      // ── LXD path ──────────────────────────────────────
      const native = manifest.native!;
      const giteaRepo = native.repo.includes('/') ? native.repo.split('/').pop()! : native.repo;
      const appDir = native.appDir || '/opt/app';
      const healthEndpoint = native.healthCheck?.type === 'http'
        ? (native.healthCheck.path || '/api/health')
        : '/api/health';
      const port = native.port || 3000;

      // Derive tag prefix from repo structure (monorepo components use prefixes)
      const tagPrefix = undefined; // standalone repos don't use tag prefixes

      const result = await updateLXDContainer(
        nativeContainerName!, giteaRepo, appDir, nativeContainerName!,
        port, healthEndpoint, tagPrefix, onEvent, step, totalSteps
      );
      step = result.step;
    } else {
      // ── OCI path ──────────────────────────────────────

      // Stop all containers
      for (const name of containerNames) {
        step++;
        emit(onEvent, step, totalSteps, 'running', `Stopping ${name}...`);
        await stopContainer(name);
        emit(onEvent, step, totalSteps, 'success', `${name} stopped`);
      }

      // Rebuild containers with new images
      // Incus rebuild requires no snapshots — delete before rebuild
      for (let i = 0; i < containerSpecs.length; i++) {
        const spec = containerSpecs[i];
        const name = containerNames[i];
        step++;
        emit(onEvent, step, totalSteps, 'running', `Rebuilding ${name} with ${spec.image}...`);
        await deleteSnapshot(name, SNAPSHOT_PREFIX);
        await rebuildContainer(name, spec.image);
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);
      }

      // Start all containers
      for (const name of containerNames) {
        step++;
        emit(onEvent, step, totalSteps, 'running', `Starting ${name}...`);
        await startContainer(name);
        emit(onEvent, step, totalSteps, 'success', `${name} started`);
      }

      // Health checks
      for (let i = 0; i < containerSpecs.length; i++) {
        const spec = containerSpecs[i];
        const name = containerNames[i];
        if (!spec.healthCheck) continue;

        step++;
        emit(onEvent, step, totalSteps, 'running', `Waiting for ${name} to be healthy...`);

        let healthy = false;
        if (spec.healthCheck.type === 'http') {
          healthy = await waitForAppHealth(name, spec.port || 80, spec.healthCheck.path, spec.healthCheck.timeout);
        } else if (spec.healthCheck.type === 'postgres') {
          healthy = await waitForPostgresHealth(name, spec.healthCheck.user, spec.healthCheck.timeout);
        }

        emit(onEvent, step, totalSteps, healthy ? 'success' : 'error',
          healthy ? `${name} is healthy` : `${name} health check timed out`);
        if (!healthy) throw new Error(`Health check failed for ${name}`);
      }
    }

    // ── Step N-1: Update version in DB ───────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Updating version records...');
    await updateInstalledVersion(appId, targetVersion);
    emit(onEvent, step, totalSteps, 'success', 'Version updated');

    // ── Step N: Cleanup snapshots ────────────────────────

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
    emit(onEvent, step, totalSteps, 'error', `Update failed, rolling back: ${errMsg}`);

    // ── Rollback ─────────────────────────────────────────
    for (const name of containerNames) {
      try {
        await restoreSnapshot(name, SNAPSHOT_PREFIX);
      } catch {
        // Snapshot may have been deleted (OCI rebuild requires it)
      }
      try {
        if (isNativeApp) {
          // For LXD, container is still running — wait for exec readiness after restore
          await waitForContainerExec(name, 30);
        } else {
          await startContainer(name);
        }
      } catch (rollbackErr) {
        console.error(`[updater] Rollback failed for ${name}:`, rollbackErr);
      }
      // Clean up snapshot after rollback
      await deleteSnapshot(name, SNAPSHOT_PREFIX);
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
