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
 *   - Durable scoped runtime, volume, database and metadata recovery
 *   - SSE event emission for real-time progress
 *   - Version tracking in installed_apps DB
 *
 * Key design decisions:
 *   - Secrets are ALWAYS preserved across updates (never regenerated)
 *   - Data volumes are preserved by default (configurable via manifest)
 *   - SSO configuration is preserved (identity app not recreated)
 *   - Restart recovery before watchdogs and operation admission
 */

import { appUpdateJournalStore, withAppLifecycle } from './update-admission';
import { prepareIncusAppUpdate } from './update-provider';
import { runAppUpdateTransaction, type AppUpdateTransaction } from './update-transaction';
import { updateDigest } from './update-workspace';
import { freezeUpdateOCIImage } from './update-oci';
import { execShell, incusUploadFile } from '@/lib/incus/server';
import { readFile } from 'fs/promises';
import {
  stopContainer,
  startContainer,
  rebuildContainer,
  waitForContainerExec,
  waitForRunning,
} from '@/lib/incus/snapshot';
import { fetchUpdatePlanMigrationsFromSource, clearCatalogCache, resolveCatalogApp } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import {
  getInstalledApp,
  recordAppProvenance,
  recordCatalogAppUpdate,
} from './installed-apps';
import { getContainerName } from './engine-helpers';
import { resolveVariables } from './variables';
import { buildCanonicalContext, generateAppToken } from './platform-env';
import { withAppNetworkOperationLock } from '../incus/app-network';
import { readSecret } from '../infrastructure/secrets';
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
import { refreshDirectMarketApp } from './direct-apps';
import { stageMarketNativeArtifacts, resolveMarketProductRelease, downloadMarketProductBlob, type StagedMarketNativeArtifact } from './native-artifact';
import { acceptProductSequence, type VerifiedProductRelease } from '../releases/product-release';
import { updateIdenticalProductRelease } from './update-release-metadata';
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
  errorCode?: string;
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
  label: string,
  transaction: AppUpdateTransaction,
  runner: <T>(name: string, run: () => Promise<T>) => Promise<T>,
): Promise<number> {
  if (!hooks || hooks.length === 0) return step;
  for (const hook of hooks) {
    step++;
    const containerName = getContainerName(appId, hook.exec_in, containerSpecs.length);
    emit(onEvent, step, totalSteps, 'running', `${label}: running hook in ${containerName}`);
    await transaction.mutate(`hook-${label.toLowerCase()}-${step}`, () => runner(containerName, async () => {
      const result = await execShell(containerName, hook.run, { timeout: hook.timeout || 60_000 });
      if (result.exitCode !== 0) throw new Error(`${label} hook failed in ${containerName}`);
    }));
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
  databases: Array<{ engine: string; name: string; ownerRole: string }>,
  sqlRunner: (sql: string) => Promise<void>,
): Promise<void> {
  if (step.type === 'exec') {
    const containerName = getContainerName(appId, step.container, totalContainers);
    const command = resolveVariables(step.command, ctx);
    const result = await execShell(containerName, command, {
      timeout: step.timeout || 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Migration command failed in ${containerName}`);
    }
  } else if (step.type === 'sql') {
    const dbName = resolveVariables(step.database, ctx);
    const database = databases.find(db => db.name === dbName);
    if (!database || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database.ownerRole)) {
      throw new Error('Migration targets a database outside this app recovery set');
    }
    await sqlRunner(resolveVariables(step.command, ctx));
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
  // This runs under an idle init, so systemd and ordinary workers are stopped.
  // Verify the on-disk unit rather than querying a running service manager.
  if (!/^\/(?:opt|srv)\/[A-Za-z0-9_./-]+$/.test(appDir)
    || appDir.split('/').some(p => p === '..' || p === '.')) throw new Error('Native app directory is unsupported');
  const unit = await execShell(containerName, `cat '/etc/systemd/system/${serviceName}.service'`, { timeout: 10_000 });
  const workingDirs = unit.stdout.split('\n').filter(line => line.startsWith('WorkingDirectory='));
  if (unit.exitCode !== 0 || workingDirs.length !== 1 || workingDirs[0].slice(17) !== appDir) {
    throw new Error('Native service directory does not match the frozen application declaration');
  }
  const resolvedDir = appDir;

  step++;
  emit(onEvent, step, totalSteps, 'success', `Preflight accepted v${artifact.version} (${artifact.signature.status === 'unsigned' ? 'manifest-authorized' : 'verified release'})`);

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
  const prepare = await execShell(containerName, `rm -rf -- '${resolvedDir}' && mkdir -p -- '${resolvedDir}'`, { timeout: 30_000 });
  if (prepare.exitCode !== 0) throw new Error('Native extraction directory could not be prepared');
  const extractResult = await execShell(
    containerName,
    `tar -xf /tmp/update.tar -C '${resolvedDir}' --no-same-owner`,
    { timeout: 60_000 }
  );
  if (extractResult.exitCode !== 0) {
    throw new Error('Native artifact extraction failed');
  }
  if ((await execShell(containerName, 'rm -f /tmp/update.tar', { timeout: 10_000 })).exitCode !== 0) {
    throw new Error('Native artifact staging cleanup failed');
  }
  emit(onEvent, step, totalSteps, 'success', 'Files extracted');

  if (artifact.productRelease) {
    const { publishProductProjection } = await import('../releases/product-projection');
    artifact.runtimeUUID = await publishProductProjection(containerName,artifact.productRelease);
  }

  return { step, version: artifact.version };
}

// ─── Main Update Function ─────────────────────────────────

/**
 * Update an installed app to the latest version from the catalog.
 * Handles both OCI (Market-installed) and LXD (native) apps through a unified flow.
 *
 * Resolve immutable target artifacts under lifecycle exclusion, prepare a
 * verified quiesced recovery set, apply and verify, then publish metadata and
 * durably commit. The transaction owns coherent rollback and restart recovery.
 */
async function updateMarketAppUnderLifecycle(
  config: UpdateConfig,
  onEvent: InstallEventCallback
): Promise<UpdateResult> {
  return withAppNetworkOperationLock(config.appId, 'update', () => updateMarketAppLocked(config, onEvent));
}

async function updateMarketAppLocked(
  config: UpdateConfig,
  onEvent: InstallEventCallback
): Promise<UpdateResult> {
  const { appId } = config;

  // ── Preflight checks ────────────────────────────────────

  const installedApp = await getInstalledApp(appId);
  if (!installedApp) throw new Error(`App "${appId}" is not installed`);

  const installMeta = await readInstallMetadata(appId);
  if (!installMeta) throw new Error(`No install metadata found for "${appId}"`);
  if (installMeta.serviceCredentialState !== 'ready') throw new Error('App credentials require reconciliation before update');
  const originalInstallMeta = structuredClone(installMeta);

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
  let productRelease: VerifiedProductRelease | null = null;
  let channelManifestReference: { path: string; repo: string; branch: string; digest: string } | null = null;
  if (channelCandidate && channelSourceUrl) {
    try {
      const srcLike = parseMarketRepoURL(channelSourceUrl);
      productRelease = await resolveMarketProductRelease(appId,channelSourceUrl,channelCandidate.tag);
      const yamlText = productRelease
        ? (await downloadMarketProductBlob(productRelease,'youeye-app.yaml')).toString('utf8')
        : await fetchRepoFile(srcLike.organization, srcLike.repository, 'youeye-app.yaml', channelCandidate.tag, srcLike);
      if (productRelease && updateDigest(yamlText) !== productRelease.build.contract_sha256) throw new Error('Product installer contract differs from original build');
      manifest = parseManifest(yamlText);
      if (productRelease) {
        acceptProductSequence(installMeta.productReleaseFloors,productRelease);
        if (manifest.metadata.id !== appId || manifest.version !== productRelease.build.build_version || productRelease.release.version !== channelCandidate.version) throw new Error('Product manifest differs from selected build/release identity');
        // Installed registration is release metadata. Original YAML/archive
        // bytes and their original build-version field remain untouched.
        manifest = {...manifest,version:productRelease.release.version};
      }
      channelManifestReference = { path: 'youeye-app.yaml',
        repo: `${srcLike.organization}/${srcLike.repository}`, branch: channelCandidate.tag,
        digest: `sha256:${updateDigest(yamlText)}` };
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

  if (productRelease && channelManifestReference) {
    const adopted = await updateIdenticalProductRelease(appUpdateJournalStore(), originalInstallMeta,
      installedApp, manifest, productRelease, channelManifestReference);
    if (adopted) {
      emit(onEvent, 1, 1, 'success', `Release ${targetVersion} adopted; existing payload remains running`);
      return adopted;
    }
  }
  if (!directEntry) {
    try { durableMigrationPlan = await fetchUpdatePlanMigrationsFromSource(appId, sourceId); }
    catch (err) { throw new Error(`Failed to fetch durable update plan for "${appId}": ${err}`); }
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
  let ctx = await buildCanonicalContext(
    manifest,
    { appId, subdomain: installMeta.subdomain, domain: installMeta.domain },
    undefined, undefined, await generateAppToken(appId),
    installMeta.usePerAppBridge === true,
  );
  if (!ctx.secrets) ctx.secrets = {};

  // Reload existing secrets
  for (const secret of manifest.secrets) {
    try {
      const value = await readSecret(`app-${appId}`, secret.file);
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

  let attemptedOperation: string | undefined;
  try {
    const preflight = await prepareIncusAppUpdate(originalInstallMeta, manifest);
    ctx = await preflight.provider.configurationContext(ctx);
    const frozenOCI = new Map<string, Awaited<ReturnType<typeof freezeUpdateOCIImage>>>();
    for (const spec of ociContainers) {
      if (installMeta.databaseMode === 'own' && installMeta.containers.find(c => c.name === spec.name)?.role === 'database') continue;
      frozenOCI.set(spec.name, await freezeUpdateOCIImage(spec.image));
    }
    const hookNames = [...(preUpdateHooks ?? []), ...(postUpdateHooks ?? [])].map(h => h.exec_in);
    const migrationNames = migrations.flatMap(m => m.steps.filter(s => s.type === 'exec').map(s => s.container));
    if ([...hookNames, ...migrationNames].some(name => !containerSpecs.some(c => c.name === name))) {
      throw new Error('Update hook or migration targets a container outside the app recovery set');
    }
    if (migrations.flatMap(m => m.steps).some(s => s.type === 'sql'
      && !preflight.inventory.databases.some(db => db.name === resolveVariables(s.database, ctx)))) {
      throw new Error('Update migration targets a database outside the app recovery set');
    }
    const result = await runAppUpdateTransaction(appUpdateJournalStore(), {
      appId, resources: preflight.inventory.resources,
      originalRunning: preflight.inventory.originalRunning,
      metadataBeforeSHA256: preflight.metadataBeforeSHA256,
      source: { manifestSHA256: updateDigest(JSON.stringify(preflight.old)),
        artifactSHA256: preflight.sourceArtifacts },
      target: { manifestSHA256: updateDigest(JSON.stringify(manifest)),
        artifactSHA256: [...stagedNativeArtifacts.byContainerName.values()].map(a => a.artifactSHA256)
          .concat([...frozenOCI.values()].map(a => a.sha256)) },
    }, preflight.provider, async transaction => {
    // All checkpoints are verified with every writer stopped before any hook,
    // SQL or automatic first-start migration. Ordinary ingress remains fenced.
    const runner = <T>(name: string, run: () => Promise<T>) =>
      preflight.provider.withMigrationRunner(transaction.record(), name, run);
    const sqlRunner = (sql: string) => preflight.provider.executeSQL(transaction.record(), sql);
    // ── Step 3: Pre-update hooks ─────────────────────────

    step = await runUpdateHooks(preUpdateHooks, appId, containerSpecs, onEvent, step, totalSteps, 'Pre-update', transaction, runner);

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
          await transaction.mutate(`migration-${step}`, () => migrationStep.type === 'exec'
            ? runner(getContainerName(appId, migrationStep.container, containerSpecs.length),
              () => executeMigrationStep(migrationStep, appId, containerSpecs.length, ctx, preflight.inventory.databases, sqlRunner))
            : executeMigrationStep(migrationStep, appId, containerSpecs.length, ctx, preflight.inventory.databases, sqlRunner));
          emit(onEvent, step, totalSteps, 'success', stepDesc);
        }
        stageAppliedMigration(installMeta, migration);
      }
    }

    // ── Step 5: Update containers by type ────────────────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      if (installMeta.databaseMode === 'own' && installMeta.containers.find(c => c.containerName === name)?.role === 'database') {
        emit(onEvent, step, totalSteps, 'success', `${name} retains its exact PostgreSQL runtime`);
        continue;
      }

      if (spec.type === 'lxd' && spec.source) {
        // ── LXD path: fetch tarball from the configured release source, extract, restart service ──
        const appDir = spec.source.appDir || '/opt/app';
        const healthEndpoint = spec.healthCheck?.type === 'http'
          ? (spec.healthCheck.path || '/api/health')
          : '/api/health';
        const port = spec.port || 3000;
        const stagedArtifact = stagedNativeArtifacts.byContainerName.get(spec.name);
        if (!stagedArtifact) throw new Error(`Native artifact preflight is missing for ${spec.name}`);
        const result = await transaction.mutate(`native-replace-${i}`, () => runner(name, () => updateLXDContainer(
          name, appDir, name,
          port, healthEndpoint, stagedArtifact, onEvent, step, totalSteps,
        )));
        step = result.step;
      } else {
        // ── OCI path: stop → rebuild with new image → start ──
        step++;
        emit(onEvent, step, totalSteps, 'running', `Stopping ${name}...`);
        await transaction.mutate(`stop-runtime-${i}`, () => stopContainer(name));
        emit(onEvent, step, totalSteps, 'success', `${name} stopped`);

        step++;
        emit(onEvent, step, totalSteps, 'running', `Rebuilding ${name} with ${spec.image}...`);
        const artifact = frozenOCI.get(spec.name);
        if (!artifact) throw new Error('OCI update artifact is not frozen');
        await transaction.mutate(`oci-replace-${i}`, () => rebuildContainer(name, artifact.image));
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);

      }
    }
    // All code replacements finish before any ordinary process can observe the
    // new schema. Post hooks execute offline against the complete new code set.
    step = await runUpdateHooks(postUpdateHooks, appId, containerSpecs, onEvent, step, totalSteps, 'Post-update', transaction, runner);
    await transaction.mutate('apply-generated-configuration', () => preflight.provider.applyConfiguration(transaction.record(), manifest, ctx));
    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      if (installMeta.databaseMode === 'own' && installMeta.containers.find(c => c.containerName === name)?.role === 'database') continue;
      await transaction.mutate(`first-start-${i}`, async () => {
        await startContainer(name);
        await waitForRunning(name);
        await waitForContainerExec(name);
      });
    }
    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      // Check health only after every runtime has the target code/configuration.
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

    transaction.verifying();
    // ── Step N-2: Sync manifest cache to UI ──────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Syncing app manifest to YouEye UI...');
    await transaction.mutate('publish-ui-manifest', () => syncAppManifestObjectToUI(appId, manifest as unknown as Record<string, unknown>));
    const { probeNativeAppCredential } = await import('@/lib/apps/service-credential-probe');
    await transaction.mutate('verify-native-service-credential', () => probeNativeAppCredential(appId, manifest));
    emit(onEvent, step, totalSteps, 'success', 'App manifest synced to YouEye UI');

    // ── Step N-1: Update version in DB ───────────────────

    step++;
    emit(onEvent, step, totalSteps, 'running', 'Updating version records...');
    installMeta.installedVersion = targetVersion;
    if (productRelease) installMeta.productReleaseFloors = acceptProductSequence(installMeta.productReleaseFloors,productRelease);
    installMeta.catalogKey = `${sourceId}:app:${appId}`;
    installMeta.itemKind = 'app';
    installMeta.sourceId = sourceId;
    installMeta.sourceName = directEntry ? 'Added' : resolvedCatalog!.source.name;
    installMeta.sourceRepoUrl = directEntry?.manifestUrl ?? resolvedCatalog!.source.repo_url;
    installMeta.manifestSource = directEntry?.manifestUrl ?? resolvedCatalog!.source.repo_url;
    if (directEntry) {
      installMeta.manifestPath = directEntry.manifestUrl;
      installMeta.manifestDigest = directEntry.manifestDigest;
    } else if (channelManifestReference) {
      installMeta.manifestPath = channelManifestReference.path;
      installMeta.manifestRepo = channelManifestReference.repo;
      installMeta.manifestBranch = channelManifestReference.branch;
      installMeta.manifestDigest = channelManifestReference.digest;
    } else if (routing?.kind === 'catalog') {
      installMeta.manifestPath = resolvedCatalog!.reference.path;
      installMeta.manifestRepo = resolvedCatalog!.reference.repo;
      installMeta.manifestBranch = resolvedCatalog!.reference.branch;
      installMeta.manifestDigest = resolvedCatalog!.reference.digest;
    }
    installMeta.nativeArtifacts = [...stagedNativeArtifacts.byContainerName.values()].map((artifact) => ({
      productRelease: artifact.productRelease,
      runtimeUUID: artifact.runtimeUUID,
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
    await transaction.mutate('publish-install-metadata', () => saveInstallMetadata(installMeta));
    // Provenance: what tag/branch/source is actually installed now.
    if (channelCandidate) {
      await transaction.mutate('publish-provenance', () => recordAppProvenance(appId, {
        version: channelCandidate.version,
        tag: channelCandidate.tag,
        branch: channelCandidate.branch,
        source: channelSourceUrl,
      }));
    } else {
      await transaction.mutate('publish-provenance', () => recordCatalogAppUpdate(appId, targetVersion));
    }
    emit(onEvent, step, totalSteps, 'success', 'Version updated');

    const saved = await readInstallMetadata(appId);
    const installed = await getInstalledApp(appId);
    if (saved?.installedVersion !== targetVersion || installed?.installedVersion !== targetVersion) {
      throw new Error('Installed metadata did not converge with verified runtime');
    }
    return { value: {
      success: true, previousVersion: installedVersion, newVersion: targetVersion,
      migrationsRun: migrations.length,
    }, metadataDigest: updateDigest(JSON.stringify(saved)) };
    }, id => { attemptedOperation = id; });
    // Current ownership is reconciled only after durable commit and cleanup.
    // Namespace declarations are additive and do not restore old grants.
    const { bindInstalledAdmission } = await import('@/lib/admission/lifecycle');
    await bindInstalledAdmission(installMeta);
    const { reconcileAdmissionProjections } = await import('@/lib/admission/projection');
    await reconcileAdmissionProjections();
    return result;
  } catch (error) {
    const record = attemptedOperation ? appUpdateJournalStore().read(attemptedOperation) : undefined;
    const committed = !!record?.commit;
    const message = committed
      ? 'Update committed; maintenance or checkpoint cleanup requires attention.'
      : record?.phase === 'recovery_required'
        ? 'Update recovery requires attention. Maintenance reservations and checkpoints are retained.'
        : error instanceof Error ? error.message : 'Application update failed.';
    emit(onEvent, step, totalSteps, committed ? 'success' : 'error', message);
    return {
      success: committed, previousVersion: installedVersion,
      newVersion: committed ? targetVersion : installedVersion,
      migrationsRun: committed ? migrations.length : 0, error: message,
      errorCode: !committed && error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' ? error.code : undefined,
    };
  } finally {
    await stagedNativeArtifacts.cleanup();
  }
}

export async function updateMarketApp(config: UpdateConfig, onEvent: InstallEventCallback): Promise<UpdateResult> {
  return withAppLifecycle(config.appId, () => updateMarketAppUnderLifecycle(config, onEvent));
}
