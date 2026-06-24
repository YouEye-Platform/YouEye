/**
 * Unified App Updater — v2 app engine.
 *
 * Supports two update paths based on container.type:
 *   - LXD (container.type === 'lxd'): fetch tarball from Gitea, extract, restart service
 *   - OCI (container.type === 'oci'): stop → rebuild with new image → start
 *
 * Both paths support:
 *   - Migration steps (exec commands, SQL) before container rebuild/replace
 *   - Pre/post update hooks (exec commands in specified containers)
 *   - Version constraint checking (e.g. major-sequential)
 *   - Snapshot-based rollback on failure
 *   - SSE event emission for real-time progress
 *   - Version tracking in installed_apps DB
 *
 * Key design decisions:
 *   - Secrets are ALWAYS preserved across updates (never regenerated)
 *   - Data volumes are preserved by default (configurable via manifest)
 *   - SSO configuration is preserved (Authentik app not recreated)
 *   - Rollback via Incus snapshots on failure
 */

import { execShell, incusUploadFile } from '@/lib/incus/server';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  stopContainer,
  startContainer,
  rebuildContainer,
  getContainerBaseImage,
  rebuildContainerFromFingerprint,
  getServiceWorkingDir,
  healthCheckViaExec,
  waitForContainerExec,
} from '@/lib/incus/snapshot';
import { fetchManifestFromSource, fetchManifestReferenceFromSource, fetchUpdatePlanMigrationsFromSource, clearCatalogCache } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { getInstalledApp, updateInstalledVersion } from './installed-apps';
import { getContainerName } from './engine-helpers';
import { resolveVariables, resolveEnvironment } from './variables';
import { buildCanonicalContext } from './platform-env';
import { getOrCreateSecret } from '../infrastructure/secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { settingsService } from '@/lib/settings';
import { isNewer, compareVersions, sortVersionsDesc } from '@/lib/version';
import { buildMarketReleasesAPIURL, getMarketReleaseAssetDownloadURL, getMarketSource, type MarketReleaseAsset } from './source';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import {
  describeUpdatePath,
  findApplicableMigrations,
  mergeMigrationSources,
  type MigrationWithSource,
} from './migration-planner';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
  MigrationSpec,
  MigrationStep,
  InstallMetadata,
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

// ─── Version Constraint Helpers ──────────────────────────

function parseMajorVersion(version: string): number {
  const parts = version.replace(/^v/, '').split('.');
  return parseInt(parts[0], 10) || 0;
}

function checkVersionConstraint(
  constraint: string | undefined,
  fromVersion: string,
  toVersion: string
): string | null {
  if (!constraint) return null;
  if (constraint === 'major-sequential') {
    const fromMajor = parseMajorVersion(fromVersion);
    const toMajor = parseMajorVersion(toVersion);
    if (toMajor - fromMajor > 1) {
      return `Version constraint 'major-sequential' violated: cannot jump from major ${fromMajor} to ${toMajor}. Update one major version at a time.`;
    }
  }
  return null;
}

// ─── Update Hook Helpers ─────────────────────────────────

interface UpdateHookStep {
  exec_in: string;
  run: string;
  timeout: number;
}

async function runUpdateHooks(
  hooks: UpdateHookStep[] | undefined,
  appId: string,
  containerSpecs: Array<{ name: string; type: string }>,
  onEvent: InstallEventCallback,
  step: number,
  totalSteps: number,
  label: string
): Promise<number> {
  if (!hooks || hooks.length === 0) return step;
  for (const hook of hooks) {
    step++;
    const containerName = getContainerName(appId, hook.exec_in, containerSpecs.length);
    emit(onEvent, step, totalSteps, 'running', `${label}: ${hook.run.slice(0, 80)}...`);
    const result = await execShell(containerName, hook.run, {
      timeout: hook.timeout || 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`${label} hook failed in ${containerName}: ${result.stderr || result.stdout}`);
    }
    emit(onEvent, step, totalSteps, 'success', `${label} step complete`);
  }
  return step;
}

