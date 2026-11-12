/**
 * Unified App Updater.
 *
 * Supports two update paths based on container.type:
 *   - LXD (container.type === 'lxd'): fetch tarball from the configured release source, extract, restart service
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
import { clearCatalogCache, resolveCatalogApp } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import {
  getInstalledApp,
  recordAppProvenance,
  recordCatalogAppUpdate,
} from './installed-apps';
import { getContainerName } from './engine-helpers';
import { assertYouEyeRequirement, buildCanonicalContext, generateAppToken } from './platform-env';
import { withAppNetworkOperationLock } from '../incus/app-network';
import { readAppSecret } from '../infrastructure/secrets';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { isNewer } from '@/lib/version';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import {
  classifyAppUpdateRouting,
  recordedCatalogSourceIds,
} from './update-routing';
import { refreshDirectMarketApp } from './direct-apps';
import { nativeManifestFromRelease, nativeManifestReference, resolveNativeProduct, stageMarketNativeArtifacts, type StagedMarketNativeArtifact } from './native-artifact';
import { acceptProductSequence, type VerifiedProductRelease } from '../releases/product-release';
import { updateIdenticalProductRelease } from './update-release-metadata';
import type {
  AppManifest,
  InstallEventCallback,
  InstallEvent,
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
  emit(onEvent, step, totalSteps, 'success', `Preflight accepted v${artifact.version} (product release digest)`);

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

  const { publishProductProjection } = await import('../releases/product-projection');
  artifact.runtimeUUID = await publishProductProjection(containerName,artifact.productRelease);

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

  // Classify before any release lookup or runtime mutation. A native app's
  // candidate is its product release on the box's channel index.
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
  }) : null;

  let manifest: AppManifest;
  let productRelease: VerifiedProductRelease | null = null;
  let channelManifestReference: { path: string; repo: string; branch: string; digest: string } | null = null;
  if (routing?.kind === 'channel') {
    try {
      productRelease = await resolveNativeProduct(appId);
      const native = await nativeManifestFromRelease(productRelease);
      // No downgrade: an older channel head is rejected here (the box waits).
      acceptProductSequence(installMeta.productReleaseFloors, productRelease);
      manifest = native.manifest;
      channelManifestReference = nativeManifestReference(productRelease, manifest);
    } catch (err) {
      throw new Error(`Failed to resolve the ${appId} release of this channel: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    manifest = directEntry?.manifest ?? resolvedCatalog!.manifest;
  }

  const installedVersion = installedApp.installedVersion || '0.0.0';
  const targetVersion = productRelease ? productRelease.release.version : (manifest.version || '0.0.0');
  const containerSpecs = manifest.containers || [];
  const sourceId = directEntry?.sourceId ?? resolvedCatalog!.source.id;
  if (productRelease) {
    // Only no-op when the exact release document is what's installed.
    const installedRelease = installMeta.nativeArtifacts?.[0]?.productReleaseSHA256;
    if (!config.force && installedRelease === productRelease.manifestSHA256) {
      emit(onEvent, 1, 1, 'success', `${appId} is already up to date (${productRelease.release.version})`);
      return { success: true, previousVersion: installedVersion, newVersion: installedVersion, migrationsRun: 0 };
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

  // Reload existing secrets
  for (const secret of manifest.secrets) {
    try {
      const value = await readAppSecret(appId, secret.name);
      if (value) secretValues[secret.name] = value;
    } catch { /* secret may not exist */ }
  }

  emit(onEvent, step, totalSteps, 'success', 'Preflight checks passed');

  const stagedNativeArtifacts = await stageMarketNativeArtifacts(
    manifest,
    { appId },
    productRelease ? { selected: productRelease } : {},
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
        emit(onEvent, step, totalSteps, 'success', `${name} retains its exact PostgreSQL runtime`);
        continue;
      }

      if (spec.type === 'lxd' && spec.source) {
        // ── LXD path: fetch tarball from the configured release source, extract, restart service ──
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
        await transaction.mutate(`oci-replace-${i}`, () => rebuildContainer(name, artifact.image));
        emit(onEvent, step, totalSteps, 'success', `${name} rebuilt`);

      }
    }
    await transaction.mutate('apply-generated-configuration', () => preflight.provider.applyConfiguration(transaction.record(), manifest, ctx));
    for (let i = 0; i < containerSpecs.length; i++) {
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
      verification: artifact.verification.status,
      productReleaseSHA256: artifact.verification.releaseSHA256,
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
    // Provenance: what tag/branch/source is actually installed now.
    if (productRelease) {
      const selected = productRelease;
      await transaction.mutate('publish-provenance', () => recordAppProvenance(appId, {
        version: selected.release.version,
        tag: selected.release.tag,
        branch: null,
        source: selected.repository,
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
      migrationsRun: 0,
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
      migrationsRun: 0, error: message,
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
