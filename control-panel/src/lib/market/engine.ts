/**
 * Market deployment engine.
 * Unified YAML-driven installer — no more native/Market-installed branching.
 *
 * Flow for ANY app:
 * 1. Parse & validate manifest
 * 2. Generate secrets
 * 3. Setup shared PostgreSQL (if database.mode === 'shared')
 * 4. Write config files
 * 5. Create identity-provider SSO client (if sso section exists)
 * 6. Generate app token
 * 7. Build canonical context + resolve env_mapping
 * 8. Deploy containers (universal loop: lxd or oci per container)
 * 9. SSO configure steps (api or cli)
 * 10. Add Caddy route
 * 11. Save metadata
 * 12. Register with UI dashboard
 */

import { withAppInventory, withAppLifecycle } from './update-admission';
import type { OCIManifest } from '../infrastructure/types';
import type {
  AppManifest,
  ContainerSpec,
  ContainerMeta,
  InstallConfig,
  InstallEvent,
  InstallEventCallback,
  InstallMetadata,
  RestoreOptions,
  StorageVolumeMeta,
} from './types';
import { existsSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { resolveVariables, resolveEnvironment } from './variables';
import { deepestConfigStorageMount, enforceAllConfigFilePermissions, writeAllConfigFiles } from './config-writer';
import {
  listInstalledApps,
  listRetainedApps,
  saveInstallMetadata,
  removeInstallMetadata,
  removeInstallMetadataRecord,
  readInstallMetadata,
} from './metadata';
import { getInstalledApp, upsertInstalledApp, removeInstalledApp } from './installed-apps';
import { deployOCIContainer, startOCIContainer } from '../infrastructure/oci-deployer';
import { adoptRestoredLXDContainer, deployMarketLXDContainer } from '../infrastructure/lxd-deployer';
import { execCommand, incusRequest, incusUploadFile, incusDownloadFile } from '../incus/server';
import { applyResourcePolicy } from '../infrastructure/resource-policy';
import { execShell } from '../incus/server';
import {
  getOrCreateAppSecret,
  generatePassword,
  generateSecretKey,
  generateHexToken,
  readAppSecret,
  writeAppSecret,
  deleteAllAppSecrets,
} from '../infrastructure/secrets';
import { addRoute, getRoutes, removeRoute, migrateSystemUpstreamsToIPv4, resolveCaddyUpstreamDial } from '../caddy/client';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import { runSetup, setupFor } from './setup-runner';
import {
  createOAuthClient,
  getIdentityProviderConfig,
  removeForwardAuth,
  removeOAuthClient,
} from '@/lib/identity/provider';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import {
  buildCanonicalContext,
  resolveEnvMapping,
  generateAppToken,
  envToString,
  getPlatformContext,
  assertYouEyeRequirement,
} from './platform-env';
import { getContainerName, leftoverAppPaths } from './engine-helpers';
import { assertContainerNamesAvailable, assertInstancesAbsent, deleteOwnedInstance, InstanceOwnershipError } from './instance-ownership';
import { resolveSharedDatabasePasswordFile } from '@/lib/backup/manifest-values';
import { CONTAINER_DOMAIN } from './constants';
import {
  createAppNetwork,
  addCaddyToAppNetwork,
  getSystemServices,
  addSystemProxyDevices,
  removeSystemProxyDevices,
  applyAppEgressAcl,
  buildAppNIC,
  getAppNetworkLease,
  markAppNetworkCleanupPending,
  markAppNetworkActive,
  preflightAppNetwork,
  prepareAppEgressAcl,
  setAppNetworkNAT,
  withAppNetworkOperationLock,
  AppNetworkOperationConflictError,
  appContainerAddress,
} from '../incus/app-network';
import { injectCaddyRootCA, removeCaddyTrustBundle, stageCaddyTrustBundle } from './caddy-ca';
import { activatePendingBridges, pushConnectionsToUI } from '../bridges/manager';
import { generateSuggestionsForApp } from '../bridges/suggestions';
import { logOperationFailure } from './install-tracker';
import { getUserById } from '@/lib/identity/store';
import { assertRestoredManagedAI, type RestoredManagedAI } from './restored-managed-ai';
import {
  stageMarketNativeArtifacts,
  type StagedMarketNativeArtifacts,
} from './native-artifact';
import {
  acknowledgePointerCredential,
  archivePointerManagedApp,
  ensurePointerManagedApp,
  listPointerActorGroups,
  readPointerManagedApp,
  type PointerManagedInstallation,
} from '@/lib/pointer/managed-apps';
import { deleteAppStorage, ensureAppStorage, volumesForContainer } from './storage';
import { spineClient } from '../spine/client';
import { appServiceCredentials } from '../apps/service-credential-store';
import { prepareCredentialForAppInstall } from '../apps/service-credential-lifecycle';
import { activateProvisionedCredential, revokeAppCredential, AppServiceIntegrationPending } from '../apps/service-credential-bridge';
import { probeNativeAppCredential, quiesceAppCredentialRuntime } from '../apps/service-credential-probe';
import { assertPrivateCredentialMapping, assertPrivateCredentialConfig } from '../apps/service-credential-runtime';

// ─── Install Rollback ─────────────────────────────────────

interface RollbackContext {
  containerNames: string[];
  appId: string;
  /** Rollback deletes only instances tagged with this installation. */
  installationId?: string;
  ssoSlug?: string;
  forwardAuthSlug?: string;
  subdomain?: string;
  domain?: string;
  dbName?: string;
  dbUser?: string;
  databaseCreated?: boolean;
  databaseUserCreated?: boolean;
  dataPaths?: string[];
  storageVolumes?: StorageVolumeMeta[];
  createdStorageVolumes?: Set<string>;
  preserveData?: boolean;
  aiExternalInstallationId?: string;
  aiProvisioned?: boolean;
  rollbackResult?: RollbackResult;
  credentialProvisioned?: boolean;
}

interface RollbackResult {
  clean: boolean;
  cleanupPending: boolean;
  errors: string[];
}

async function rollbackInstall(
  ctx: RollbackContext,
  onEvent: InstallEventCallback,
  totalSteps: number
): Promise<RollbackResult> {
  if (ctx.rollbackResult) return ctx.rollbackResult;
  onEvent({ step: 0, totalSteps, status: 'running', message: 'Rolling back failed install...' });
  const errors: string[] = [];

  const recordFailure = (resource: string, _error: unknown): void => {
    void _error;
    // Cleanup errors can embed dependency responses or generated credentials.
    // Persist/log only the failed resource; Health owns sensitivity-safe detail.
    const message = `${resource}: cleanup or verification failed`;
    errors.push(message);
    console.error(`[engine] Rollback failed for ${message}`);
  };

  // Deny the installation generation before removing its runtime/registration.
  // A failed bridge delivery retains a tombstone/outbox for later repair.
  if (ctx.credentialProvisioned) {
    try { await revokeAppCredential(ctx.appId); } catch (error) { recordFailure('service credential', error); }
  }

  // 1. Remove containers: the exact names this install created, and only when they carry
  // this installation's tag. A same-name instance owned by anything else stays untouched.
  for (const name of ctx.containerNames) {
    try {
      await deleteOwnedInstance(name, ctx.installationId ? { appId: ctx.appId, installationId: ctx.installationId } : undefined);
    } catch (err) {
      recordFailure(`container ${name}`, err);
    }
  }

  // 2. Remove Caddy route (exact hostname only)
  if (ctx.subdomain && ctx.domain) {
    try {
      const hostname = `${ctx.subdomain}.${ctx.domain}`;
      const routes = await getRoutes();
      for (const route of routes) {
        if (route.hostname === hostname) {
          await removeRoute(route.id);
        }
      }
      const remainingRoutes = await getRoutes();
      if (remainingRoutes.some((route) => route.hostname === hostname)) {
        throw new Error('Caddy routes still exist after rollback removal');
      }
    } catch (err) {
      recordFailure('Caddy route', err);
    }
  }

  // 3. Remove identity SSO client
  if (ctx.ssoSlug) {
    try {
      await removeOAuthClient(ctx.ssoSlug);
      const { getClient } = await import('@/lib/identity/store');
      if (await getClient(ctx.ssoSlug)) throw new Error('identity client remains');
    } catch (err) {
      recordFailure('identity client', err);
    }
  }

  // 3c. Remove exact app DNS records. Missing records are already clean.
  if (ctx.subdomain && ctx.domain) {
    try {
      const { getCNAMERecords, getDNSRecords, removeCNAMERecord, removeDNSRecord } = await import('../apps/pihole-api');
      const hostname = `${ctx.subdomain}.${ctx.domain}`;
      for (const record of await getCNAMERecords()) {
        if (record.domain === hostname) await removeCNAMERecord(record.domain, record.target);
      }
      for (const record of await getDNSRecords()) {
        if (record.domain === hostname) await removeDNSRecord(record.ip, record.domain);
      }
      const [remainingCNAMEs, remainingRecords] = await Promise.all([getCNAMERecords(), getDNSRecords()]);
      if (remainingCNAMEs.some((record) => record.domain === hostname)
        || remainingRecords.some((record) => record.domain === hostname)) {
        throw new Error('app DNS records remain');
      }
    } catch (err) {
      recordFailure('app DNS records', err);
    }
  }

  // 3b. Remove identity forward-auth route
  if (ctx.forwardAuthSlug) {
    try {
      if (ctx.subdomain && ctx.domain) {
        await removeForwardAuth({ hostname: `${ctx.subdomain}.${ctx.domain}` });
      }
    } catch (err) {
      recordFailure('forward-auth route', err);
    }
  }

  // 4. Drop shared database
  if (ctx.dbName && ctx.dbUser && (ctx.databaseCreated || ctx.databaseUserCreated)) {
    try {
      const safeIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
      if (!safeIdentifier.test(ctx.dbName) || !safeIdentifier.test(ctx.dbUser)) {
        throw new Error('Invalid shared database identifier in rollback context');
      }
      const commands = [
        ...(ctx.databaseCreated ? [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${ctx.dbName}' AND pid <> pg_backend_pid()`,
          `DROP DATABASE IF EXISTS "${ctx.dbName}"`,
        ] : []),
        ...(ctx.databaseUserCreated ? [`DROP ROLE IF EXISTS "${ctx.dbUser}"`] : []),
      ];
      for (const sql of commands) {
        const result = await execCommand(
          'youeye-postgres',
          ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-c', sql],
          { timeout: 10_000 },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'database rollback failed');
      }
      const verify = await execCommand(
        'youeye-postgres',
        [
          'psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-tAc',
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='${ctx.dbName}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ctx.dbUser}') THEN 1 ELSE 0 END`,
        ],
        { timeout: 10_000 },
      );
      if (verify.exitCode !== 0 || verify.stdout.trim() === '1') {
        throw new Error('shared database resources remain');
      }
    } catch (err) {
      recordFailure('shared database', err);
    }
  }

  // Revoke the per-installation Pointer credential before deleting the local
  // protected copy or releasing the app network.
  if (ctx.aiProvisioned && ctx.aiExternalInstallationId) {
    try {
      const archived = await archivePointerManagedApp(ctx.aiExternalInstallationId);
      if (!archived.archived || !archived.credentialsRevoked) {
        throw new Error('Pointer did not confirm credential revocation');
      }
    } catch (err) {
      recordFailure('Pointer AI connection', err);
    }
  }

  // 5. Remove the generated CA directory (always: it is regenerated on install), and the
  // generated secrets and new-app data. Install metadata remains the durable recovery map
  // until every other resource is verified absent.
  try {
    await removeCaddyTrustBundle(ctx.appId);
  } catch (err) {
    recordFailure('generated CA directory', err);
  }
  if (!ctx.preserveData) {
    try {
      await deleteAllAppSecrets(ctx.appId);
      const { rm } = await import('fs/promises');
      await Promise.all((ctx.dataPaths ?? []).map((target) => rm(target, { recursive: true, force: true })));
      if ((ctx.dataPaths ?? []).some((target) => existsSync(target))) {
        throw new Error('one or more app data paths remain');
      }
    } catch (err) {
      recordFailure('generated app data', err);
    }
  }

  if (!ctx.preserveData && ctx.storageVolumes?.length) {
    try {
      await deleteAppStorage(ctx.storageVolumes, { onlyCreated: ctx.createdStorageVolumes });
    } catch (err) {
      recordFailure('Incus app storage', err);
    }
  }

  // 6. Remove explicit integration NICs before the primary bridge.
  try {
    const { getBridgesForApp, deleteBridge } = await import('../bridges/manager');
    for (const bridge of await getBridgesForApp(ctx.appId)) await deleteBridge(bridge.id);
    if ((await getBridgesForApp(ctx.appId)).length > 0) throw new Error('integration records remain');
  } catch (err) {
    recordFailure('integration grants', err);
  }

  // 6b. Remove any late dashboard registration before releasing recovery
  // ownership. A missing record is already clean.
  try {
    await unregisterAppWithUI(ctx.appId);
    const { isAppRegisteredWithUI } = await import('./reconciler');
    if (await isAppRegisteredWithUI(ctx.appId)) throw new Error('UI registration remains');
  } catch (err) {
    recordFailure('UI registration', err);
  }

  // Hide incomplete state before releasing the only durable network owner.
  // Install metadata remains available to reconciliation until final cleanup.
  try {
    await removeInstalledApp(ctx.appId);
    if (await getInstalledApp(ctx.appId)) throw new Error('installed-app record remains');
  } catch (err) {
    recordFailure('installed-app record', err);
  }

  // 7. Clean up per-app bridge network. deleteAppNetwork retains an explicit
  // cleanup_pending lease when absence cannot be proved.
  if (errors.length === 0) {
    try {
      const { removeCaddyFromAppNetwork, deleteAppNetwork } = await import('../incus/app-network');
      await removeSystemProxyDevices(ctx.appId);
      await removeCaddyFromAppNetwork(ctx.appId);
      await deleteAppNetwork(ctx.appId);
    } catch (err) {
      recordFailure('app network', err);
    }
  } else {
    try {
      await markAppNetworkCleanupPending(ctx.appId, 'install-rollback', errors.join('; '));
    } catch (err) {
      recordFailure('cleanup_pending state', err);
    }
  }

  let lease = await getAppNetworkLease(ctx.appId).catch((error) => {
    recordFailure('lease verification', error);
    return null;
  });

  // Install metadata is the final postcondition.
  if (errors.length === 0 && !lease) {
    try {
      if (ctx.preserveData) await removeInstallMetadataRecord(ctx.appId);
      else await removeInstallMetadata(ctx.appId);
    } catch (err) {
      recordFailure('install metadata', err);
    }
  }
  // Re-read after final metadata work so a failed observation can never be
  // mistaken for a released lease.
  lease = await getAppNetworkLease(ctx.appId).catch((error) => {
    recordFailure('final lease verification', error);
    return null;
  });
  const cleanupPending = lease?.state === 'cleanup_pending';
  const clean = errors.length === 0 && !lease;
  const result = { clean, cleanupPending, errors };
  ctx.rollbackResult = result;

  if (clean) {
    const { resolveIssue } = await import('@/lib/health/issues');
    await resolveIssue(`market.install.rollback.${ctx.appId}`);
    onEvent({ step: 0, totalSteps, status: 'success', message: 'Rollback verified clean — all created resources are absent' });
  } else {
    const retained = cleanupPending && lease
      ? ` Lease ${lease.bridgeName} (${lease.cidr}) remains cleanup_pending and is not reusable.`
      : '';
    onEvent({
      step: 0,
      totalSteps,
      status: 'error',
      message: 'Rollback incomplete — supported recovery is required',
      detail: `${errors.join('; ')}${retained}`.trim(),
    });
    const { observeIssue } = await import('@/lib/health/issues');
    await observeIssue({
      id: `market.install.rollback.${ctx.appId}`,
      severity: 'critical',
      source: 'market-install',
      title: `Install cleanup required for ${ctx.appId}`,
      body: `Failed install cleanup retained ${errors.length} unresolved item(s).${retained}`,
      fixable: true,
      repairFn: 'reconcile-apps',
      learnMore: '/settings/system/health',
      debounce: 1,
    });
  }
  return result;
}

// ─── Helpers ──────────────────────────────────────────────

/** The install-time toggle for YouEye ID sign-in of an app whose SSO needs a setup file. */
const IDENTITY_SIGN_IN = 'youeye-id';

function hasSSOSetup(manifest: AppManifest): boolean {
  return Boolean(manifest.sso && setupFor(manifest, 'sso'));
}

function getDefaultSelectedIntegrations(manifest: AppManifest): string[] {
  return hasSSOSetup(manifest) ? [IDENTITY_SIGN_IN] : [];
}

function getSelectedIntegrations(manifest: AppManifest, config: InstallConfig): string[] {
  return config.selectedIntegrations ?? getDefaultSelectedIntegrations(manifest);
}

function usesManagedAI(manifest: AppManifest, config: InstallConfig): boolean {
  return manifest.capabilities?.ai_api === true && config.aiSettings?.enabled === true;
}

function managedAIIconUrl(manifest: AppManifest): string | undefined {
  const value = manifest.metadata.iconUrl;
  if (!value) return undefined;
  return /^https:\/\//.test(value) || value.startsWith('/api/market/image?')
    ? value
    : undefined;
}

async function managedAIActor(config: InstallConfig) {
  const ownerUserId = config.aiSettings?.ownerUserId;
  if (!ownerUserId) throw new Error('AI Settings owner identity is unavailable');
  const user = await getUserById(ownerUserId);
  if (!user || !user.is_admin) {
    throw new Error('AI Settings require an active YouEye administrator account');
  }
  return {
    id: user.id,
    name: user.name || user.username,
    isAdmin: true,
  };
}

async function preflightManagedAISelection(
  manifest: AppManifest,
  config: InstallConfig
): Promise<void> {
  if (!usesManagedAI(manifest, config)) return;
  const actor = await managedAIActor(config);
  const groups = await listPointerActorGroups(actor);
  const selected = config.aiSettings?.modelGroupId
    ? groups.find((group) => group.id === config.aiSettings?.modelGroupId)
    : groups.find((group) => group.isDefault);
  if (!selected) throw new Error('The selected AI model group is unavailable');
  if (selected.status === 'empty' || selected.enabledModelCount === 0) {
    throw new Error('The selected AI model group has no enabled models');
  }
  config.aiSettings = {
    ...config.aiSettings!,
    modelGroupId: selected.id,
    groupName: selected.name,
    externalInstallationId:
      config.aiSettings?.externalInstallationId
      || `market:${manifest.metadata.id}:${randomUUID()}`,
  };
}

function managedAIConnection(
  config: InstallConfig,
  installation: PointerManagedInstallation
): NonNullable<InstallMetadata['aiConnection']> {
  if (
    !config.aiSettings?.ownerUserId
    || !installation.routingOwner
    || !installation.selectedGroup
    || !installation.credential
  ) {
    throw new Error('Pointer returned an incomplete managed application lifecycle record');
  }
  return {
    externalInstallationId: installation.externalInstallationId,
    pointerInstallationId: installation.pointer.installationId,
    pointerInstanceId: installation.pointer.instanceId,
    ownerUserId: config.aiSettings.ownerUserId,
    pointerOwnerId: installation.routingOwner.id,
    modelGroupId: installation.selectedGroup.id,
    groupName: installation.selectedGroup.name,
    keyPreview: installation.credential.preview,
    credentialSecret: 'pointer_api_key',
    defaultModel: 'default',
    state: installation.state === 'active' ? 'active' : 'needs_attention',
  };
}

async function provisionManagedAI(
  manifest: AppManifest,
  config: InstallConfig,
  rollbackCtx: RollbackContext,
  restored?: RestoredManagedAI,
): Promise<NonNullable<InstallMetadata['aiConnection']> | null> {
  if (!usesManagedAI(manifest, config)) return null;
  const actor = await managedAIActor(config);
  const externalInstallationId = config.aiSettings?.externalInstallationId;
  const groupId = config.aiSettings?.modelGroupId;
  if (!externalInstallationId || !groupId) {
    throw new Error('AI Settings preflight did not produce an exact installation and group');
  }
  if (restored) {
    // Paired restore already recovered the installation and acknowledged key.
    // Do not ensure/rotate/archive that binding or mark it provisioned for rollback.
    if (externalInstallationId !== restored.externalInstallationId || groupId !== restored.modelGroupId
      || actor.id !== restored.ownerUserId) throw new Error('Restore AI Settings identity changed');
    const current = await readPointerManagedApp(externalInstallationId, actor);
    const credential = await readAppSecret(manifest.metadata.id, 'pointer_api_key');
    assertRestoredManagedAI(manifest.metadata.id, restored, current, credential);
    config.aiSettings = { ...config.aiSettings!, runtimeCredential: credential! };
    return { ...managedAIConnection(config, current), state: restored.state };
  }
  const ensured = await ensurePointerManagedApp({
    actor,
    externalInstallationId,
    appId: manifest.metadata.id,
    displayName: config.customName || manifest.metadata.name,
    appVersion: manifest.version,
    groupId,
    iconUrl: managedAIIconUrl(manifest),
  });
  const delivery = ensured.credentialDelivery;
  if (!delivery?.credential) {
    throw new Error('Pointer did not provide the new application credential');
  }
  rollbackCtx.aiProvisioned = true;
  await writeAppSecret(manifest.metadata.id, 'pointer_api_key', delivery.credential);
  const protectedReadBack = await readAppSecret(manifest.metadata.id, 'pointer_api_key');
  if (protectedReadBack !== delivery.credential) {
    throw new Error('The protected application credential did not read back exactly');
  }
  await acknowledgePointerCredential({
    actor,
    externalInstallationId,
    deliveryId: delivery.id,
  });
  const activated = await readPointerManagedApp(externalInstallationId, actor);
  config.aiSettings = {
    ...config.aiSettings!,
    runtimeCredential: delivery.credential,
    pointerInstallationId: activated.pointer.installationId,
    pointerInstanceId: activated.pointer.instanceId,
    pointerOwnerId: activated.routingOwner?.id,
    groupName: activated.selectedGroup?.name,
    keyPreview: activated.credential?.preview,
  };
  return managedAIConnection(config, activated);
}

function shouldEnableSSO(manifest: AppManifest, selectedIntegrations: string[]): boolean {
  if (!manifest.sso) return false;
  if (!hasSSOSetup(manifest)) return true;
  return selectedIntegrations.includes(IDENTITY_SIGN_IN);
}

function oauthScopesForManifest(manifest: AppManifest): string[] {
  const scopes = new Set(['openid', 'profile', 'email', 'groups']);
  if (manifest.sso?.role_claim) scopes.add(manifest.sso.role_claim.claim);
  return [...scopes];
}

function countSteps(manifest: AppManifest, ssoEnabled: boolean, managedAI = false): number {
  let steps = 1; // Generate secrets

  if (managedAI) steps++;

  // Database setup
  const dbMode = manifest.database?.mode ?? 'none';
  if (dbMode === 'shared') steps++;

  if (ssoEnabled) steps++; // Create YouEye ID client

  // Containers
  steps += manifest.containers.length; // Deploy each
  steps += manifest.containers.filter((c) => c.healthCheck).length; // Health checks

  steps++; // Add Caddy route

  // SSO setup file
  if (ssoEnabled && hasSSOSetup(manifest)) steps++;
  // Install setup file
  if (setupFor(manifest, 'install')) steps++;

  steps += 2; // Save metadata + register with UI
  return steps;
}

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

/**
 * Determine whether the forward-auth proxy gate should be applied for an app.
 * Precedence (highest first):
 * - manifest.forwardAuth === 'disabled' → never (hard off).
 * - An explicit install-time choice → honored, EVEN for apps that have their own YouEye ID
 *   login. This is what makes the gate operable on an OIDC app: the owner can turn it on as
 *   an extra gate. (The caller passes the app's own forward-auth-gate choice here, separate
 *   from the OIDC-login choice — see the installApp call site.)
 * - An app with its own login (native SSO or a planned identity integration) → off by
 *   default (no double-gate) when no explicit choice was made.
 * - manifest.forwardAuth === 'enabled' → on.
 * - Default ('default'/undefined): on only when there's no native SSO section.
 */
function resolveForwardAuth(manifest: AppManifest, hasSSOEnabled: boolean, explicitChoice?: boolean): boolean {
  const fa = manifest.forwardAuth;
  if (fa === 'disabled') return false;
  if (explicitChoice !== undefined) return explicitChoice;
  if (hasSSOEnabled) return false;
  if (fa === 'enabled') return true;
  // Default: use forward-auth when there's no native SSO section
  return !manifest.sso;
}

function describeContainers(manifest: AppManifest): ContainerMeta[] {
  return manifest.containers.map((containerSpec) => ({
    name: containerSpec.name,
    containerName: getContainerName(manifest.metadata.id, containerSpec.name, manifest.containers.length),
    type: containerSpec.type,
    role: manifest.database?.mode === 'own' && manifest.database.container === containerSpec.name
      ? 'database' as const : undefined,
    primary: containerSpec.primary || manifest.containers.length === 1,
    network: containerSpec.network || 'isolated',
    port: containerSpec.port,
    healthCheck: containerSpec.healthCheck ? {
      type: containerSpec.healthCheck.type,
      path: 'path' in containerSpec.healthCheck ? containerSpec.healthCheck.path : undefined,
      timeout: containerSpec.healthCheck.timeout,
      retries: containerSpec.healthCheck.retries,
      startPeriod: containerSpec.healthCheck.startPeriod,
      autoRestart: containerSpec.healthCheck.autoRestart,
    } : undefined,
  }));
}

function describeNativeArtifacts(staged: StagedMarketNativeArtifacts): InstallMetadata['nativeArtifacts'] {
  const artifacts = [...staged.byContainerName.values()].map((artifact) => ({
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
  return artifacts.length > 0 ? artifacts : undefined;
}

function buildInstallRecoveryMetadata(
  manifest: AppManifest,
  config: InstallConfig,
  selectedIntegrations: string[],
  ssoEnabled: boolean,
  restoreOptions?: RestoreOptions,
): InstallMetadata {
  const hasOwnAccountLogin = ssoEnabled;
  const forwardAuthChoice = hasOwnAccountLogin ? config.forwardAuthGate : config.protectWithAccountLogin;
  const forwardAuthEnabled = resolveForwardAuth(manifest, hasOwnAccountLogin, forwardAuthChoice);
  const ssoSlug = ssoEnabled ? `youeye-app-${manifest.metadata.id}` : undefined;
  const installedVersion = manifest.version ?? '';
  return {
    schema: 'youeye.install.v1',
    appId: manifest.metadata.id,
    installationId: config.admissionInstallationId,
    sharedFolders: sharedFoldersOf(manifest),
    lifecycleState: 'installing',
    recoveryPreserveData: Boolean(restoreOptions),
    catalogKey: config.catalogKey || (config.sourceId ? `${config.sourceId}:app:${manifest.metadata.id}` : undefined),
    itemKind: 'app',
    sourceId: config.sourceId,
    sourceName: config.sourceName,
    sourceRepoUrl: config.sourceRepoUrl,
    manifestPath: config.manifestPath,
    manifestRepo: config.manifestRepo,
    manifestBranch: config.manifestBranch,
    manifestDigest: manifest.frozen?.digest ?? config.manifestDigest,
    integration: manifest.integration,
    perUserData: manifest.data_ownership?.per_user,
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    forwardAuthEnabled,
    protectWithAccountLogin: hasOwnAccountLogin || forwardAuthEnabled,
    installedAt: new Date().toISOString(),
    installedVersion,
    catalogVersion: installedVersion || undefined,
    enabled: false,
    desiredState: 'stopped',
    autoRestart: true,
    containers: describeContainers(manifest),
    ssoSlug,
    ssoClientId: ssoSlug,
    forwardAuthSlug: forwardAuthEnabled ? `youeye-fa-${manifest.metadata.id}` : undefined,
    manifestSource: config.sourceRepoUrl || 'market',
    credentials: manifest.credentials?.length
      ? manifest.credentials.map((credential) => ({
        label: credential.label,
        username: credential.username,
        passwordSecret: credential.passwordSecret,
      }))
      : undefined,
    selectedIntegrations,
    databaseMode: manifest.database?.mode ?? 'none',
    databaseName: manifest.database?.mode === 'shared' ? manifest.database.name : undefined,
    databaseUser: manifest.database?.mode === 'shared' ? manifest.database.user : undefined,
    databasePasswordFile: manifest.database?.mode === 'shared' ? resolveSharedDatabasePasswordFile(manifest) : undefined,
    sharedDatabaseCreated: manifest.database?.mode === 'shared' && restoreOptions?.sharedDatabaseCreated ? true : undefined,
    hasSSO: ssoEnabled,
    provides: manifest.provides?.length ? manifest.provides : undefined,
    wants: manifest.wants?.length ? manifest.wants : undefined,
    aiConnectionPending: usesManagedAI(manifest, config)
      && config.aiSettings?.externalInstallationId
      && config.aiSettings.ownerUserId
      ? {
          externalInstallationId: config.aiSettings.externalInstallationId,
          ownerUserId: config.aiSettings.ownerUserId,
        }
      : undefined,
    usePerAppBridge: true,
  };
}

/** The shared folders (`shared:` groups) the app mounts; installing it approves them. */
function sharedFoldersOf(manifest: AppManifest): string[] | undefined {
  const groups = [...new Set(manifest.containers.flatMap((container) =>
    container.volumes.map((volume) => volume.storageGroup).filter((group): group is string => Boolean(group))))].sort();
  return groups.length ? groups : undefined;
}

function preflightManifestStorage(manifest: AppManifest): void {
  const containers = new Map(manifest.containers.map((container) => [container.name, container]));
  for (const container of manifest.containers) {
    const names = new Set<string>();
    for (const volume of container.volumes) {
      if (names.has(volume.name)) throw new Error(`Container ${container.name} declares duplicate storage name ${volume.name}`);
      names.add(volume.name);
      if (!volume.container.startsWith('/') || path.posix.normalize(volume.container) !== volume.container) {
        throw new Error('App storage mount path is invalid');
      }
    }
  }
  for (const configFile of manifest.configFiles) {
    const container = containers.get(configFile.container);
    if (!container) throw new Error('App configuration targets an unknown container');
    const target = path.posix.normalize(configFile.path);
    if (!target.startsWith('/') || target !== configFile.path) throw new Error('App configuration target is invalid');
    const match = deepestConfigStorageMount(
      container.volumes.map((volume) => ({
        ...volume,
        containerPath: volume.container,
        readOnly: volume.read_only,
        ephemeral: volume.type === 'cache' && !volume.sourceVolume,
      })),
      target,
    );
    if (!match) throw new Error('App configuration must target declared app storage');
    if (!match.relativePath) throw new Error('App configuration must target a file inside declared app storage');
    if (match.mount.readOnly) throw new Error('App configuration cannot target read-only storage');
    if (match.mount.ephemeral) throw new Error('App configuration cannot target ephemeral cache storage');
  }
}

async function ensureRoute(params: Parameters<typeof addRoute>[0]): Promise<void> {
  await addRoute(params);
}

async function preflightInstallResources(
  manifest: AppManifest,
  config: InstallConfig,
  ssoEnabled: boolean,
  restoreOptions?: RestoreOptions,
): Promise<void> {
  const appId = manifest.metadata.id;
  const durableApps = await listInstalledApps();
  if (durableApps.some((metadata) => metadata.appId === appId)) {
    throw new AppNetworkOperationConflictError(`App ${appId} already has durable install metadata`);
  }
  if (await getInstalledApp(appId)) {
    throw new AppNetworkOperationConflictError(`App ${appId} is already present in installed application state`);
  }

  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!dnsLabel.test(config.subdomain)
    || config.domain.length > 253
    || config.domain.split('.').some((label) => !dnsLabel.test(label))) {
    throw new Error('App subdomain or platform domain is invalid');
  }
  const hostname = `${config.subdomain}.${config.domain}`;
  const durableHostnameCollision = durableApps.find((metadata) =>
    `${metadata.subdomain}.${metadata.domain}` === hostname,
  );
  if (durableHostnameCollision) {
    throw new AppNetworkOperationConflictError(
      `Hostname ${hostname} is already reserved by ${durableHostnameCollision.appId}`,
    );
  }
  const routeCollision = (await getRoutes()).find((route) => route.hostname === hostname);
  if (routeCollision) {
    throw new AppNetworkOperationConflictError(
      `App ${appId} conflicts with existing route ${routeCollision.id} for ${routeCollision.hostname}`,
    );
  }
  // Container names are exact and unambiguous: refuse names another installed or retained app
  // records (app `foo` + sidecar `bar` vs app `foo-bar`), and any name Incus already holds.
  // A same-name instance is never replaced, reused or deleted.
  const containerNames = manifest.containers.map((container) =>
    getContainerName(appId, container.name, manifest.containers.length));
  try {
    assertContainerNamesAvailable(appId, containerNames, [...durableApps, ...await listRetainedApps()]);
    await assertInstancesAbsent(containerNames);
  } catch (error) {
    if (error instanceof InstanceOwnershipError) throw new AppNetworkOperationConflictError(error.message);
    throw error;
  }

  const { getCNAMERecords, getDNSRecords } = await import('../apps/pihole-api');
  const [cnames, dnsRecords] = await Promise.all([getCNAMERecords(), getDNSRecords()]);
  if (cnames.some((record) => record.domain === hostname)
    || dnsRecords.some((record) => record.domain === hostname)) {
    throw new AppNetworkOperationConflictError(`Hostname ${hostname} already has a DNS record`);
  }

  const uiCollision = await execCommand('youeye-postgres', [
    'psql', '-U', 'youeye', '-d', 'youeye_ui', '-v', 'ON_ERROR_STOP=1', '-tAc',
    `SELECT 1 FROM apps WHERE id='${appId}' OR subdomain='${config.subdomain}' LIMIT 1`,
  ], { timeout: 10_000 });
  if (uiCollision.exitCode !== 0) throw new Error('Dashboard registration collision preflight could not be completed');
  if (uiCollision.stdout.trim() === '1') {
    throw new AppNetworkOperationConflictError('App ID or subdomain already exists in dashboard registration state');
  }

  if (ssoEnabled) {
    const { getClient } = await import('@/lib/identity/store');
    if (await getClient(`youeye-app-${appId}`)) {
      throw new AppNetworkOperationConflictError(`App ${appId} already has an identity OAuth client`);
    }
  }

  if (!restoreOptions) {
    // The app directory (install.json, secrets) and the generated CA directory; uninstall with
    // delete-data removes both, so a reinstall passes.
    const orphanPath = leftoverAppPaths(appId)[0];
    if (orphanPath) {
      throw new AppNetworkOperationConflictError(
        `App ${appId} has retained data without an active install; use supported recovery before retrying`,
      );
    }
  }

  const database = manifest.database;
  if (database?.mode === 'shared' && database.name && database.user) {
    const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
    if (!identifierPattern.test(database.name) || !identifierPattern.test(database.user)) {
      throw new Error('Shared database name and user must be safe PostgreSQL identifiers');
    }
    const durableDatabaseCollision = durableApps.find((metadata) =>
      metadata.databaseMode === 'shared'
      && (metadata.databaseName === database.name || metadata.databaseUser === database.user),
    );
    if (durableDatabaseCollision) {
      throw new AppNetworkOperationConflictError(
        `Shared database resources are already reserved by ${durableDatabaseCollision.appId}`,
      );
    }
    if (!restoreOptions) {
      const existing = await execCommand('youeye-postgres', [
        'psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-tAc',
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='${database.name}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${database.user}') THEN 1 ELSE 0 END`,
      ], { timeout: 10_000 });
      if (existing.exitCode !== 0) throw new Error('Shared database collision preflight could not be completed');
      if (existing.stdout.trim() === '1') {
        throw new AppNetworkOperationConflictError(
          `App ${appId} has retained shared database resources; use supported recovery before retrying`,
        );
      }
    }
  }
}

