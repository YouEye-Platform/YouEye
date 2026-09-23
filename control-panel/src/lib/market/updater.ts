/**
 * Unified App Updater — v2 app engine.
 *
 * Supports two update paths based on container.type:
 *   - LXD (container.type === 'lxd'): fetch tarball from the configured release source, extract, restart service
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
 *   - SSO configuration is preserved (identity app not recreated)
 *   - Rollback via Incus snapshots on failure
 */

import { execShell, incusUploadFile } from '@/lib/incus/server';
import { readFile } from 'fs/promises';
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  stopContainer,
  startContainer,
  rebuildContainer,
  containerState,
  createRollbackInstanceBackup,
  deleteInstance,
  restoreRollbackInstanceBackup,
  getServiceWorkingDir,
  healthCheckViaExec,
  waitForContainerExec,
  waitForRunning,
} from '@/lib/incus/snapshot';
import { fetchUpdatePlanMigrationsFromSource, clearCatalogCache, resolveCatalogApp } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import {
  getInstalledApp,
  recordAppProvenance,
  recordCatalogAppUpdate,
  restoreInstalledAppUpdateState,
  type InstalledAppUpdateState,
} from './installed-apps';
import { getContainerName } from './engine-helpers';
import { resolveVariables } from './variables';
import { buildCanonicalContext } from './platform-env';
import { getOrCreateSecret } from '../infrastructure/secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { isNewer } from '@/lib/version';
import { parseMarketRepoURL } from './source';
import { effectiveChannel, resolveCandidate, getReleaseChannelsConfig, APP_PREFIX, type ResolvedCandidate } from '@/lib/updates/channels';
import { fetchRepoFile } from './catalog';
import { parseManifest } from './parser';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import {
  classifyAppUpdateRouting,
  isChannelSwitchConfirmationRequired,
  recordedCatalogSourceIds,
} from './update-routing';
import {
  describeUpdatePath,
  findApplicableMigrations,
  mergeMigrationSources,
  type MigrationWithSource,
} from './migration-planner';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { observeIssue, resolveIssue } from '@/lib/health/issues';
import { recoverOriginallyRunningContainers } from './update-recovery';
import { refreshDirectMarketApp } from './direct-apps';
import { stageMarketNativeArtifacts, type StagedMarketNativeArtifact } from './native-artifact';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
  MigrationStep,
  InstallMetadata,
  VariableContext,
} from './types';

// ─── Types ────────────────────────────────────────────────

