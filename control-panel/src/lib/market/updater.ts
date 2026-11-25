/**
 * Unified App Updater.
 *
 * Supports two update paths based on container.type:
 *   - LXD (container.type === 'lxd', a native app): download the package its manifest pins (`source.package`), extract,
 *     restart service
 *   - OCI (container.type === 'oci'): stop → rebuild with new image → start
 *
 * Both paths support:
 *   - `requires.youeye`: an update that needs a newer platform is refused
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
import { runAppUpdateTransaction } from './update-transaction';
import { updateDigest } from './update-workspace';
import { logOperationFailure } from './install-tracker';
import { freezeUpdateOCIImage } from './update-oci';
import { execShell, incusRequest, incusUploadFile } from '@/lib/incus/server';
import { readFile } from 'fs/promises';
import { stopContainer, rebuildContainer } from '@/lib/incus/snapshot';
import { clearCatalogCache, isMarketAppUnavailable, resolveCatalogApp } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import {
  getInstalledApp,
  recordCatalogAppUpdate,
} from './installed-apps';
import { getContainerName } from './engine-helpers';
import { assertYouEyeRequirement, buildCanonicalContext, generateAppToken } from './platform-env';
import { withAppNetworkOperationLock } from '../incus/app-network';
import { readAppSecret } from '../infrastructure/secrets';
import {
  createMissingSecret, credentialRecords, generatedSecretStep, InstalledSecretMissingError, lostInstalledSecrets, missingSecrets,
} from './manifest-secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { isNewer } from '@/lib/version';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import {
  classifyAppUpdateRouting,
  recordedCatalogSourceIds,
  recordedSourceAddressChange,
} from './update-routing';
import { fetchDirectMarketAppUpdate, saveDirectMarketApp } from './direct-apps';
import { readFrozenUpdateManifest } from './frozen-manifest';
import { isMarketSourceConsentError, MarketSourceConsentError, OFFICIAL_MARKET_SOURCE_ID, setupFilesChanged } from './source';
import { stageMarketNativeArtifacts, type StagedMarketNativeArtifact } from './native-artifact';
import { sameBuild } from './update-routing';
import { adoptNativeMarketManifest, nativeManifestChanged, olderMarketVersion } from './update-release-metadata';
import { isLifecycleBusy } from '@/lib/http/lifecycle-busy';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
} from './types';

// ─── Types ────────────────────────────────────────────────

export interface UpdateConfig {
  appId: string;
  /** The owner allows changed setup files of an app added by URL (asked again on every such change). */
  allowSetup?: boolean;
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  migrationsRun: number;
  /** The installed version is already the one its source offers: nothing was changed. */
  unchanged?: boolean;
  /** A native app installed from the channel moved to its market (record only; YE-142). */
  moved?: boolean;
  /** A native app took its market's new manifest for the package it runs (record only, no restart; YE-194). */
  manifestUpdated?: boolean;
  /** Shared folders the app mounts (e.g. `media`): updated in place and never rolled back. */
  sharedFolders?: string[];
  error?: string;
  /** `committed-reopen-pending`: the new version is installed, but the app is still in maintenance until recovery
   * finishes reopening it (`youeye app recover <app>`). */
  errorCode?: string;
  /** The journal operation this attempt created (success or not); absent when it ended before one (preflight, busy,
   * already up to date). */
  operationId?: string;
  /** `setup-changed`: the setup files the new version would run (nothing was changed). */
  setups?: Array<{ name: string; for: string }>;
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
  emit(onEvent, step, totalSteps, 'success', `Preflight accepted v${artifact.version} (package digest)`);

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

  // The app's own recorded source, else the official Market; never another one (resolveCatalogApp refuses a
  // custom source the owner has not accepted). An app added by URL re-reads its URL, without saving it yet.
  const recordedSourceId = recordedCatalogSourceIds(installedApp, installMeta)[0];
  // An update uses the market as it is now: that one source is asked again (the others are left to their timers).
  if (!recordedSourceId?.startsWith('direct:')) clearCatalogCache(recordedSourceId || OFFICIAL_MARKET_SOURCE_ID);
  const directUpdate = recordedSourceId?.startsWith('direct:') ? await fetchDirectMarketAppUpdate(recordedSourceId) : null;
  const directEntry = directUpdate ? {
    sourceId: directUpdate.entry.sourceId,
    manifestUrl: directUpdate.entry.manifestUrl,
    manifestDigest: directUpdate.manifest.frozen!.digest,
    manifest: directUpdate.manifest,
  } : null;
  let resolvedCatalog: Awaited<ReturnType<typeof resolveCatalogApp>> | null = null;
  if (!directEntry) {
    try {
      resolvedCatalog = await resolveCatalogApp(appId, recordedSourceId);
    } catch (err) {
      if (isMarketSourceConsentError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // The market's version needs a newer YouEye: the update waits for the platform, like any such manifest.
      if (isMarketAppUnavailable(err)) {
        emit(onEvent, 1, 1, 'error', message);
        return { success: false, previousVersion: installedApp.installedVersion || '0.0.0', newVersion: err.version || '0.0.0',
          migrationsRun: 0, error: message, errorCode: 'requires-newer-youeye' };
      }
      if (/\(app is not present\)$/.test(message)) {
        const notListed = `No update source: ${appId} is not in ${recordedSourceId && recordedSourceId !== OFFICIAL_MARKET_SOURCE_ID ? `the Market source "${recordedSourceId}"` : 'the YouEye Market'}; it keeps running as it is`;
        emit(onEvent, 1, 1, 'error', notListed);
        return { success: false, previousVersion: installedApp.installedVersion || '0.0.0', newVersion: installedApp.installedVersion || '0.0.0',
          migrationsRun: 0, error: notListed, errorCode: 'not-in-market' };
      }
      throw new Error(`Failed to resolve Market source for "${appId}": ${message}`);
    }
    // The id may name another market address by now (a source re-pointed, or its id handed out again): the app
    // follows the address it recorded, never just the id.
    const change = recordedSourceAddressChange({ sourceRepoUrl: installMeta.sourceRepoUrl ?? installedApp.sourceRepoUrl }, resolvedCatalog.source);
    if (change) throw new MarketSourceConsentError('source-changed', change.message);
  }

  // Every app, native or container, updates from its market (YE-142): the candidate is the market's manifest. A native
  // app's manifest pins its package (`source.package`); the same package under another version name is no update.
  const routing = resolvedCatalog ? classifyAppUpdateRouting({
    appId,
    installed: installedApp,
    installMetadata: installMeta,
    catalog: {
      sourceId: resolvedCatalog.source.id,
      entry: resolvedCatalog.entry,
      manifestIntegration: resolvedCatalog.manifest.integration,
    },
  }) : null;

  const manifest: AppManifest = directEntry?.manifest ?? resolvedCatalog!.manifest;
  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = manifest.version || '0.0.0';
  const containerSpecs = manifest.containers || [];
  const sourceId = directEntry?.sourceId ?? resolvedCatalog!.source.id;
  const candidatePackage = resolvedCatalog?.reference.artifactSHA256 ?? null;
  const samePackage = sameBuild(installMeta.nativeArtifacts?.map((artifact) => artifact.sha256), candidatePackage);
  // A native app whose record does not name its market's manifest takes it first when the market pins the very package
  // it runs and the same runtime configuration: one metadata-only transaction, no download, no restart. That moves an
  // app installed from the channel before 0.6.20 to its market (YE-142) and takes a new manifest the market published
  // for the same package (YE-194). With another package it is an ordinary update by version below; with the same
  // package and another runtime configuration, an ordinary update of that package (it restarts the app).
  if (resolvedCatalog && nativeManifestChanged(installMeta, resolvedCatalog.reference.digest)) {
    try {
      const adopted = await adoptNativeMarketManifest(appUpdateJournalStore(), originalInstallMeta, installedApp, manifest, resolvedCatalog.reference);
      if (adopted.moved) {
        emit(onEvent, 1, 1, 'success', adopted.fromChannel
          ? `${appId} now takes its updates from ${resolvedCatalog.source.name} (${adopted.version}); nothing was downloaded or restarted`
          : `${appId} now runs ${resolvedCatalog.source.name}'s new manifest (${adopted.version}) for the same package; nothing was downloaded or restarted`);
        return { success: true, previousVersion: adopted.previousVersion, newVersion: adopted.version, migrationsRun: 0,
          unchanged: true, ...(adopted.fromChannel ? { moved: true } : { manifestUpdated: true }) };
      }
      if (adopted.reason !== 'package-differs') console.warn(`[Market] ${appId} keeps its recorded manifest for now: ${adopted.detail}`);
    } catch (error) {
      // An adoption that did not converge was rolled back (the journal says why); the update goes on as for any app.
      logOperationFailure(`Taking the market manifest of ${appId}`, error);
    }
  }
  // The same package: the manifest decides. The one the record names is up to date; another (a new runtime
  // configuration, or a stopped app) is an ordinary update of the same package. A lower version name than a Market
  // record's is never applied (YE-212), as for any app.
  if (samePackage && (!nativeManifestChanged(installMeta, resolvedCatalog?.reference.digest) || olderMarketVersion(installMeta, targetVersion))) {
    emit(onEvent, 1, 1, 'success', `${appId} is already up to date (${installedVersion})`);
    return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0, unchanged: true };
  }
  if (!samePackage && !isNewer(targetVersion, installedVersion)) {
    emit(onEvent, 1, 1, 'success', `${appId} is already up to date (v${installedVersion})`);
    return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0, unchanged: true };
  }

  // An app added by URL whose new version changes its setup files asks again (decision 7). Compared with the installed
  // copy; nothing is written before the owner allows it.
  if (directEntry && !config.allowSetup) {
    const installedCopy = await readFrozenUpdateManifest(appId).catch(() => directUpdate!.entry.manifest);
    if (setupFilesChanged(installedCopy, manifest)) {
      const setups = manifest.setups.map((setup) => ({ name: setup.name, for: setup.for }));
      const message = `The new version of ${appId} changes its setup steps; allow them to update (allowSetup, youeye app update ${appId} --allow-setup)`;
      emit(onEvent, 1, 1, 'error', message);
      return { success: false, previousVersion: installedVersion, newVersion: targetVersion, migrationsRun: 0, error: message, errorCode: 'setup-changed', setups };
    }
  }

  // An update that needs a newer YouEye waits for the platform (it is never offered).
  try {
    await assertYouEyeRequirement(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(onEvent, 1, 1, 'error', message);
    return { success: false, previousVersion: installedVersion, newVersion: targetVersion, migrationsRun: 0, error: message, errorCode: 'requires-newer-youeye' };
  }

  // Each container has an explicit type ('lxd' | 'oci')
  const containerNames = containerSpecs.map((c) => getContainerName(appId, c.name, containerSpecs.length));
  const lxdContainers = containerSpecs.filter((c) => c.type === 'lxd');
  const ociContainers = containerSpecs.filter((c) => c.type === 'oci');

  // ── Count total steps ──────────────────────────────────

  let totalSteps = 1; // preflight
  totalSteps += containerNames.length; // snapshots

  // LXD containers: fetch metadata + stop service + CP download/stage + extract + start + health each
  totalSteps += lxdContainers.length * 6;
  // OCI containers: stop + rebuild + start per container
  totalSteps += ociContainers.length * 3;
  // Health checks for OCI containers that have them
  totalSteps += ociContainers.filter((c) => c.healthCheck).length;

  totalSteps += 3; // sync UI manifest + save metadata + cleanup

  let step = 0;

  // ── Step 1: Preflight ──────────────────────────────────

  const containerTypes = containerSpecs.map((c) => c.type).join(', ');
  step++;
  emit(onEvent, step, totalSteps, 'running',
    `Updating ${appId} from v${installedVersion} to v${targetVersion} (containers: ${containerTypes})`);

  // Build variable context — preserves existing secrets
  let ctx = await buildCanonicalContext(
    manifest,
    { appId, subdomain: installMeta.subdomain, domain: installMeta.domain },
    undefined, undefined, await generateAppToken(appId),
    installMeta.usePerAppBridge === true,
  );
  const secretValues: Record<string, string> = {};
  ctx.secret = secretValues;

  // Reload existing secrets. A missing one (null) is generated inside the transaction below; one that cannot be
  // read safely is never replaced (the update then fails on it).
  const unreadableSecrets = new Set<string>();
  for (const secret of manifest.secrets) {
    try {
      const value = await readAppSecret(appId, secret.name);
      if (value) secretValues[secret.name] = value;
    } catch {
      unreadableSecrets.add(secret.name);
    }
  }

  emit(onEvent, step, totalSteps, 'success', 'Preflight checks passed');

  const stagedNativeArtifacts = await stageMarketNativeArtifacts(manifest, { appId });

  let attemptedOperation: string | undefined;
  try {
    const preflight = await prepareIncusAppUpdate(originalInstallMeta, manifest);
    ctx = await preflight.provider.configurationContext(ctx);
    // A secret the installed version already declared is never made again, also when it reads as missing or empty
    // (an install before 0.6.3 kept it elsewhere): its data was made with the old value. Stop before any change (YE-217).
    const lost = lostInstalledSecrets(manifest, preflight.old, ctx.secret ?? {});
    if (lost.length) throw new InstalledSecretMissingError(appId, lost);
    const frozenOCI = new Map<string, Awaited<ReturnType<typeof freezeUpdateOCIImage>>>();
    for (const spec of ociContainers) {
      if (installMeta.databaseMode === 'own' && installMeta.containers.find(c => c.name === spec.name)?.role === 'database') continue;
      frozenOCI.set(spec.name, await freezeUpdateOCIImage(spec.image));
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
    // All checkpoints are verified with every writer stopped before any
    // automatic first-start migration. Ordinary ingress remains fenced.
    const runner = <T>(name: string, run: () => Promise<T>) =>
      preflight.provider.withMigrationRunner(transaction.record(), name, run);
    // ── Step 5: Update containers by type ────────────────

    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      if (installMeta.databaseMode === 'own' && installMeta.containers.find(c => c.containerName === name)?.role === 'database') {
        emit(onEvent, step, totalSteps, 'success', `${name} keeps its database engine`);
        continue;
      }

      if (spec.type === 'lxd' && spec.source) {
        // ── LXD path: the package the manifest pins, staged and checked above; extract, restart service ──
        const appDir = '/opt/app';
        const healthEndpoint = spec.healthCheck?.type === 'http' ? spec.healthCheck.path : '/api/health';
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
        await transaction.mutate(`oci-replace-${i}`, async () => {
          await rebuildContainer(name, artifact.image);
          // The new image may link the network files Incus mounts over (YE-215).
          const { replaceSymlinkedNetworkFiles } = await import('@/lib/infrastructure/oci-network-files');
          await replaceSymlinkedNetworkFiles(name);
        });
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);

      }
    }
    // A secret new in this release (the installed version never declared it; say its new admin password) is generated
    // now, before the configuration is rendered: one journaled step each, so a rollback deletes only these (YE-208).
    for (const secret of missingSecrets(manifest, preflight.old, ctx.secret ?? {}, unreadableSecrets)) {
      // Checked again before the journal names it: a rollback deletes what a generate step names, so never one
      // that exists.
      if (await readAppSecret(appId, secret.name) !== null) throw new Error(`The secret ${secret.name} of ${appId} appeared during the update`);
      const value = await transaction.mutate(generatedSecretStep(secret.name), () => createMissingSecret(appId, secret));
      ctx = { ...ctx, secret: { ...ctx.secret, [secret.name]: value } };
      emit(onEvent, step, totalSteps, 'success', `Generated the new secret ${secret.name}`);
    }
    await transaction.mutate('apply-generated-configuration', () => preflight.provider.applyConfiguration(transaction.record(), manifest, ctx));
    // Start order: the app's database and caches are ready before its workers and the app itself start.
    for (const name of preflight.provider.startOrder(transaction.record())) {
      const i = containerNames.indexOf(name);
      if (i < 0) throw new Error(`Installed container ${name} is not in the target manifest`);
      await transaction.mutate(`first-start-${i}`, () => preflight.provider.startRuntime(transaction.record(), name, manifest));
    }
    // Connections to other apps survive the rebuild (Incus keeps devices): re-point their ACLs and prove each NIC is
    // still in place before the app is reopened.
    await transaction.mutate('verify-connections', () => verifyConnections(appId, containerNames));
    for (let i = 0; i < containerSpecs.length; i++) {
      const spec = containerSpecs[i];
      const name = containerNames[i];
      // Check health only after every runtime has the target code/configuration.
      if (spec.healthCheck) {
          step++;
          emit(onEvent, step, totalSteps, 'running', `Waiting for ${name} to be healthy...`);

          const healthy = spec.healthCheck.type === 'postgres'
            ? await waitForPostgresHealth(name, spec.healthCheck.user, spec.healthCheck.timeout)
            : await waitForAppHealth(name, spec.port || 80, spec.healthCheck.path, spec.healthCheck.timeout);

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
    // What the app offers and asks of other apps is the new release's (the suggestions follow after the commit).
    installMeta.provides = manifest.provides?.length ? manifest.provides : undefined;
    installMeta.wants = manifest.wants?.length ? manifest.wants : undefined;
    // The sign-in details Settings → Apps shows are the new release's (an app that gains its own login lists them;
    // one that drops `credentials:` lists none). A rollback restores the previous ones.
    installMeta.credentials = credentialRecords(manifest);
    // productReleaseFloors are not written for native apps any more (YE-142); a record's old floors stay, unread.
    installMeta.catalogKey = `${sourceId}:app:${appId}`;
    installMeta.itemKind = 'app';
    installMeta.sourceId = sourceId;
    installMeta.sourceName = directEntry ? 'Added' : resolvedCatalog!.source.name;
    installMeta.sourceRepoUrl = directEntry?.manifestUrl ?? resolvedCatalog!.source.url;
    installMeta.manifestSource = directEntry?.manifestUrl ?? resolvedCatalog!.source.url;
    if (directEntry) {
      installMeta.manifestPath = directEntry.manifestUrl;
      installMeta.manifestDigest = directEntry.manifestDigest;
    } else if (routing) {
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
      verification: artifact.verification.status,
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
    await transaction.mutate('publish-install-metadata', () => saveInstallMetadata(installMeta));
    // Provenance: the market version installed now (a native app's channel release tag and repository are cleared).
    await transaction.mutate('publish-provenance', () => recordCatalogAppUpdate(appId, targetVersion));
    emit(onEvent, step, totalSteps, 'success', 'Version updated');

    const saved = await readInstallMetadata(appId);
    const installed = await getInstalledApp(appId);
    if (saved?.installedVersion !== targetVersion || installed?.installedVersion !== targetVersion) {
      throw new Error('Installed metadata did not converge with verified runtime');
    }
    return { value: {
      success: true, previousVersion: installedVersion, newVersion: targetVersion,
      migrationsRun: 0, sharedFolders: preflight.inventory.sharedFolders,
    }, metadataDigest: updateDigest(JSON.stringify(saved)) };
    }, id => { attemptedOperation = id; });
    // Current ownership is reconciled only after durable commit and cleanup.
    // Namespace declarations are additive and do not restore old grants.
    const { bindInstalledAdmission } = await import('@/lib/admission/lifecycle');
    await bindInstalledAdmission(installMeta);
    const { reconcileAdmissionProjections } = await import('@/lib/admission/projection');
    await reconcileAdmissionProjections();
    // Connection suggestions follow the release's `connects`: dropped ones go, new ones appear.
    if (result.success) {
      const { refreshSuggestionsForUpdatedApp } = await import('@/lib/bridges/suggestions');
      await refreshSuggestionsForUpdatedApp(manifest)
        .catch((error) => logOperationFailure(`Refreshing the connection suggestions of ${appId}`, error));
    }
    // The Market listing of an Added app now shows what is installed (the copy the owner agreed to).
    if (directUpdate && result.success) {
      await saveDirectMarketApp({ manifestUrl: directUpdate.entry.manifestUrl, manifest })
        .catch((error) => logOperationFailure(`Recording the updated Added app ${appId}`, error));
    }
    return { ...result, operationId: attemptedOperation };
  } catch (error) {
    logOperationFailure(`Update of ${appId} (operation ${attemptedOperation ?? 'not admitted'})`, error);
    const record = attemptedOperation ? appUpdateJournalStore().read(attemptedOperation) : undefined;
    const committed = !!record?.commit;
    // Never "success" while the app is still behind the maintenance fence; never "in maintenance" once it reopened.
    const reopened = !!record?.steps.some(s => s.id === 'reopen-compatible-app' && s.state === 'completed');
    // Not committed and its rollback not verified: recovery failed. The app is in maintenance, whatever failed first.
    const recoveryFailed = !!record && !committed && !record.rollbackVerifiedAt;
    const message = committed
      ? reopened
        ? `Version ${targetVersion} is installed and the app is open, but a step after the update failed `
          + '(checkpoint cleanup or access reconciliation); the cause is in the Control Panel journal.'
        : `Version ${targetVersion} is installed, but reopening the app did not finish; it stays in maintenance until `
          + `recovery succeeds (youeye app recover ${appId}).`
      : recoveryFailed
        ? 'Update recovery requires attention. Maintenance reservations and checkpoints are retained.'
        : error instanceof Error ? error.message : 'Application update failed.';
    emit(onEvent, step, totalSteps, 'error', message);
    return {
      success: false, previousVersion: installedVersion,
      newVersion: committed ? targetVersion : installedVersion,
      migrationsRun: 0, error: message, operationId: attemptedOperation,
      errorCode: committed ? (reopened ? 'committed-post-update-failed' : 'committed-reopen-pending')
        // Never the first failure's code (a stop timeout says "Nothing was changed"): the failed recovery is the news.
        : recoveryFailed ? 'recovery_required'
        : !attemptedOperation && isLifecycleBusy(error) ? 'operation_in_progress'
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    };
  } finally {
    await stagedNativeArtifacts.cleanup();
  }
}