// ─── Migration Helpers ────────────────────────────────────

async function recordAppliedMigration(
  installMeta: InstallMetadata,
  migration: MigrationWithSource,
): Promise<void> {
  if (!migration.idempotencyKey) return;

  const existing = installMeta.appliedMigrations ?? [];
  if (existing.some((item) => item.key === migration.idempotencyKey)) return;

  installMeta.appliedMigrations = [
    ...existing,
    {
      key: migration.idempotencyKey,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      appliedAt: new Date().toISOString(),
      source: migration.source,
    },
  ];
  await saveInstallMetadata(installMeta);
}

/**
 * Execute a single migration step.
 * Container name is derived from the container spec name via getContainerName.
 */
async function executeMigrationStep(
  step: MigrationStep,
  appId: string,
  totalContainers: number,
  ctx: Partial<VariableContext>,
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

// ─── Gitea Release Helpers (for LXD tarball updates) ─────

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
 * Get the latest release from the CP-owned Market source for an LXD app.
 * Branch-aware: checks branch-prefixed tags first, falls back to main.
 */
async function getLatestGiteaRelease(
  giteaRepo: string,
  branch?: string,
  tagPrefix?: string
): Promise<ReleaseInfo | null> {
  const releaseSource = await getMarketSource();
  const releasesURL = buildMarketReleasesAPIURL(releaseSource, giteaRepo);

  try {
    const res = await fetch(releasesURL, {
      headers: { 'User-Agent': 'youeye-control' },
    });
    if (!res.ok) return null;

    const allReleases = await res.json();
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
    const assets = matchedRelease.assets as MarketReleaseAsset[];
    const tarAsset = assets?.find((a) => a.name === 'standalone.tar');
    if (!tarAsset || !version) return null;
    const downloadURL = getMarketReleaseAssetDownloadURL(releaseSource, tarAsset);
    if (!downloadURL) return null;

    return { version, downloadURL };
  } catch {
    return null;
  }
}

// ─── LXD Tarball Update ──────────────────────────────────

async function downloadReleaseTarball(downloadURL: string): Promise<{ dir: string; tarPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'youeye-app-update-'));
  const tarPath = join(dir, 'standalone.tar');
  try {
    const res = await fetch(downloadURL, {
      headers: { 'User-Agent': 'youeye-control' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(tarPath, bytes);
    return { dir, tarPath };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pushFileToContainer(
  localPath: string,
  containerName: string,
  remotePath: string,
): Promise<void> {
  try {
    const data = await readFile(localPath);
    await incusUploadFile(containerName, remotePath, data, { timeout: 300_000 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to push update artifact into ${containerName}: ${detail}`);
  }
}

/**
 * Update an LXD container with a CP-downloaded release tarball.
 * The app container never receives broad internet/NAT for code updates.
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
  emit(onEvent, step, totalSteps, 'running', 'Fetching latest release metadata...');
  const release = await getLatestGiteaRelease(giteaRepo, branch, tagPrefix);
  if (!release) throw new Error('Could not fetch latest release from Gitea');
  emit(onEvent, step, totalSteps, 'success', `Latest version: v${release.version}`);

  let tempDir: string | null = null;

  // Stop systemd service (NOT the container)
  step++;
  emit(onEvent, step, totalSteps, 'running', `Stopping ${serviceName} service...`);
  await execShell(containerName, `systemctl stop ${serviceName}`, { timeout: 30_000 });
  emit(onEvent, step, totalSteps, 'success', `${serviceName} stopped`);

  // Download new tarball
  step++;
  emit(onEvent, step, totalSteps, 'running', `Downloading v${release.version} via Control Panel...`);
  try {
    const artifact = await downloadReleaseTarball(release.downloadURL);
    tempDir = artifact.dir;
    await pushFileToContainer(artifact.tarPath, containerName, '/tmp/update.tar');
    emit(onEvent, step, totalSteps, 'success', 'Artifact downloaded and staged');

    // Extract tarball
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Extracting files...');
    await execShell(containerName, `rm -rf ${resolvedDir}`, { timeout: 30_000 });
    await execShell(containerName, `mkdir -p ${resolvedDir}`, { timeout: 10_000 });
    const extractResult = await execShell(
      containerName,
      `tar -xf /tmp/update.tar -C ${resolvedDir} --no-same-owner`,
      { timeout: 60_000 }
    );
    if (extractResult.exitCode !== 0) {
      throw new Error(`Extraction failed: ${extractResult.stderr}`);
    }
    await execShell(containerName, 'rm -f /tmp/update.tar', { timeout: 10_000 });
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
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
 *   5b. LXD path: CP downloads tarball → stop service → push/extract artifact → start → health check
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
    manifest = await fetchManifestFromSource(appId, installMeta.sourceId || installedApp.sourceId || undefined);
  } catch (err) {
    throw new Error(`Failed to fetch manifest for "${appId}": ${err}`);
  }

  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = manifest.version || '0.0.0';
  const containerSpecs = manifest.containers || [];
  const sourceId = installMeta.sourceId || installedApp.sourceId || undefined;
  let durableMigrationPlan: Awaited<ReturnType<typeof fetchUpdatePlanMigrationsFromSource>> = { migrations: [], references: [] };
  try {
    durableMigrationPlan = await fetchUpdatePlanMigrationsFromSource(appId, sourceId);
  } catch (err) {
    throw new Error(`Failed to fetch durable update plan for "${appId}": ${err}`);
  }

  if (!config.force && !isNewer(targetVersion, installedVersion)) {
    emit(onEvent, 1, 1, 'success', `${appId} is already up to date (v${installedVersion})`);
    return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0 };
  }

  // ── Version constraint check ───────────────────────────
  const constraintError = checkVersionConstraint(
    manifest.update?.version_constraint,
    installedVersion,
    targetVersion
  );
  if (constraintError && !config.force) {
    emit(onEvent, 1, 1, 'error', constraintError);
    return {
      success: false, previousVersion: installedVersion, newVersion: targetVersion,
      migrationsRun: 0, error: constraintError,
    };
  }

  // ── Determine update path ──────────────────────────────

  const allMigrations = mergeMigrationSources(manifest.update?.migrations || [], durableMigrationPlan.migrations);
  const strategy = (manifest.update?.strategy === 'migrate' || allMigrations.length > 0) ? 'migrate' : 'replace';

  // v2: each container has an explicit type ('lxd' | 'oci')
  const containerNames = containerSpecs.map((c) => getContainerName(appId, c.name, containerSpecs.length));
  const lxdContainers = containerSpecs.filter((c) => c.type === 'lxd');
  const ociContainers = containerSpecs.filter((c) => c.type === 'oci');

  // ── Count total steps ──────────────────────────────────

  const migrations = strategy === 'migrate'
    ? findApplicableMigrations(allMigrations, installedVersion, targetVersion, installMeta.appliedMigrations)
    : [];
  const migrationStepCount = migrations.reduce((sum, m) => sum + m.steps.length, 0);
  const updatePath = describeUpdatePath(installedVersion, targetVersion, migrations);

  const preUpdateHooks = manifest.update?.pre_update as UpdateHookStep[] | undefined;
  const postUpdateHooks = manifest.update?.post_update as UpdateHookStep[] | undefined;

  let totalSteps = 1; // preflight
  totalSteps += containerNames.length; // snapshots
  totalSteps += (preUpdateHooks?.length || 0); // pre-update hooks
  totalSteps += migrationStepCount; // migration steps

  // LXD containers: fetch metadata + stop service + CP download/stage + extract + start + health each
  totalSteps += lxdContainers.length * 6;
  // OCI containers: stop + rebuild + start per container
  totalSteps += ociContainers.length * 3;
  // Health checks for OCI containers that have them
  totalSteps += ociContainers.filter((c) => c.healthCheck).length;

  totalSteps += (postUpdateHooks?.length || 0); // post-update hooks
  totalSteps += 3; // sync UI manifest + save metadata + cleanup

  let step = 0;

  // ── Step 1: Preflight ──────────────────────────────────

  const containerTypes = containerSpecs.map((c) => c.type).join(', ');
  step++;
  emit(onEvent, step, totalSteps, 'running',
    `Updating ${appId} from v${installedVersion} to v${targetVersion} (path: ${updatePath}; containers: ${containerTypes}; strategy: ${strategy})`);

  // Build variable context — preserves existing secrets
  const ctx = await buildCanonicalContext(
    manifest,
    { appId, subdomain: installMeta.subdomain, domain: installMeta.domain },
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

  // OCI rollback points: name → previous image fingerprint. The Incus rebuild API
  // requires the pre-update snapshot to be deleted (so snapshot-based rollback is
  // impossible for OCI), but rebuild preserves volumes/config — so the rollback is to
  // re-image back to the previous fingerprint. Captured before any destructive change.
  const ociRollbackImages = new Map<string, string>();

  try {
    // ── Step 2: Snapshot container(s) + capture OCI rollback image ──

    for (let i = 0; i < containerNames.length; i++) {
      const name = containerNames[i];
      const spec = containerSpecs[i];
      step++;
      emit(onEvent, step, totalSteps, 'running', `Creating snapshot of ${name}...`);
      await createSnapshot(name, SNAPSHOT_PREFIX);
      if (spec?.type === 'oci') {
        const baseImage = await getContainerBaseImage(name);
        if (!baseImage) {
          // Fail loud before touching anything: with no rollback image, a failed OCI
          // rebuild would be unrecoverable (the snapshot must be deleted to rebuild).
          throw new Error(`Cannot capture rollback image for OCI container ${name} (no volatile.base_image); aborting before any destructive change`);
        }
        ociRollbackImages.set(name, baseImage);
      }
      emit(onEvent, step, totalSteps, 'success', `Snapshot created for ${name}`);
    }

    // ── Step 3: Pre-update hooks ─────────────────────────

    step = await runUpdateHooks(preUpdateHooks, appId, containerSpecs, onEvent, step, totalSteps, 'Pre-update');

    // ── Step 4: Run migrations (if strategy=migrate) ─────

    if (strategy === 'migrate' && migrations.length > 0) {
      for (const migration of migrations) {
        emit(onEvent, step, totalSteps, 'running',
          `Applying required migration gate ${migration.fromVersion} -> ${migration.toVersion}`);
        for (const migrationStep of migration.steps) {
          step++;
          const stepDesc = migrationStep.type === 'exec'
            ? `Running migration in ${migrationStep.container}`
            : `Running SQL migration on ${migrationStep.database}`;
          emit(onEvent, step, totalSteps, 'running', stepDesc);
          await executeMigrationStep(migrationStep, appId, containerSpecs.length, ctx);
          emit(onEvent, step, totalSteps, 'success', stepDesc);
        }
        await recordAppliedMigration(installMeta, migration);
      }
    }

    // ── Step 5: Update containers by type ────────────────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];

      if (spec.type === 'lxd' && spec.source) {
        // ── LXD path: fetch tarball from Gitea, extract, restart service ──
        const giteaRepo = spec.source.repo?.includes('/')
          ? spec.source.repo.split('/').pop()!
          : (spec.source.repo || spec.name);
        const appDir = spec.source.appDir || '/opt/app';
        const healthEndpoint = spec.healthCheck?.type === 'http'
          ? (spec.healthCheck.path || '/api/health')
          : '/api/health';
        const port = spec.port || 3000;
        const tagPrefix = spec.source.tagPrefix;

        const result = await updateLXDContainer(
          name, giteaRepo, appDir, name,
          port, healthEndpoint, tagPrefix, onEvent, step, totalSteps
        );
        step = result.step;
      } else {
        // ── OCI path: stop → rebuild with new image → start ──
        step++;
        emit(onEvent, step, totalSteps, 'running', `Stopping ${name}...`);
        await stopContainer(name);
        emit(onEvent, step, totalSteps, 'success', `${name} stopped`);

        step++;
        emit(onEvent, step, totalSteps, 'running', `Rebuilding ${name} with ${spec.image}...`);
        await deleteSnapshot(name, SNAPSHOT_PREFIX);
        await rebuildContainer(name, spec.image);
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);

        step++;
        emit(onEvent, step, totalSteps, 'running', `Starting ${name}...`);
        await startContainer(name);
        emit(onEvent, step, totalSteps, 'success', `${name} started`);

        // Health check for OCI container
        if (spec.healthCheck) {
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
    }

    // ── Step 6: Post-update hooks ────────────────────────

    step = await runUpdateHooks(postUpdateHooks, appId, containerSpecs, onEvent, step, totalSteps, 'Post-update');

    // ── Step N-2: Sync manifest cache to UI ──────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Syncing app manifest to YouEye UI...');
    await syncAppManifestObjectToUI(appId, manifest as unknown as Record<string, unknown>);
    emit(onEvent, step, totalSteps, 'success', 'App manifest synced to YouEye UI');

    // ── Step N-1: Update version in DB ───────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Updating version records...');
    await updateInstalledVersion(appId, targetVersion);
    installMeta.installedVersion = targetVersion;
    if (!installMeta.sourceId) {
      try {
        const source = await getMarketSource();
        installMeta.catalogKey = `${source.id}:app:${appId}`;
        installMeta.itemKind = 'app';
        installMeta.sourceId = source.id;
        installMeta.sourceName = source.name;
        installMeta.sourceRepoUrl = source.repo_url;
        installMeta.manifestSource = source.repo_url;
      } catch {
        // Source metadata is best-effort for legacy installs.
      }
    }
    try {
      const reference = await fetchManifestReferenceFromSource(appId, installMeta.sourceId || installedApp.sourceId || undefined);
      installMeta.manifestPath = reference.path;
      installMeta.manifestRepo = reference.repo;
      installMeta.manifestBranch = reference.branch;
      installMeta.manifestDigest = reference.digest;
    } catch {
      // Manifest audit metadata is best-effort for legacy or custom installs.
    }
    await saveInstallMetadata(installMeta);
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
    for (let i = 0; i < containerNames.length; i++) {
      const name = containerNames[i];
      const spec = containerSpecs[i];
      try {
        if (spec?.type === 'oci') {
          // OCI rollback: the pre-rebuild snapshot was (or must be) deleted to satisfy
          // the Incus rebuild API, so a snapshot restore is impossible. Re-image back to
          // the captured previous fingerprint instead — rebuild preserves volumes/config,
          // and the old image is still in the local store (no network pull).
          const oldImage = ociRollbackImages.get(name);
          await deleteSnapshot(name, SNAPSHOT_PREFIX); // rebuild requires no snapshot (idempotent)
          if (oldImage) {
            await stopContainer(name);
            await rebuildContainerFromFingerprint(name, oldImage);
            await startContainer(name);
          } else {
            // No rollback image captured (should not happen — capture or abort above).
            console.error(`[updater] No rollback image for OCI ${name}; leaving current image, restarting`);
            await startContainer(name);
          }
        } else {
          // LXD rollback: the snapshot is intact (LXD updates in place) — restore it.
          // The container stays running after a non-stateful restore; wait for exec.
          await restoreSnapshot(name, SNAPSHOT_PREFIX);
          await waitForContainerExec(name, 30);
        }
      } catch (rollbackErr) {
        console.error(`[updater] Rollback failed for ${name}:`, rollbackErr);
      }
      // Clean up snapshot after rollback (idempotent — no-op if already gone)
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