export interface UpdateConfig {
  appId: string;
  /** Force update even if versions match */
  force?: boolean;
  /** Confirm installing a NOT-newer candidate after a channel change (downgrade/sidegrade) */
  confirmSwitch?: boolean;
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

// Stage an applied-migration gate IN MEMORY only. It is persisted later by the single
// post-rebuild `saveInstallMetadata` (after the container rebuild + health check + version
// bump all succeed). Persisting here — per migration step, before the rebuild — was a bug:
// a migration runs its SQL, the gate gets marked applied, then the rebuild fails and the
// container rolls back to the OLD image. That left "SQL migrated + gate done + old binary",
// and because `findApplicableMigrations` skips already-applied gates the migration would
// never re-run on retry → schema/binary mismatch + crash-loop. Staging in memory means a
// failed update (which never reaches the final save) leaves NO half-applied gate, so the
// gate re-runs on the next attempt.
function stageAppliedMigration(
  installMeta: InstallMetadata,
  migration: MigrationWithSource,
): void {
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
  appDir: string,
  serviceName: string,
  port: number,
  healthEndpoint: string,
  artifact: StagedMarketNativeArtifact,
  onEvent: InstallEventCallback,
  step: number,
  totalSteps: number,
): Promise<{ step: number; version: string }> {
  // Resolve real app dir from systemd service
  const resolvedDir = await getServiceWorkingDir(containerName, serviceName, appDir);
  if (resolvedDir !== appDir) {
    emit(onEvent, step, totalSteps, 'running', `Service runs from ${resolvedDir} (configured: ${appDir})`);
  }

  step++;
  emit(onEvent, step, totalSteps, 'success', `Preflight accepted v${artifact.version} (${artifact.signature.status === 'unsigned' ? 'manifest-authorized' : 'verified release'})`);

  // Stop systemd service (NOT the container)
  step++;
  emit(onEvent, step, totalSteps, 'running', `Stopping ${serviceName} service...`);
  await execShell(containerName, `systemctl stop ${serviceName}`, { timeout: 30_000 });
  emit(onEvent, step, totalSteps, 'success', `${serviceName} stopped`);

  step++;
  emit(onEvent, step, totalSteps, 'running', `Staging preflighted v${artifact.version} bytes...`);
  await pushFileToContainer(artifact.path, containerName, '/tmp/update.tar');
  const stagedDigest = await execShell(
    containerName,
    `test "$(sha256sum /tmp/update.tar | awk '{print $1}')" = '${artifact.artifactSHA256}'`,
    { timeout: 30_000 },
  );
  if (stagedDigest.exitCode !== 0) throw new Error('Staged update artifact changed before extraction');
  emit(onEvent, step, totalSteps, 'success', 'Exact preflighted artifact staged');

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

  return { step, version: artifact.version };
}

// ─── Main Update Function ─────────────────────────────────

const SNAPSHOT_PREFIX = 'pre-update';

/**
 * Update an installed app to the latest version from the catalog.
 * Handles both OCI (Market-installed) and LXD (native) apps through a unified flow.
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
export async function updateMarketApp(
  config: UpdateConfig,
  onEvent: InstallEventCallback
): Promise<UpdateResult> {
  const { appId } = config;

  // ── Preflight checks ────────────────────────────────────

  const installedApp = await getInstalledApp(appId);
  if (!installedApp) throw new Error(`App "${appId}" is not installed`);

  const installMeta = await readInstallMetadata(appId);
  if (!installMeta) throw new Error(`No install metadata found for "${appId}"`);
  const originalInstallMeta = structuredClone(installMeta);
  const originalInstalledAppState: InstalledAppUpdateState = {
    installedVersion: installedApp.installedVersion,
    catalogVersion: installedApp.catalogVersion,
    updateAvailable: installedApp.updateAvailable,
    switchPending: installedApp.switchPending,
    installedTag: installedApp.installedTag,
    installedBranch: installedApp.installedBranch,
    channelSource: installedApp.channelSource,
    candidateVersion: installedApp.candidateVersion,
    candidateBranch: installedApp.candidateBranch,
    candidateTag: installedApp.candidateTag,
  };

  clearCatalogCache();

  const directSourceId = installMeta.sourceId?.startsWith('direct:')
    ? installMeta.sourceId
    : installedApp.sourceId?.startsWith('direct:') ? installedApp.sourceId : null;
  const directEntry = directSourceId ? await refreshDirectMarketApp(directSourceId) : null;
  let resolvedCatalog: Awaited<ReturnType<typeof resolveCatalogApp>> | null = null;
  if (!directEntry) {
    try {
      resolvedCatalog = await resolveCatalogApp(
        appId,
        recordedCatalogSourceIds(installedApp, installMeta),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to resolve Market source for "${appId}": ${message}`);
    }
  }

  // Classify before any release lookup or runtime mutation. A historical
  // `installedBranch: main` is not native evidence: external catalog updates
  // used to write that synthetic value after every successful update.
  let channelCandidate: ResolvedCandidate | null = null;
  let channelSourceUrl: string | null = null;
  const chCfg = await getReleaseChannelsConfig();
  const routing = resolvedCatalog ? classifyAppUpdateRouting({
    appId,
    installed: installedApp,
    installMetadata: installMeta,
    catalog: {
      sourceId: resolvedCatalog.source.id,
      sourceRepoUrl: resolvedCatalog.source.repo_url,
      sourceRepoUrls: resolvedCatalog.configuredSourceRepoUrls,
      entry: resolvedCatalog.entry,
      manifestIntegration: resolvedCatalog.manifest.integration,
    },
    hasExplicitChannelOverride: !!chCfg.apps?.[appId],
  }) : null;
  if (routing?.kind === 'channel') {
    const ch = await effectiveChannel(APP_PREFIX + appId, {
      config: chCfg,
      appDefaultSource: routing.channelDefaultSource,
    });
    channelSourceUrl = ch.source;
    channelCandidate = await resolveCandidate(ch, null);
    if (!channelCandidate) {
      throw new Error(`Channel for "${appId}" (${ch.branch} @ ${ch.source}) has no resolvable releases`);
    }
  }

  let manifest: AppManifest;
  if (channelCandidate && channelSourceUrl) {
    try {
      const srcLike = parseMarketRepoURL(channelSourceUrl);
      const yamlText = await fetchRepoFile(
        srcLike.organization, srcLike.repository, 'youeye-app.yaml', channelCandidate.tag, srcLike,
      );
      manifest = parseManifest(yamlText);
    } catch (err) {
      throw new Error(`Failed to fetch manifest for "${appId}" at ${channelCandidate.tag}: ${err}`);
    }
  } else {
    manifest = directEntry?.manifest ?? resolvedCatalog!.manifest;
  }

  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = channelCandidate ? channelCandidate.version : (manifest.version || '0.0.0');
  const containerSpecs = manifest.containers || [];
  const sourceId = directEntry?.sourceId ?? resolvedCatalog!.source.id;
  let durableMigrationPlan: Awaited<ReturnType<typeof fetchUpdatePlanMigrationsFromSource>> = { migrations: [], references: [] };
  if (!directEntry) {
    try {
      durableMigrationPlan = await fetchUpdatePlanMigrationsFromSource(appId, sourceId);
    } catch (err) {
      throw new Error(`Failed to fetch durable update plan for "${appId}": ${err}`);
    }
  }

  if (channelCandidate) {
    // Exact-tag semantics: the channel resolver + check already decided; only
    // no-op when the exact candidate tag is what's installed.
    if (!config.force && installedApp.installedTag === channelCandidate.tag) {
      emit(onEvent, 1, 1, 'success', `${appId} is already up to date (${channelCandidate.tag})`);
      return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0 };
    }
    // Not-newer candidate on a different branch = channel switch — confirm-gated
    // exactly like spine/control/ui.
    const installedBranch = installedApp.installedBranch || 'main';
    if (isChannelSwitchConfirmationRequired({
      force: !!config.force,
      confirmSwitch: !!config.confirmSwitch,
      installedBranch,
      candidateBranch: channelCandidate.branch,
      candidateIsNewer: isNewer(channelCandidate.version, installedVersion),
    })) {
      throw new Error(
        `Channel switch requires confirmation: ${installedBranch} ${installedVersion} → ` +
        `${channelCandidate.branch} ${channelCandidate.version} (downgrade/sidegrade). ` +
        `Re-run with confirmation (CLI: -y).`);
    }
  } else if (!config.force && !isNewer(targetVersion, installedVersion)) {
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

  const stagedNativeArtifacts = await stageMarketNativeArtifacts(
    manifest,
    {
      appId,
      subdomain: installMeta.subdomain,
      domain: installMeta.domain,
      sourceId,
      sourceName: directEntry ? 'Added' : resolvedCatalog!.source.name,
      sourceRepoUrl: directEntry?.manifestUrl ?? resolvedCatalog!.source.repo_url,
    },
    channelCandidate && channelSourceUrl ? {
      releases: Object.fromEntries(lxdContainers.map((container) => [container.name, {
        tag: channelCandidate!.tag,
        version: channelCandidate!.version,
        sourceRepo: channelSourceUrl!,
      }])),
    } : {},
  );

  // OCI rebuild deletes the root dataset and cannot retain snapshots. Each OCI
  // container therefore gets an independent stopped Incus copy before any
  // destructive mutation; that dataset remains until the whole app commits.
  const ociRollbackBackups = new Map<string, string>();
  const originalContainerStates = new Map<string, string>();
  const ociRebuildStarted = new Set<string>();
  let maintenance: ReturnType<typeof beginContainerMaintenance>;
  try {
    maintenance = beginContainerMaintenance(containerNames, {
      operation: `market-update:${appId}:${installedVersion}->${targetVersion}`,
    });
  } catch (error) {
    await stagedNativeArtifacts.cleanup();
    throw error;
  }
  let retainMaintenance = false;

  try {
    for (const name of containerNames) {
      originalContainerStates.set(name, await containerState(name));
    }

    // ── Step 2: Snapshot container(s) + capture OCI rollback image ──

    for (let i = 0; i < containerNames.length; i++) {
      const name = containerNames[i];
      const spec = containerSpecs[i];
      step++;
      emit(onEvent, step, totalSteps, 'running', `Creating rollback point for ${name}...`);
      if (spec?.type === 'oci') {
        if (originalContainerStates.get(name) === 'Running') {
          await stopContainer(name);
        }
        const backupName = `ye-rollback-${maintenance.id.replaceAll('-', '').slice(0, 12)}-${i}`;
        await createRollbackInstanceBackup(name, backupName);
        ociRollbackBackups.set(name, backupName);
        if (originalContainerStates.get(name) === 'Running') {
          await startContainer(name);
          await waitForRunning(name);
        }
      } else {
        await createSnapshot(name, SNAPSHOT_PREFIX);
      }
      emit(onEvent, step, totalSteps, 'success', `Rollback point verified for ${name}`);
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
        stageAppliedMigration(installMeta, migration);
      }
    }

    // ── Step 5: Update containers by type ────────────────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];

      if (spec.type === 'lxd' && spec.source) {
        // ── LXD path: fetch tarball from the configured release source, extract, restart service ──
        const appDir = spec.source.appDir || '/opt/app';
        const healthEndpoint = spec.healthCheck?.type === 'http'
          ? (spec.healthCheck.path || '/api/health')
          : '/api/health';
        const port = spec.port || 3000;
        const stagedArtifact = stagedNativeArtifacts.byContainerName.get(spec.name);
        if (!stagedArtifact) throw new Error(`Native artifact preflight is missing for ${spec.name}`);
        const result = await updateLXDContainer(
          name, appDir, name,
          port, healthEndpoint, stagedArtifact, onEvent, step, totalSteps,
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
        ociRebuildStarted.add(name);
        await rebuildContainer(name, spec.image);
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);

        step++;
        if (originalContainerStates.get(name) === 'Running') {
          emit(onEvent, step, totalSteps, 'running', `Starting ${name}...`);
          await startContainer(name);
          emit(onEvent, step, totalSteps, 'success', `${name} started`);
        } else {
          emit(onEvent, step, totalSteps, 'success', `${name} remains intentionally stopped`);
        }

        // Health check for OCI container
        if (spec.healthCheck && originalContainerStates.get(name) === 'Running') {
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
    installMeta.installedVersion = targetVersion;
    installMeta.catalogKey = `${sourceId}:app:${appId}`;
    installMeta.itemKind = 'app';
    installMeta.sourceId = sourceId;
    installMeta.sourceName = directEntry ? 'Added' : resolvedCatalog!.source.name;
    installMeta.sourceRepoUrl = directEntry?.manifestUrl ?? resolvedCatalog!.source.repo_url;
    installMeta.manifestSource = directEntry?.manifestUrl ?? resolvedCatalog!.source.repo_url;
    if (directEntry) {
      installMeta.manifestPath = directEntry.manifestUrl;
      installMeta.manifestDigest = directEntry.manifestDigest;
    } else if (routing?.kind === 'catalog') {
      installMeta.manifestPath = resolvedCatalog!.reference.path;
      installMeta.manifestRepo = resolvedCatalog!.reference.repo;
      installMeta.manifestBranch = resolvedCatalog!.reference.branch;
      installMeta.manifestDigest = resolvedCatalog!.reference.digest;
    }
    installMeta.nativeArtifacts = [...stagedNativeArtifacts.byContainerName.values()].map((artifact) => ({
      containerName: artifact.containerName,
      sourceRepo: artifact.sourceRepo,
      releaseTag: artifact.tag,
      version: artifact.version,
      artifactName: artifact.artifactName,
      sha256: artifact.artifactSHA256,
      bytes: artifact.artifactBytes,
      signature: artifact.signature.status,
      signatureKeyId: artifact.signature.status !== 'unsigned' ? artifact.signature.keyId : undefined,
    }));
    installMeta.containers = installMeta.containers.map((container) => {
      const spec = containerSpecs.find((candidate) => candidate.name === container.name);
      if (!spec) return container;
      return {
        ...container,
        healthCheck: spec.healthCheck ? {
          type: spec.healthCheck.type,
          path: 'path' in spec.healthCheck ? spec.healthCheck.path : undefined,
          timeout: spec.healthCheck.timeout,
          retries: spec.healthCheck.retries,
          startPeriod: spec.healthCheck.startPeriod,
          autoRestart: spec.healthCheck.autoRestart,
        } : undefined,
      };
    });
    installMeta.entrances = manifest.entrances?.map((entrance) => ({ ...entrance }));
    await saveInstallMetadata(installMeta);
    // Provenance: what tag/branch/source is actually installed now.
    if (channelCandidate) {
      await recordAppProvenance(appId, {
        version: channelCandidate.version,
        tag: channelCandidate.tag,
        branch: channelCandidate.branch,
        source: channelSourceUrl,
      });
    } else {
      await recordCatalogAppUpdate(appId, targetVersion);
    }
    emit(onEvent, step, totalSteps, 'success', 'Version updated');

    // ── Step N: Cleanup snapshots ────────────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Cleaning up rollback points...');
    for (let i = 0; i < containerNames.length; i++) {
      if (containerSpecs[i]?.type === 'oci') continue;
      await deleteSnapshot(containerNames[i], SNAPSHOT_PREFIX);
    }
    const cleanupFailures: string[] = [];
    for (const [name, backup] of ociRollbackBackups) {
      try {
        await deleteInstance(backup);
      } catch (error) {
        cleanupFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (cleanupFailures.length > 0) {
      await observeIssue({
        id: `app.${appId}.update-rollback-cleanup`,
        severity: 'warning',
        source: 'market-updater',
        title: `${appId} retained a rollback copy after a successful update`,
        body: 'The application update committed, but one or more stopped rollback copies require cleanup.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`app.${appId}.update-rollback-cleanup`);
    }
    emit(onEvent, step, totalSteps, 'success', cleanupFailures.length > 0
      ? 'Update committed; rollback copy cleanup requires attention'
      : 'Rollback points cleaned up');

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
    maintenance.markRollback(errMsg);
    const rollbackFailures: string[] = [];
    const rollbackCleanupFailures: string[] = [];

    // ── Rollback ─────────────────────────────────────────
    for (let i = 0; i < containerNames.length; i++) {
      const name = containerNames[i];
      const spec = containerSpecs[i];
      try {
        if (spec?.type === 'oci') {
          const backup = ociRollbackBackups.get(name);
          if (ociRebuildStarted.has(name)) {
            if (!backup) throw new Error('verified OCI rollback instance is missing');
            await restoreRollbackInstanceBackup(name, backup);
            if (originalContainerStates.get(name) === 'Running') {
              await startContainer(name);
              await waitForRunning(name);
            }
          } else if (backup) {
            try {
              await deleteInstance(backup);
            } catch (cleanupError) {
              rollbackCleanupFailures.push(`${name}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
          }
        } else {
          // LXD rollback: the snapshot is intact (LXD updates in place) — restore it.
          // The container stays running after a non-stateful restore; wait for exec.
          await restoreSnapshot(name, SNAPSHOT_PREFIX);
          await waitForContainerExec(name, 30);
        }
      } catch (rollbackErr) {
        console.error(`[updater] Rollback failed for ${name}:`, rollbackErr);
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        rollbackFailures.push(`${name}: ${rollbackMessage}`);
      }
      if (spec?.type !== 'oci') {
        // Clean up LXD snapshot after rollback (idempotent).
        await deleteSnapshot(name, SNAPSHOT_PREFIX);
      }
    }

    const recoveryFailures = await recoverOriginallyRunningContainers(
      originalContainerStates,
      {
        state: containerState,
        start: startContainer,
        waitForRunning: (name) => waitForRunning(name),
      },
    );

    // Version/audit metadata is part of the same update outcome as the runtime
    // image. If a late write failed after either store advanced, restore both
    // records to the exact pre-update state and surface any restoration error.
    try {
      await saveInstallMetadata(originalInstallMeta);
    } catch (metadataRestoreError) {
      console.error(`[updater] Failed to restore install metadata for ${appId}:`, metadataRestoreError);
      rollbackFailures.push(`install metadata: ${metadataRestoreError instanceof Error ? metadataRestoreError.message : String(metadataRestoreError)}`);
    }
    try {
      await restoreInstalledAppUpdateState(appId, originalInstalledAppState);
    } catch (stateRestoreError) {
      console.error(`[updater] Failed to restore installed-app update state for ${appId}:`, stateRestoreError);
      rollbackFailures.push(`installed app state: ${stateRestoreError instanceof Error ? stateRestoreError.message : String(stateRestoreError)}`);
    }

    if (rollbackCleanupFailures.length > 0) {
      await observeIssue({
        id: `app.${appId}.update-rollback-cleanup`,
        severity: 'warning',
        source: 'market-updater',
        title: `${appId} retained an unused rollback copy`,
        body: 'The original application remained intact, but a stopped rollback copy requires cleanup.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`app.${appId}.update-rollback-cleanup`);
    }

    if (rollbackFailures.length > 0 || recoveryFailures.length > 0) {
      retainMaintenance = true;
      maintenance.markFailed([...rollbackFailures, ...recoveryFailures].join('; '));
      await observeIssue({
        id: `app.${appId}.update-rollback-failed`,
        severity: 'critical',
        source: 'market-updater',
        title: `${appId} update rollback requires attention`,
        body: 'Automatic rollback or desired-state recovery was incomplete. Watchdog recovery remains suppressed by the durable maintenance record.',
        fixable: false,
        debounce: 1,
      });
    } else {
      await resolveIssue(`app.${appId}.update-rollback-failed`);
    }

    return {
      success: false,
      previousVersion: installedVersion,
      newVersion: installedVersion,
      error: rollbackFailures.length > 0 || recoveryFailures.length > 0
        ? `${errMsg}; rollback/recovery incomplete: ${[...rollbackFailures, ...recoveryFailures].join('; ')}`
        : errMsg,
      migrationsRun: 0,
    };
  } finally {
    await stagedNativeArtifacts.cleanup();
    if (!retainMaintenance) maintenance.release();
  }
}