/** Every active network connection of the app still has its NIC, and its ACL points at the peer's current address. */
async function verifyConnections(appId: string, containerNames: string[]): Promise<void> {
  const { refreshConnectionGrants } = await import('@/lib/bridges/manager');
  const { loadBridges } = await import('@/lib/bridges/store');
  // A refresh failure can come from the peer's side (its record or ACL): log it, never roll this app back for it.
  // The 30 s reconcile pass retries. Only a missing NIC on this app fails the update.
  const failed = await refreshConnectionGrants(appId);
  if (failed.length) console.warn(`[Market] Update of ${appId}: connection ACLs not refreshed for ${failed.join(', ')}`);
  for (const bridge of await loadBridges()) {
    if (!bridge.active || bridge.accessMode === 'proxy' || bridge.accessMode === 'caddy') continue;
    const peer = bridge.from === appId ? bridge.to : bridge.to === appId && bridge.direction === 'both-ways' ? bridge.from : null;
    if (!peer) continue;
    let found = false;
    for (const name of containerNames) {
      const instance = await incusRequest<{ expanded_devices?: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
      if (instance.type !== 'error' && instance.metadata?.expanded_devices?.[`net-${peer}`]?.type === 'nic') { found = true; break; }
    }
    if (!found) throw new Error(`The connection to ${peer} lost its network interface during the update`);
  }
}

/**
 * One app update at a time on the box. Updates no longer reserve shared resources (a stuck one must not block other
 * apps), so this in-process queue keeps two from racing each other's Caddy fence writes and free-space checks.
 */
const updateQueue = globalThis as typeof globalThis & { __youeyeAppUpdateTail?: Promise<void>; __youeyeAppUpdateRunning?: number };
async function oneUpdateAtATime<T>(work: () => Promise<T>): Promise<T> {
  const previous = updateQueue.__youeyeAppUpdateTail ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  updateQueue.__youeyeAppUpdateTail = previous.then(() => mine, () => mine);
  // A user's update waits as long as any user operation (30 s) for the one before it, then answers busy; outside a
  // user operation it waits its turn.
  const budget = (globalThis as Record<symbol, { getStore?: () => { timeoutMs?: number } | undefined } | undefined>)[
    Symbol.for('youeye.lifecycle-lock-wait')]?.getStore?.()?.timeoutMs;
  if (budget !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const turn = await Promise.race([
      previous.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), budget); }),
    ]);
    clearTimeout(timer);
    if (!turn) {
      release();
      throw Object.assign(new Error('Another app update is running; try again when it finishes'), { code: 'operation_in_progress' });
    }
  } else {
    await previous.catch(() => undefined);
  }
  updateQueue.__youeyeAppUpdateRunning = (updateQueue.__youeyeAppUpdateRunning ?? 0) + 1;
  try { return await work(); } finally {
    updateQueue.__youeyeAppUpdateRunning = Math.max(0, (updateQueue.__youeyeAppUpdateRunning ?? 1) - 1);
    release();
  }
}