// ─── Dashboard Registration ───────────────────────────────

async function readBridgeToken(): Promise<string | null> {
  try {
    const { readFileSync } = await import('fs');
    return readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
  } catch {
    return process.env.UI_BRIDGE_TOKEN ?? null;
  }
}

async function registerAppWithUI(
  appId: string,
  name: string,
  subdomain: string,
  containerName: string,
  port: number,
  icon: string | null,
  ssoEntryUrl?: string,
  linkHandlers?: Array<{ type: string; description: string; endpoint?: string; triggers: string[] }>,
  manifest?: Record<string, unknown>,
): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) throw new Error('YE-UI container IP is unavailable');

  const bridgeToken = await readBridgeToken();
  if (!bridgeToken) throw new Error('UI bridge token is unavailable');
  const containerUrl = port ? `http://${containerName}.${CONTAINER_DOMAIN}:${port}` : `http://${containerName}.${CONTAINER_DOMAIN}`;

  const payload: Record<string, unknown> = {
    id: appId, name, container_url: containerUrl, subdomain, icon,
    sso_entry_url: ssoEntryUrl,
  };
  if (linkHandlers && linkHandlers.length > 0) {
    payload.link_handlers = linkHandlers;
  }
  if (manifest) {
    payload.manifest = manifest;
  }

  const res = await fetch(`http://${uiIP}:3000/api/v1/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`UI registration failed with HTTP ${res.status}`);
  }
}

async function unregisterAppWithUI(appId: string): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) throw new Error('YE-UI container IP is unavailable');
  const bridgeToken = await readBridgeToken();
  if (!bridgeToken) throw new Error('UI bridge token is unavailable');
  const response = await fetch(`http://${uiIP}:3000/api/v1/apps/${encodeURIComponent(appId)}/unregister`, {
    method: 'DELETE',
    headers: { 'X-UI-Bridge-Token': bridgeToken },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`UI unregister failed with HTTP ${response.status}`);
  }
}