/**
 * Re-record every native app whose market pins the very package it runs under another manifest, metadata only
 * (`adoptNativeMarketManifest`): one installed from the channel before 0.6.20 moves to its market (YE-142), a Market one
 * takes its market's new manifest (YE-194). The update check runs it first (so also once right after the Control Panel
 * starts). The digests are compared without any lock, and only an app whose market manifest changed is re-recorded,
 * under the same exclusion as its update (YE-210, `native-adoption.ts`). A failure only leaves that app on its record
 * (another runtime configuration stays offered as an ordinary update).
 */
export async function adoptNativeMarketManifests(): Promise<string[]> {
  const { getAllInstalledApps } = await import('./installed-apps');
  const { adoptChangedNativeManifests } = await import('./native-adoption');
  return adoptChangedNativeManifests({
    appIds: async () => (await getAllInstalledApps()).map(app => app.appId),
    updateRunning: () => Boolean(updateQueue.__youeyeAppUpdateRunning),
    eligible: async (appId) => {
      const meta = await readInstallMetadata(appId);
      return meta?.integration === 'native' && meta.serviceCredentialState === 'ready';
    },
    plan: nativeAdoptionPlan,
    locked: (appId, work) => oneUpdateAtATime(() => withAppLifecycle(appId, () => withAppNetworkOperationLock(appId, 'update', work))),
    adopt: async (appId, plan) => {
      try {
        const outcome = await adoptNativeMarketManifest(appUpdateJournalStore(), plan.before, plan.installed, plan.resolved.manifest, plan.resolved.reference);
        if (!outcome.moved && outcome.reason !== 'stopped') moveAttempts().set(appId, plan.attempt);
        return outcome;
      } catch (error) {
        moveAttempts().set(appId, plan.attempt);
        throw error;
      }
    },
    report: (appId, outcome) => {
      if (outcome.moved) {
        moveAttempts().delete(appId);
        console.log(outcome.fromChannel
          ? `[Market] ${appId} moved to its market at ${outcome.version} (no download, no restart)`
          : `[Market] ${appId} took its market's new manifest at ${outcome.version} for the same package (no download, no restart)`);
      } else if (outcome.reason !== 'package-differs') {
        console.warn(`[Market] ${appId} keeps its recorded manifest for now: ${outcome.detail}`);
      }
    },
    failed: (appId, error) => logOperationFailure(`Taking the market manifest of ${appId}`, error),
  });
}

/**
 * Read-only: the market manifest a native app would take, or null when its record already has it, the app follows a
 * URL, its market can't be read, or this record and manifest were tried already without taking.
 */
async function nativeAdoptionPlan(appId: string) {
  const before = await readInstallMetadata(appId);
  const installed = await getInstalledApp(appId);
  if (!before || !installed || before.integration !== 'native') return null;
  const sourceId = recordedCatalogSourceIds(installed, before)[0];
  // An app added by URL re-reads its URL only when the owner updates it.
  if (sourceId?.startsWith('direct:')) return null;
  const resolved = await resolveCatalogApp(appId, sourceId).catch(() => null);
  if (!resolved || !nativeManifestChanged(before, resolved.reference.digest)) return null;
  // An app that could not take it is tried again only once its record, its market's manifest or this box's YouEye
  // version changed (a stopped app every time: it takes it once it runs). The version is part of it because a
  // manifest that needs a newer YouEye waits for the box's update (YE-212), and an unknown version ("0.0.0" while
  // Spine does not answer) must not hold the app back once Spine says which it is.
  const platform = await import('./platform-env').then(m => m.getPlatformContext()).then(c => c.version, () => '');
  const attempt = `${updateDigest(JSON.stringify(before))}\0${resolved.reference.repo}\0${resolved.reference.digest}\0${platform}`;
  if (moveAttempts().get(appId) === attempt) return null;
  return { before, installed, resolved, attempt };
}

/** The last adoption tried per app that did not take (record digest, market address, manifest digest, YouEye version). */
function moveAttempts(): Map<string, string> {
  const registry = globalThis as typeof globalThis & { __youeyeNativeMoveAttempts?: Map<string, string> };
  registry.__youeyeNativeMoveAttempts ??= new Map();
  return registry.__youeyeNativeMoveAttempts;
}

export async function updateMarketApp(config: UpdateConfig, onEvent: InstallEventCallback): Promise<UpdateResult> {
  return oneUpdateAtATime(() => withAppLifecycle(config.appId, () => updateMarketAppUnderLifecycle(config, onEvent)));
}