/**
 * Push ONLY the SSO entry URL for an already-registered app to the UI.
 *
 * Apps whose SSO is wired by a post-install integration (Jellyfin, Nextcloud,
 * Immich, Memos, Audiobookshelf, …) have no `sso` block in their app manifest,
 * so the main install registers them with `sso_entry_url = null`. The integration
 * manifest carries `sso.entry_url`, but it is applied AFTER the app is registered.
 * This sends just that field so the drawer/header link to the SSO login path.
 *
 * Token-safe: omits token_hash, icon, name and container URL, so the UI preserves
 * the existing bridge token and all other app fields untouched. Best-effort —
 * a failure here only degrades the launch link, it does not break the install.
 */
export async function pushSsoEntryUrlToUI(appId: string, entryUrl: string | null): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) throw new Error('YE-UI container IP is unavailable');

  const bridgeToken = await readBridgeToken();
  if (!bridgeToken) throw new Error('UI bridge token is unavailable');
  const res = await fetch(`http://${uiIP}:3000/api/v1/apps/sso-entry-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {}),
    },
    body: JSON.stringify({ id: appId, sso_entry_url: entryUrl }),
  });

  if (!res.ok) {
    throw new Error(`UI SSO entry URL update failed with HTTP ${res.status}`);
  }
}

// ─── Env File Writer ──────────────────────────────────────

async function writeEnvToContainer(
  containerName: string,
  env: Record<string, string>,
): Promise<void> {
  const content = envToString(env);
  await incusUploadFile(
    containerName,
    `/etc/${containerName}.env`,
    Buffer.from(content, 'utf8'),
    { timeout: 10_000, mode: '0600' },
  );
  if (!Buffer.from(content, 'utf8').equals(await incusDownloadFile(containerName, `/etc/${containerName}.env`))) {
    throw new Error('Protected runtime environment did not read back');
  }
}

// ─── Shared Postgres Setup ────────────────────────────────

async function setupSharedPostgres(
  dbName: string,
  dbUser: string,
  dbPassword: string,
  rollbackCtx: RollbackContext,
): Promise<void> {
  const POSTGRES_CONTAINER = 'youeye-postgres';
  const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
  if (!identifierPattern.test(dbName) || !identifierPattern.test(dbUser)) {
    throw new Error('Shared database name and user must be safe PostgreSQL identifiers');
  }
  const quotedName = `"${dbName}"`;
  const quotedUser = `"${dbUser}"`;

  // Verify postgres container is reachable before proceeding
  try {
    const check = await execShell(POSTGRES_CONTAINER, 'pg_isready -U youeye', { timeout: 5_000 });
    if (check.exitCode !== 0) {
      throw new Error('PostgreSQL is not running. Cannot install apps that require a database.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('PostgreSQL is not running')) throw err;
    throw new Error(`PostgreSQL is unreachable: ${err}. Cannot install apps that require a database.`);
  }

  const lockId = `db-${createHash('sha256').update(`${dbName}\0${dbUser}`).digest('hex').slice(0, 40)}`;
  await withAppNetworkOperationLock(lockId, 'database-create', async () => {
    const resourceExists = async (kind: 'database' | 'role', name: string): Promise<boolean> => {
      const table = kind === 'database' ? 'pg_database' : 'pg_roles';
      const column = kind === 'database' ? 'datname' : 'rolname';
      const result = await execCommand(
        POSTGRES_CONTAINER,
        ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-tAc', `SELECT 1 FROM ${table} WHERE ${column}='${name}'`],
        { timeout: 10_000 },
      );
      if (result.exitCode !== 0) throw new Error(`Could not observe shared ${kind} state`);
      return result.stdout.trim() === '1';
    };
    const collision = await execCommand(
      POSTGRES_CONTAINER,
      ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-tAc',
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='${dbName}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${dbUser}') THEN 1 ELSE 0 END`],
      { timeout: 10_000 },
    );
    if (collision.exitCode !== 0) throw new Error('Shared database collision check failed');
    if (collision.stdout.trim() === '1') {
      throw new AppNetworkOperationConflictError('Shared database resources already exist');
    }

    const passwordSql = `CREATE ROLE ${quotedUser} LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}';\n`;
    const passwordFile = `/tmp/youeye-role-${randomUUID()}.sql`;
    await incusUploadFile(POSTGRES_CONTAINER, passwordFile, Buffer.from(passwordSql, 'utf8'), {
      timeout: 10_000,
      mode: '0600',
    });
    try {
      try {
        const roleResult = await execCommand(
          POSTGRES_CONTAINER,
          ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-f', passwordFile],
          { timeout: 10_000 },
        );
        if (roleResult.exitCode !== 0) throw new Error('Failed to create shared database role');
        rollbackCtx.databaseUserCreated = true;
      } catch (error) {
        // The pre-check proved absence while this cross-app DB lock was held, so
        // an observed role after an uncertain response belongs to this attempt.
        rollbackCtx.databaseUserCreated = await resourceExists('role', dbUser);
        throw error;
      }
    } finally {
      await execCommand(POSTGRES_CONTAINER, ['rm', '-f', passwordFile], { timeout: 5_000 }).catch(() => undefined);
    }

    try {
      const createResult = await execCommand(
        POSTGRES_CONTAINER,
        ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${quotedName} OWNER ${quotedUser}`],
        { timeout: 10_000 },
      );
      if (createResult.exitCode !== 0) throw new Error('Failed to create shared database');
      rollbackCtx.databaseCreated = true;
    } catch (error) {
      rollbackCtx.databaseCreated = await resourceExists('database', dbName);
      throw error;
    }
  });
}

// ─── Secret Generator ─────────────────────────────────────

function getGenerator(type: string, length: number): () => string {
  switch (type) {
    case 'password': return () => generatePassword(length);
    case 'secretKey': return () => generateSecretKey(length);
    case 'hexToken': return () => generateHexToken(length);
    default: return () => generatePassword(length);
  }
}

// ─── OCI Manifest Builder ─────────────────────────────────

function buildOCIManifest(
  spec: ContainerSpec,
  containerName: string,
  appId: string,
  resolvedEnv: Record<string, string>,
  storageVolumes: StorageVolumeMeta[],
  imageFingerprint?: string,
  trustBundle?: { hostPath: string; containerPath: string },
): OCIManifest {
  const volumes: OCIManifest['volumes'] = storageVolumes.map((volume) => ({
    kind: 'custom',
    pool: volume.pool,
    source: volume.sourcePath ? `${volume.name}/${volume.sourcePath}` : volume.name,
    container: volume.containerPath,
    readOnly: volume.readOnly,
  }));
  if (trustBundle) {
    volumes.push({
      kind: 'bind',
      host: path.dirname(trustBundle.hostPath),
      container: path.dirname(trustBundle.containerPath),
      readOnly: true,
    });
  }

  return {
    name: appId,
    displayName: containerName,
    image: spec.image,
    imageFingerprint,
    containerName,
    command: spec.command,
    ports: [],
    environment: resolvedEnv,
    volumes,
  };
}

// ─── Main Install Function ────────────────────────────────

export async function installApp(
  manifest: AppManifest,
  config: InstallConfig,
  onEvent: InstallEventCallback,
  signal?: AbortSignal,
  restoreOptions?: RestoreOptions
): Promise<void> {
  const appId = manifest.metadata.id;
  const dbMode = manifest.database?.mode ?? 'none';
  const dbName = manifest.database?.name ?? '';
  const dbUser = manifest.database?.user ?? '';
  const rollbackCtx: RollbackContext = {
    containerNames: [],
    appId,
    subdomain: config.subdomain,
    domain: config.domain,
    dbName: (dbMode === 'shared' && dbName) ? dbName : undefined,
    dbUser: (dbMode === 'shared' && dbUser) ? dbUser : undefined,
    preserveData: !!restoreOptions,
  };

  return withAppInventory(() => withAppLifecycle(appId, () => withAppNetworkOperationLock(appId, 'install', async () => {
    // An app that needs a newer YouEye is refused before anything is created.
    await assertYouEyeRequirement(manifest);
    if (!restoreOptions) {
      const { prepareRetainedAdoption } = await import('@/lib/admission/retained-data');
      restoreOptions = await prepareRetainedAdoption(manifest, config);
      rollbackCtx.preserveData = Boolean(restoreOptions);
    } else if (config.adoptRetainedData) {
      throw new Error('Retained adoption cannot be combined with backup restore');
    }
    assertPrivateCredentialConfig(manifest.configFiles);
    await preflightManagedAISelection(manifest, config);
    rollbackCtx.aiExternalInstallationId = config.aiSettings?.externalInstallationId;
    const selectedIntegrations = getSelectedIntegrations(manifest, config);
    const ssoEnabled = shouldEnableSSO(manifest, selectedIntegrations);
    const needsSSO = ssoEnabled;
    const { getPendingBridgesForTarget } = await import('../bridges/store');
    const pendingIntegrationCount = (await getPendingBridgesForTarget(appId)).length;
    const requiredAddresses = 1 // bridge gateway
      + manifest.containers.length
      + 1 // Caddy attachment
      + pendingIntegrationCount
      + 4; // DHCP/operational safety margin
    const totalSteps = countSteps(manifest, ssoEnabled, usesManagedAI(manifest, config));
    const operationId = `install-${appId}-${randomUUID()}`;

    // Complete every read-only refusal before entering rollback ownership.
    // In particular, a keep-data uninstall intentionally leaves app-owned
    // custom volumes behind. A later install may adopt only their exact
    // ownership identity; rollback cannot delete retained data it did not create.
    await preflightInstallResources(manifest, config, ssoEnabled, restoreOptions);
    preflightManifestStorage(manifest);
    await preflightAppNetwork(appId, { requiredAddresses });
    const { ensureAppAdmission, getAdmissionResourceOwners } = await import('@/lib/admission/store');
    const admission = await ensureAppAdmission({ appId, actorId: config.admissionActorId,
      restoredIdentity: restoreOptions?.restoredIdentity,
      adoptRetainedData: Boolean(restoreOptions?.retainedRuntimes), routes: [
      { host: `${config.subdomain}.${config.domain}` },
    ] });
    config.admissionInstallationId = admission.installationId;
    rollbackCtx.installationId = admission.installationId;
    config.admissionDataOwnerId = admission.ownerId;
    config.admissionResourceOwners = await getAdmissionResourceOwners(appId);
    const recoveredNativeContainers = manifest.containers
      .filter((container) => restoreOptions?.runtimeInstances?.[
        getContainerName(appId, container.name, manifest.containers.length)
      ] || restoreOptions?.retainedRuntimes?.[getContainerName(appId, container.name, manifest.containers.length)])
      .map((container) => container.name);
    const stagedNativeArtifacts = await stageMarketNativeArtifacts(manifest, config, {
      skipContainerNames: recoveredNativeContainers,
    });

    try {
      const products = [...stagedNativeArtifacts.byContainerName.values()];
      if (products.length) {
        // The manifest of a native app is its release's installer contract.
        const { verifyMarketProductInstallContract } = await import('./native-artifact');
        const { downloadProductAsset } = await import('../releases/channel-index');
        const { verifyInstalledProductReceipt } = await import('../releases/product-release');
        for (const artifact of products) {
          const selected = verifyInstalledProductReceipt(artifact.productRelease,{product:appId});
          const contract = await downloadProductAsset(selected,'youeye-app.yaml');
          await verifyMarketProductInstallContract(contract, selected, manifest);
        }
      }
      try {
        onEvent({ step: 0, totalSteps, status: 'running', message: 'Reserving isolated /27 app network...' });
        const network = await createAppNetwork(appId, {
          nat: true,
          operationId,
          requiredAddresses,
          installationId: admission.installationId,
        });
        await prepareAppEgressAcl(appId, {
          needsSharedDb: dbMode === 'shared',
          needsSSO,
          needsAI: usesManagedAI(manifest, config),
        });
        // Persist the exact recovery map before secrets, databases, identity clients,
        // containers, routes, or UI state can be created. Reconciliation treats this
        // record as non-visible until the final active metadata replaces it.
        const recoveryMetadata = buildInstallRecoveryMetadata(
          manifest,
          config,
          selectedIntegrations,
          ssoEnabled,
          restoreOptions,
        );
        const storageVolumes = await ensureAppStorage(manifest, config);
        recoveryMetadata.storageVolumes = storageVolumes.map(({ created: _created, ...volume }) => volume);
        rollbackCtx.storageVolumes = recoveryMetadata.storageVolumes;
        rollbackCtx.createdStorageVolumes = new Set(
          [
            ...storageVolumes.filter((volume) => volume.created).map((volume) => `${volume.pool}/${volume.name}`),
            ...(restoreOptions?.recoveryCreatedStorage ?? []),
          ],
        );
        recoveryMetadata.nativeArtifacts = describeNativeArtifacts(stagedNativeArtifacts);
        await saveInstallMetadata(recoveryMetadata);
        onEvent({
          step: 0,
          totalSteps,
          status: 'success',
          message: `Reserved isolated app network ${network.bridgeName} (${network.subnetCIDR})`,
        });
        await installAppLocked(
          manifest,
          config,
          onEvent,
          signal,
          restoreOptions,
          rollbackCtx,
          network.bridgeName,
          recoveryMetadata.storageVolumes,
          stagedNativeArtifacts,
        );
      } catch (error) {
        if (error instanceof AppServiceIntegrationPending) throw error;
        const rollback = await rollbackInstall(rollbackCtx, onEvent, totalSteps);
        if (restoreOptions?.retainedRuntimes) {
          const { retainAdmissionOnUninstall } = await import('@/lib/admission/lifecycle');
          await retainAdmissionOnUninstall(appId, true);
        }
        const rollbackSummary = rollback.clean
          ? 'rollback verified clean'
          : rollback.cleanupPending
            ? 'rollback retained cleanup_pending resources'
            : `rollback incomplete (${rollback.errors.length} error(s))`;
        const reason = error instanceof AppNetworkOperationConflictError
          ? `resource collision: ${error.message}`
          : 'installer stage failed';
        throw new Error(`App installation failed (${reason}); ${rollbackSummary}`, { cause: error });
      }
    } finally {
      await stagedNativeArtifacts.cleanup();
    }
  })));
}

async function installAppLocked(
  manifest: AppManifest,
  config: InstallConfig,
  onEvent: InstallEventCallback,
  signal: AbortSignal | undefined,
  restoreOptions: RestoreOptions | undefined,
  rollbackCtx: RollbackContext,
  appBridgeName: string,
  storageVolumes: StorageVolumeMeta[],
  stagedNativeArtifacts: StagedMarketNativeArtifacts,
): Promise<void> {
  const appId = manifest.metadata.id;

  // Determine SSO support from manifest
  const selectedIntegrations = getSelectedIntegrations(manifest, config);
  const identityConfig = await getIdentityProviderConfig();
  const ssoEnabled = shouldEnableSSO(manifest, selectedIntegrations);
  const nativeIdentityIntegrationPlanned = false;
  const totalSteps = countSteps(manifest, ssoEnabled, usesManagedAI(manifest, config));
  let step = 0;

  const dbMode = manifest.database?.mode ?? 'none';
  const dbName = manifest.database?.name ?? '';
  const dbUser = manifest.database?.user ?? '';
  let finalMetadata: InstallMetadata | null = null;
  let dashboardRegistration: {
    displayName: string;
    displayIcon: string | null;
    ssoEntryUrl?: string;
    linkHandlers: NonNullable<AppManifest['capabilities']>['link_handlers'];
  } | null = null;

  function checkCancelled() {
    if (signal?.aborted) throw new Error('Installation cancelled by user');
  }

  // ── Step 1: Generate secrets ────────────────────────────

  checkCancelled();
  step++;
  const secrets: Record<string, string> = {};

  if (restoreOptions?.skipSecrets) {
    emit(onEvent, step, totalSteps, 'running', 'Reading restored secrets...');
    for (const secret of manifest.secrets) {
      const secretValue = await readAppSecret(appId, secret.name);
      if (secretValue === null) throw new Error(`Restored secret ${secret.name} is missing`);
      secrets[secret.name] = secretValue;
    }
    emit(onEvent, step, totalSteps, 'success', 'Secrets read from backup');
  } else {
    emit(onEvent, step, totalSteps, 'running', 'Generating secrets...');
    for (const secret of manifest.secrets) {
      const generator = getGenerator(secret.generator, secret.length);
      secrets[secret.name] = await getOrCreateAppSecret(appId, secret.name, generator);
    }
    emit(onEvent, step, totalSteps, 'success', 'Secrets generated');
  }

  let aiConnection: InstallMetadata['aiConnection'];
  if (usesManagedAI(manifest, config)) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Connecting this app to AI Settings...');
    aiConnection = await provisionManagedAI(
      manifest,
      config,
      rollbackCtx,
      restoreOptions?.restoredManagedAI,
    ) ?? undefined;
    const recovery = await readInstallMetadata(appId);
    if (!recovery || recovery.lifecycleState !== 'installing' || !aiConnection) {
      throw new Error('Managed AI recovery state could not be committed');
    }
    recovery.aiConnection = aiConnection;
    delete recovery.aiConnectionPending;
    await saveInstallMetadata(recovery);
    emit(onEvent, step, totalSteps, 'success', `Connected to ${aiConnection.groupName}`);
  }

  // ── Step 2: Setup shared PostgreSQL ─────────────────────

  // The database password is the app's `db_password` secret (shared or own database).
  let dbPassword = dbMode === 'own' ? secrets.db_password ?? '' : '';
  // Whether the shared database and role belong to this installation (uninstall drops only those).
  let sharedDatabaseCreated = dbMode === 'shared' && Boolean(restoreOptions?.sharedDatabaseCreated);
  if (dbMode === 'shared' && dbName && dbUser) {
    checkCancelled();
    step++;
    dbPassword = secrets.db_password || generatePassword(32);
    if (restoreOptions?.skipDatabase) {
      emit(onEvent, step, totalSteps, 'skipped', 'Database setup skipped (restored from backup)');
    } else {
      emit(onEvent, step, totalSteps, 'running', 'Setting up shared database...');
      try {
        await setupSharedPostgres(dbName, dbUser, dbPassword, rollbackCtx);
        sharedDatabaseCreated = true;
        const created = await readInstallMetadata(appId);
        if (!created || created.lifecycleState !== 'installing') {
          throw new Error('Durable install recovery metadata is unavailable after database creation');
        }
        created.sharedDatabaseCreated = true;
        await saveInstallMetadata(created);
        emit(onEvent, step, totalSteps, 'success', 'Database ready');
      } catch (err) {
        emit(onEvent, step, totalSteps, 'error', 'Failed to setup database', 'Shared database setup failed');
        throw err;
      }
    }
  }

  // ── Step 4: Pre-deploy SSO — create identity OAuth client ───────

  let ssoSlug: string | undefined;
  let ssoClientId: string | undefined;
  let ssoResult: { clientId: string; clientSecret: string; slug: string } | undefined;

  if (ssoEnabled && manifest.sso) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', `Creating ${identityConfig.name} SSO client...`);
    try {
      ssoSlug = `youeye-app-${appId}`;
      const appUrl = `https://${config.subdomain}.${config.domain}`;

      // Build redirect URIs from callback_path + additional_callbacks
      const redirectUris: string[] = [];
      const prelimCtx = await buildCanonicalContext(manifest, config, undefined, dbPassword);
      prelimCtx.secret = secrets;

      // Callbacks are paths on the app itself (never another host), or custom-scheme URIs of
      // the app's own clients (e.g. app.immich:///oauth-callback), which are used as written.
      for (const callback of [manifest.sso.callback_path, ...manifest.sso.additional_callbacks]) {
        redirectUris.push(callback.startsWith('/') ? `${appUrl}${resolveVariables(callback, prelimCtx)}` : callback);
      }

      rollbackCtx.ssoSlug = ssoSlug;
      const result = await createOAuthClient({
        clientId: ssoSlug,
        name: manifest.metadata.name,
        redirectUris,
        postLogoutRedirectUris: [`https://${config.domain}/`, appUrl + '/'],
        backchannelLogoutUri: manifest.sso.backchannel_logout_path
          ? `${appUrl}${manifest.sso.backchannel_logout_path}` : undefined,
        scopes: oauthScopesForManifest(manifest),
        roleClaim: manifest.sso.role_claim ?? null,
      });

      ssoClientId = result.clientId;
      ssoResult = { clientId: result.clientId, clientSecret: result.clientSecret, slug: ssoSlug };

      emit(onEvent, step, totalSteps, 'success', `${identityConfig.name} SSO client created`);
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to create SSO application', 'Identity client creation failed');
      await rollbackInstall(rollbackCtx, onEvent, totalSteps);
      throw err;
    }
  }

  // ── Step 4b: Forward-auth proxy (for apps without native SSO) ──
  // If the app has no `sso` section but forward-auth is not disabled,
  // mark it for a YouEye ID forward-auth handler when Caddy is configured.

  let forwardAuthEnabled = false;
  // Apps that do their own YouEye ID login (native SSO or a planned identity integration)
  // take the forward-auth gate from the SEPARATE `forwardAuthGate` choice — an optional extra
  // gate the owner can turn on (default off). Apps with no login of their own take it from
  // `protectWithAccountLogin` (the gate IS their login). This stops the OIDC-login choice and
  // the proxy-gate choice from being conflated.
  const hasOwnAccountLogin = ssoEnabled || nativeIdentityIntegrationPlanned;
  const forwardAuthChoice = hasOwnAccountLogin
    ? config.forwardAuthGate
    : config.protectWithAccountLogin;
  const useForwardAuth = resolveForwardAuth(
    manifest,
    hasOwnAccountLogin,
    forwardAuthChoice
  );

  if (useForwardAuth) {
    try {
      const faSlug = `youeye-fa-${appId}`;
      rollbackCtx.forwardAuthSlug = faSlug;
      forwardAuthEnabled = true;
      emit(onEvent, step, totalSteps, 'success', `${identityConfig.name} forward-auth selected`);
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to prepare forward-auth', 'Identity route preparation failed');
      await rollbackInstall(rollbackCtx, onEvent, totalSteps);
      throw err;
    }
  }

  // ── Step 5: Build canonical context for the pre-reserved bridge ──

  // `internet: true` is NAT on for the app network; there is no per-host allowlist.
  const wantsInternet = manifest.containers.some(c => c.network === 'internet');

  await prepareCredentialForAppInstall(appId, appServiceCredentials);
  rollbackCtx.credentialProvisioned = true;
  const appToken = await generateAppToken(appId);
  const ctx = await buildCanonicalContext(manifest, config, ssoResult, dbPassword, appToken, !!appBridgeName);
  ctx.secret = secrets;

  // Resolve env_mapping once — used for all containers
  const envFromMapping = manifest.env_mapping
    ? resolveEnvMapping(manifest.env_mapping, ctx)
    : {};

  const provisionalMetadata = await readInstallMetadata(appId);
  if (!provisionalMetadata || provisionalMetadata.lifecycleState !== 'installing') {
    throw new Error('Durable install recovery metadata is unavailable before container deployment');
  }
  provisionalMetadata.storageVolumes = storageVolumes;
  await saveInstallMetadata(provisionalMetadata);

  // ── Step 6: Deploy containers (universal loop) ──────────

  const containerMetas: ContainerMeta[] = [];
  const containerNames: string[] = [];
  let primaryContainerName = '';
  let primaryPort = 0;
  const identityTrustBundle = ssoEnabled || nativeIdentityIntegrationPlanned
    ? await stageCaddyTrustBundle(appId)
    : undefined;

  // Every instance this install creates carries the installation's ownership tags.
  if (!config.admissionInstallationId) throw new Error('Installation id is unavailable before container deployment');
  const owner = { appId, installationId: config.admissionInstallationId };

  // Build NIC device config for per-app bridge (if available)
  let appNIC: Record<string, Record<string, string>> | undefined;
  if (appBridgeName) {
    appNIC = await buildAppNIC(appId);
  }

  try {
    for (const containerSpec of manifest.containers) {
      const containerName = getContainerName(appId, containerSpec.name, manifest.containers.length);
      containerNames.push(containerName);
      rollbackCtx.containerNames.push(containerName);

      const isPrimary = containerSpec.primary || manifest.containers.length === 1;
      if (isPrimary) {
        primaryContainerName = containerName;
        primaryPort = containerSpec.port || 3000;
      }

      containerMetas.push(describeContainers(manifest).find((item) => item.name === containerSpec.name)!);

      checkCancelled();
      step++;
      emit(onEvent, step, totalSteps, 'running', `Deploying ${containerName}...`);

      try {
        if (containerSpec.type === 'lxd') {
          // ── LXD container deployment ──────────────────
          const source = containerSpec.source;
          if (!source) throw new Error(`LXD container ${containerSpec.name} missing source config`);
          const stagedArtifact = stagedNativeArtifacts.byContainerName.get(containerSpec.name);

          const lxdSpec = {
            name: appId,
            displayName: manifest.metadata.name,
            containerName,
            image: containerSpec.image,
            imageServer: 'https://images.linuxcontainers.org',
            imageProtocol: 'simplestreams',
            nodeVersion: `${source.node}.x`,
            appDir: '/opt/app',
            port: containerSpec.port || 3000,
            volumes: volumesForContainer(storageVolumes, containerName).map((volume) => ({
              kind: 'custom' as const,
              pool: volume.pool,
              source: volume.sourcePath ? `${volume.name}/${volume.sourcePath}` : volume.name,
              container: volume.containerPath,
              readOnly: volume.readOnly,
            })),
          };
          const recoveredRuntime = restoreOptions?.runtimeInstances?.[containerName];
          const retainedRuntime = restoreOptions?.retainedRuntimes?.[containerName];
          if (retainedRuntime) {
            const { copyRetainedRuntime } = await import('@/lib/admission/retained-runtime');
            await copyRetainedRuntime({ appId, installationId: config.admissionInstallationId!,
              ownerId: retainedRuntime.ownerId, sourceName: containerName,
              retainedName: retainedRuntime.name, pool: retainedRuntime.pool });
            await adoptRestoredLXDContainer(lxdSpec, appNIC, owner);
          } else if (recoveredRuntime) {
            const recoveryNetwork = appNIC?.eth0?.network;
            if (!recoveryNetwork) throw new Error('Recovered native runtime has no target app network');
            await spineClient.importIncusInstance({
              archivePath: recoveredRuntime.archivePath,
              name: containerName,
              pool: recoveredRuntime.pool,
              network: recoveryNetwork,
            });
            await adoptRestoredLXDContainer(lxdSpec, appNIC, owner);
          } else {
            if (!stagedArtifact) throw new Error(`Native artifact preflight is missing for ${containerSpec.name}`);
            await deployMarketLXDContainer(lxdSpec, {}, stagedArtifact, appNIC, owner);
          }

          // Write env file to LXD container
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = isPrimary ? { ...envFromMapping, ...staticEnv } : staticEnv;
          assertPrivateCredentialMapping(fullEnv, appToken);
          await writeEnvToContainer(containerName, fullEnv);

          // Restart service to pick up env
          await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 15_000 });

        } else {
          // ── OCI container deployment ─────────────────
          // The app's env goes to its own container; a sidecar gets only its own env.
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = isPrimary ? { ...envFromMapping, ...staticEnv } : staticEnv;
          assertPrivateCredentialMapping(fullEnv, appToken);
          // Trust the YouEye root CA for SERVER-SIDE HTTPS to YouEye-managed services — chiefly the
          // identity provider's OIDC discovery (https://id.<domain>/.../.well-known/openid-configuration),
          // which env-OIDC apps fetch from inside the container. injectCaddyRootCA() (step 7) adds the cert
          // to the system trust store + a systemd drop-in, but non-systemd OCI runtimes that ship their own
          // CA bundle (Python httpx/certifi, Node) ignore the system store and never see the drop-in — so
          // they fail with CERTIFICATE_VERIFY_FAILED. Set the standard CA-bundle env vars here so they are
          // in the process environment from boot. The cert file is written during install (step 7), well
          // before any user login / OIDC discovery. Never override a value the manifest set explicitly.
          if (ssoEnabled || nativeIdentityIntegrationPlanned) {
            if (!identityTrustBundle) throw new Error('Identity trust bundle was not staged');
            const caPath = identityTrustBundle.containerPath;
            if (!fullEnv.SSL_CERT_FILE) fullEnv.SSL_CERT_FILE = caPath;
            if (!fullEnv.REQUESTS_CA_BUNDLE) fullEnv.REQUESTS_CA_BUNDLE = caPath;
            if (!fullEnv.NODE_EXTRA_CA_CERTS) fullEnv.NODE_EXTRA_CA_CERTS = caPath;
          }
          const ociManifest = buildOCIManifest(
            containerSpec,
            containerName,
            appId,
            fullEnv,
            volumesForContainer(storageVolumes, containerName),
            restoreOptions?.runtimeImages?.[containerName],
            identityTrustBundle,
          );
          const retainedRuntime = restoreOptions?.retainedRuntimes?.[containerName];
          await deployOCIContainer(ociManifest, '', appNIC, { start: !appBridgeName, owner, signal,
            ...(retainedRuntime ? { retainedRuntime: { appId,
              installationId: config.admissionInstallationId!, ownerId: retainedRuntime.ownerId,
              sourceName: containerName, retainedName: retainedRuntime.name, pool: retainedRuntime.pool } } : {}) });
        }

        const containerConfigFiles = manifest.configFiles.filter((item) => item.container === containerSpec.name);
        if (containerConfigFiles.length > 0) {
          if (restoreOptions?.skipConfigFiles) {
            emit(onEvent, step, totalSteps, 'skipped', `Kept restored configuration for ${containerName}`);
          } else {
            await writeAllConfigFiles(
              manifest.configFiles,
              containerSpec.name,
              containerName,
              ctx,
              containerSpec.type === 'oci'
                ? volumesForContainer(storageVolumes, containerName)
                : undefined,
            );
          }
        }

        await applyResourcePolicy(containerName, 'normal');

        if (appBridgeName) {
          const needsSharedDb = (manifest.database?.mode ?? 'none') === 'shared';
          const needsSSO = ssoEnabled || nativeIdentityIntegrationPlanned;
          const services = await getSystemServices({
            needsSharedDb,
            needsSSO,
            needsAI: usesManagedAI(manifest, config),
          });
          await addSystemProxyDevices(appId, services);

          const state = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${containerName}/state`);
          if (state.type === 'error') throw new Error(state.error || state.status);
          if (state.metadata?.status !== 'Running') {
            await startOCIContainer(containerName);
          }
        }

        if (containerConfigFiles.length > 0 && !restoreOptions?.skipConfigFiles) {
          await enforceAllConfigFilePermissions(manifest.configFiles, containerSpec.name, containerName, ctx);
        }

        emit(onEvent, step, totalSteps, 'success', `${containerName} deployed`);
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'error',
          message: `Failed to deploy ${containerName}`,
          detail: 'Container deployment or exact read-back failed',
          errorContext: {
            suggestion: 'Container deployment failed. Check disk space, image availability, and incus status.',
          },
        });
        throw err;
      }

      // Health check
      if (containerSpec.healthCheck) {
        step++;
        emit(onEvent, step, totalSteps, 'running', `Waiting for ${containerName} to be healthy...`);

        const hcStart = Date.now();
        const healthy = containerSpec.healthCheck.type === 'postgres'
          ? await waitForPostgresHealth(containerName, containerSpec.healthCheck.user, containerSpec.healthCheck.timeout)
          : await waitForAppHealth(
            containerName,
            containerSpec.port || 80,
            containerSpec.healthCheck.path,
            containerSpec.healthCheck.timeout
          );

        const hcDuration = Date.now() - hcStart;
        if (healthy) {
          onEvent({ step, totalSteps, status: 'success', message: `${containerName} is healthy`, duration: hcDuration });
        } else {
          const hcUrl = containerSpec.healthCheck.type === 'postgres'
            ? `postgres://${containerName}`
            : `http://${containerName}:${containerSpec.port || 80}${containerSpec.healthCheck.path || '/'}`;
          onEvent({
            step,
            totalSteps,
            status: 'error',
            message: `${containerName} health check timed out`,
            duration: hcDuration,
            errorContext: {
              url: hcUrl,
              suggestion: 'Health check timed out. The app may need more startup time, or the health endpoint path may be wrong.',
            },
          });
        }
        if (!healthy) throw new Error(`Health check failed for ${containerName}`);
      }
    }
  } catch (err) {
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw err;
  }

  // ── Step 6b: Network isolation — proxy devices + Caddy NIC ──────
  // Per-app bridge provides structural isolation.
  // Control-owned proxy devices expose system services on the app bridge gateway.
  // Caddy NIC lets the reverse proxy reach the app on its bridge.

  if (appBridgeName) {
    try {
      const needsSharedDb = (manifest.database?.mode ?? 'none') === 'shared';
      const needsSSO = ssoEnabled || nativeIdentityIntegrationPlanned;

      // Ensure Control owns the system-service proxies for this app bridge.
      const services = await getSystemServices({
        needsSharedDb,
        needsSSO,
        needsAI: usesManagedAI(manifest, config),
      });
      await addSystemProxyDevices(appId, services);

      // Hot-plug Caddy NIC onto the app bridge (Docker/Traefik model)
      await addCaddyToAppNetwork(appId);

      // Layer 4: Per-app egress isolation ACL. An app may reach only its gateway
      // (DNS + proxied doorways) and the specific core services it's entitled to;
      // the CP dashboard, Caddy admin, Pi-Hole, and Postgres (for non-DB apps)
      // are rejected. Port-specific rules so they survive nat-mode (DNAT'd traffic
      // arrives with a core-IP destination). Throws on failure — caught by the
      // outer network-config handler and logged, never silently skipped (the old
      // ye-app-infra-block was swallowed and never actually applied).
      await applyAppEgressAcl(appId, containerNames, {
        needsSharedDb,
        needsSSO,
        needsAI: usesManagedAI(manifest, config),
      });

      emit(onEvent, step, totalSteps, 'success', `Network isolation configured for ${containerNames.length} containers`);
    } catch (netErr) {
      const reason = netErr instanceof Error ? netErr.message : 'unknown network policy failure';
      console.error(`[market] Network isolation failed for ${appId}: ${reason}`);
      emit(onEvent, step, totalSteps, 'error', 'Network isolation could not be applied and verified', 'Network policy operation or exact read-back failed');
      throw netErr;
    }
  }

  // ── Steps 7-10: Post-deploy (SSO configure, Caddy, metadata, dashboard)
  // All wrapped in try/catch for comprehensive rollback on failure.

  try {

  // ── Step 7: Setup files (install, then SSO) ─────────────

  // Inject Caddy root CA into OCI containers that use native identity, so they
  // can reach YouEye-managed HTTPS services such as YouEye ID.
  if (ssoEnabled || nativeIdentityIntegrationPlanned) {
    for (const containerSpec of manifest.containers) {
      if (containerSpec.type === 'oci') {
        const cn = getContainerName(appId, containerSpec.name, manifest.containers.length);
        await injectCaddyRootCA(cn);
      }
    }
  }

  const setupContainers = Object.fromEntries(manifest.containers.map((containerSpec) => [
    containerSpec.name, getContainerName(appId, containerSpec.name, manifest.containers.length),
  ]));
  for (const purpose of ['install', 'sso'] as const) {
    if (purpose === 'sso' && !ssoEnabled) continue;
    const file = setupFor(manifest, purpose);
    if (!file) continue;
    checkCancelled();
    step++;
    const label = purpose === 'sso' ? `${manifest.metadata.name} SSO` : manifest.metadata.name;
    emit(onEvent, step, totalSteps, 'running', `Configuring ${label} (${file.name})...`);
    try {
      await runSetup(manifest, purpose, {
        appId,
        containers: setupContainers,
        variables: ctx,
        onProgress: (message) => emit(onEvent, step, totalSteps, 'running', message),
      });
      emit(onEvent, step, totalSteps, 'success', `${label} configured`);
    } catch (err) {
      onEvent({
        step,
        totalSteps,
        status: 'error',
        message: `${file.name} failed`,
        detail: err instanceof Error ? err.message : 'Setup file failed',
      });
      throw err;
    }
  }

  // ── Step 8: Add Caddy route ─────────────────────────────

  checkCancelled();
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Configuring reverse proxy...');
  try {
    // Build forward-auth config for Caddy if enabled
    let forwardAuthConfig: { upstreamDial: string; uri: string; copyHeaders: string[] } | undefined;
    {
      forwardAuthConfig = {
        upstreamDial: await resolveCaddyUpstreamDial(identityConfig.containerName, identityConfig.port),
        uri: '/forward-auth/caddy',
        copyHeaders: [
          'X-YouEye-Username',
          'X-YouEye-Groups',
          'X-YouEye-Email',
          'X-YouEye-Name',
          'X-YouEye-Uid',
        ],
      };
    }

    const hostname = `${config.subdomain}.${config.domain}`;

    // For per-app bridge containers, use IP instead of DNS name.
    // Caddy's DNS resolver (incusbr0) can't resolve names on app bridges.
    let routeUpstream = primaryContainerName;
    if (appBridgeName) {
      routeUpstream = await appContainerAddress(primaryContainerName, appId);
    }
    await ensureRoute({
      hostname,
      path: '/*',
      upstream: routeUpstream,
      port: primaryPort,
      forwardAuth: forwardAuthConfig,
    });
    emit(onEvent, step, totalSteps, 'success', `Route added: ${hostname}`);
    await migrateSystemUpstreamsToIPv4();
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', 'Failed to configure route', 'Caddy route creation or verification failed');
    throw err;
  }

  // ── Step 9: Save metadata ───────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Saving configuration...');
  const installedVersion = manifest.version ?? '';

  const meta: InstallMetadata = {
    schema: 'youeye.install.v1',
    appId,
    installationId: config.admissionInstallationId,
    sharedFolders: sharedFoldersOf(manifest),
    lifecycleState: 'installing',
    recoveryPreserveData: Boolean(restoreOptions),
    storageVolumes,
    catalogKey: config.catalogKey || (config.sourceId ? `${config.sourceId}:app:${appId}` : undefined),
    itemKind: 'app',
    sourceId: config.sourceId,
    sourceName: config.sourceName,
    sourceRepoUrl: config.sourceRepoUrl,
    manifestPath: config.manifestPath,
    manifestRepo: config.manifestRepo,
    manifestBranch: config.manifestBranch,
    manifestDigest: manifest.frozen?.digest ?? config.manifestDigest,
    nativeArtifacts: describeNativeArtifacts(stagedNativeArtifacts),
    integration: manifest.integration,
    perUserData: manifest.data_ownership?.per_user,
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    forwardAuthEnabled,
    protectWithAccountLogin: ssoEnabled || nativeIdentityIntegrationPlanned || forwardAuthEnabled,
    installedAt: provisionalMetadata.installedAt,
    installedVersion,
    catalogVersion: installedVersion || undefined,
    enabled: false,
    desiredState: 'stopped',
    autoRestart: true,
    containers: containerMetas,
    ssoSlug,
    ssoClientId,
    forwardAuthSlug: rollbackCtx.forwardAuthSlug,
    manifestSource: config.sourceRepoUrl || 'market',
    credentials: manifest.credentials?.length
      ? manifest.credentials.map((c) => ({ label: c.label, username: c.username, passwordSecret: c.passwordSecret }))
      : undefined,
    selectedIntegrations,
    ssoEntryUrl: manifest.sso?.entry_url
      ? resolveVariables(manifest.sso.entry_url, ctx)
      : undefined,
    databaseMode: manifest.database?.mode ?? 'none',
    databaseName: manifest.database?.mode === 'shared' ? manifest.database.name : undefined,
    databaseUser: manifest.database?.mode === 'shared' ? manifest.database.user : undefined,
    databasePasswordFile: manifest.database?.mode === 'shared' ? resolveSharedDatabasePasswordFile(manifest) : undefined,
    sharedDatabaseCreated: sharedDatabaseCreated || undefined,
    hasSSO: ssoEnabled,
    provides: manifest.provides?.length ? manifest.provides : undefined,
    wants: manifest.wants?.length ? manifest.wants : undefined,
    aiConnection,
    usePerAppBridge: !!appBridgeName,
  };
  for (const artifact of meta.nativeArtifacts ?? []) {
    if (!artifact.productRelease) continue;
    const { acceptProductSequence, verifyInstalledProductReceipt } = await import('../releases/product-release');
    meta.productReleaseFloors = acceptProductSequence(meta.productReleaseFloors,
      verifyInstalledProductReceipt(artifact.productRelease, {product:appId}));
  }
  await saveInstallMetadata(meta);
  finalMetadata = meta;

  emit(onEvent, step, totalSteps, 'success', 'Configuration saved');

  // ── Step 10: Prepare UI dashboard commit ────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Preparing dashboard registration...');
  try {
    const displayName = config.customName || manifest.metadata.name;
    // Inline the icon from the app's own catalog files (never a URL) so it works on all
    // subdomains; fall back to the Lucide icon name.
    const { resolveAppIcon } = await import('./app-icon');
    const { officialCatalogFile } = await import('./catalog-release');
    const displayIcon = await resolveAppIcon({
      appId,
      iconUrl: manifest.metadata.iconUrl,
      lucide: manifest.metadata.icon,
      customIcon: config.customIcon,
      manifestPath: config.sourceId?.startsWith('direct:') ? undefined : config.manifestPath,
    }, (filePath) => officialCatalogFile(filePath));
    const ssoEntryUrl = manifest.sso?.entry_url
      ? resolveVariables(manifest.sso.entry_url, ctx)
      : undefined;
    const linkHandlers = manifest.capabilities?.link_handlers ?? [];
    dashboardRegistration = { displayName, displayIcon, ssoEntryUrl, linkHandlers };
    emit(onEvent, step, totalSteps, 'success', 'Dashboard registration prepared');
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', 'Dashboard registration failed', 'Dashboard registration or verification failed');
    throw err;
  }

  // ── Step 12: Generate suggestions for unapproved connections ──

  try {
    const suggestions = await generateSuggestionsForApp(manifest);
    if (suggestions.length > 0) {
      emit(onEvent, step, totalSteps, 'success', `Generated ${suggestions.length} connection suggestions`);
    }
  } catch {
    console.warn('[engine] Suggestions generation failed');
  }

  } catch (err) {
    logOperationFailure(`Post-deploy configuration of ${appId}`, err);
    // Comprehensive rollback: clean up containers, DB, SSO, Caddy, metadata
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw err;
  }

  // Post-install: disable NAT on the app bridge if the app doesn't need internet/LAN.
  // NAT was enabled during install so containers could pull packages/images.
  // User's explicit choice (config.allowInternet) overrides manifest default.
  // internet.proxy scopes are handled through the UI gateway, not bridge NAT.
  try {
    const grantInternet = config.allowInternet ?? wantsInternet;
    if (appBridgeName && !grantInternet) {
      await setAppNetworkNAT(appId, false);
    }

    await markAppNetworkActive(appId);
    if (!finalMetadata) throw new Error('Final install metadata was not prepared');
    if (!dashboardRegistration) throw new Error('Final dashboard registration was not prepared');
    finalMetadata.lifecycleState = 'active';
    finalMetadata.enabled = false;
    finalMetadata.serviceCredentialState = 'pending';
    finalMetadata.desiredState = restoreOptions?.desiredState ?? 'running';
    const { bindInstalledAdmission } = await import('@/lib/admission/lifecycle');
    await bindInstalledAdmission(finalMetadata, config.admissionActorId);
    await saveInstallMetadata(finalMetadata);
    await upsertInstalledApp({
      appId,
      type: manifest.integration,
      installedVersion: finalMetadata.installedVersion ?? '',
      catalogVersion: finalMetadata.catalogVersion ?? null,
      subdomain: config.subdomain,
      ssoSlug,
      forwardAuthEnabled,
      catalogKey: finalMetadata.catalogKey,
      sourceId: config.sourceId,
      sourceName: config.sourceName,
      sourceRepoUrl: config.sourceRepoUrl,
    });
    if (!await getInstalledApp(appId)) throw new Error('Installed-app state did not read back after commit');
    await registerAppWithUI(
      appId,
      dashboardRegistration.displayName,
      config.subdomain,
      primaryContainerName,
      primaryPort,
      dashboardRegistration.displayIcon,
      dashboardRegistration.ssoEntryUrl,
      dashboardRegistration.linkHandlers ?? [],
      manifest as unknown as Record<string, unknown>,
    );
    const { isAppRegisteredWithUI } = await import('./reconciler');
    if (!await isAppRegisteredWithUI(appId)) throw new Error('Dashboard registration did not read back after commit');
    if (restoreOptions?.deferServiceCredentialReadiness) {
      finalMetadata.serviceCredentialDesiredState = finalMetadata.desiredState;
      await saveInstallMetadata(finalMetadata);
      emit(onEvent, step, totalSteps, 'success', 'App runtime restored; service credentials await reconciliation');
      await activateWaitingConnections();
      return;
    }
    await activateProvisionedCredential(appId, () => probeNativeAppCredential(appId, manifest));
    finalMetadata.serviceCredentialState = 'ready';
    finalMetadata.enabled = true;
    await saveInstallMetadata(finalMetadata);
    await bindInstalledAdmission(finalMetadata, config.admissionActorId);
    await pushConnectionsToUI(appId);
    const { reconcileAdmissionProjections, admissionReconciliationState } = await import('@/lib/admission/projection');
    await reconcileAdmissionProjections();
    const pendingAdmission = await admissionReconciliationState(appId) !== 'applied';
    if (restoreOptions?.retainedRuntimes) {
      const { finishRetainedAdoption } = await import('@/lib/admission/retained-data');
      // Consumption must be durable before success. Only cleanup of already
      // consumed recovery roots may remain pending.
      if (!await finishRetainedAdoption(appId)) {
        emit(onEvent, step, totalSteps, 'warning',
          'App installed; cleanup of retained recovery copies is pending.');
      }
    }
    emit(onEvent, step, totalSteps, 'success', pendingAdmission
      ? `${manifest.metadata.name} installed; household admission synchronization is pending.`
      : `${manifest.metadata.name} installed successfully!`);
  } catch (error) {
    if (finalMetadata?.serviceCredentialState === 'pending') {
      finalMetadata.desiredState = 'stopped';
      finalMetadata.serviceCredentialDesiredState = 'running';
      await saveInstallMetadata(finalMetadata);
      await quiesceAppCredentialRuntime(rollbackCtx.containerNames);
      emit(onEvent, step, totalSteps, 'error', 'App service integration is pending; reconcile credentials');
      throw new AppServiceIntegrationPending();
    }
    logOperationFailure(`Final installation commit of ${appId}`, error);
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw error;
  }
  await activateWaitingConnections();

  /**
   * Connections other apps were waiting for (from a bundle) that target this app. They need
   * this app's network lease to be active, so they run after the install is committed; a
   * failure is logged and never fails or rolls back the install.
   */
  async function activateWaitingConnections(): Promise<void> {
    try {
      const platform = await getPlatformContext();
      const activated = await activatePendingBridges(appId, primaryContainerName, primaryPort, config.subdomain,
        platform.domain || config.domain);
      if (activated.length > 0) emit(onEvent, step, totalSteps, 'success', `Activated ${activated.length} waiting connections`);
    } catch (error) {
      logOperationFailure(`Activating connections waiting for ${appId}`, error);
      emit(onEvent, step, totalSteps, 'warning', 'Connections waiting for this app could not be activated');
    }
  }
}

// Re-export for backward compat
export { getContainerName } from './engine-helpers';
