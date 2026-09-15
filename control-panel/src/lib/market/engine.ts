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
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { resolveVariables, resolveEnvironment } from './variables';
import { deepestConfigStorageMount, enforceAllConfigFilePermissions, writeAllConfigFiles } from './config-writer';
import {
  listInstalledApps,
  saveInstallMetadata,
  removeInstallMetadata,
  removeInstallMetadataRecord,
  readInstallMetadata,
} from './metadata';
import { getInstalledApp, upsertInstalledApp, removeInstalledApp } from './installed-apps';
import { deployOCIContainer, startOCIContainer, getContainerIP, containerExists } from '../infrastructure/oci-deployer';
import { adoptRestoredLXDContainer, deployMarketLXDContainer } from '../infrastructure/lxd-deployer';
import { execCommand, incusRequest, incusUploadFile } from '../incus/server';
import { applyResourcePolicy } from '../infrastructure/resource-policy';
import { execShell } from '../incus/server';
import {
  getOrCreateSecret,
  generatePassword,
  generateSecretKey,
  generateHexToken,
  readSecret,
  writeSecret,
} from '../infrastructure/secrets';
import { addRoute, getRoutes, removeRoute, removeAppRoutes, addAppRoutes, migrateSystemUpstreamsToIPv4, resolveCaddyUpstreamDial } from '../caddy/client';
import type { EntranceConfig } from '../caddy/client';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import {
  executeSSOSteps,
  StepError,
} from './sso-engine';
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
  coerceInstallParams,
  getPlatformContext,
} from './platform-env';
import { getContainerName } from './engine-helpers';
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
} from '../incus/app-network';
import { injectCaddyRootCA, stageCaddyTrustBundle } from './caddy-ca';
import { activatePendingBridges, detectBridgeDependencies, createBridge, resolveBridgeMappings, activateBridge, pushConnectionsToUI } from '../bridges/manager';
import { generateSuggestionsForApp } from '../bridges/suggestions';
import { getMarketSource } from './source';
import { getUserById } from '@/lib/identity/store';
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

// ─── Install Rollback ─────────────────────────────────────

interface RollbackContext {
  containerNames: string[];
  appId: string;
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

  // 1. Remove containers
  for (const name of ctx.containerNames) {
    try {
      if (!(await containerExists(name))) continue;
      try {
        await incusRequest('PUT', `/1.0/instances/${name}/state`, { action: 'stop', force: true, timeout: 10 });
        await new Promise((r) => setTimeout(r, 2000));
      } catch {
        console.warn(`[engine] Rollback could not confirm stop for container ${name}; delete verification will decide the result`);
      }
      const result = await incusRequest('DELETE', `/1.0/instances/${name}`);
      if (result.type === 'error') throw new Error(result.error || result.status);
      if (result.type === 'async' && result.operation) {
        const waited = await incusRequest('GET', `${result.operation}/wait?timeout=30`, undefined, { timeout: 40_000 });
        if (waited.type === 'error') throw new Error(waited.error || waited.status);
      }
      if (await containerExists(name)) throw new Error('container still exists after delete');
    } catch (err) {
      recordFailure(`container ${name}`, err);
    }
  }

  // 2. Remove Caddy route
  if (ctx.subdomain && ctx.domain) {
    try {
      const hostname = `${ctx.subdomain}.${ctx.domain}`;
      const routes = await getRoutes();
      for (const route of routes) {
        if (route.hostname === hostname) {
          await removeRoute(route.id);
        }
      }
      await removeAppRoutes(ctx.appId);
      const remainingRoutes = await getRoutes();
      if (remainingRoutes.some((route) => route.hostname === hostname || route.id.startsWith(`app-${ctx.appId}-`))) {
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

  // 5. Remove generated secrets and new-app data. Install metadata remains the
  // durable recovery map until every other resource is verified absent.
  if (!ctx.preserveData) {
    try {
      const { rm } = await import('fs/promises');
      await Promise.all([
        `/var/lib/youeye/apps/${ctx.appId}`,
        `/var/lib/youeye/secrets/app-${ctx.appId}`,
        ...(ctx.dataPaths ?? []),
      ].map((target) => rm(target, { recursive: true, force: true })));
      if ([
        `/var/lib/youeye/apps/${ctx.appId}`,
        `/var/lib/youeye/secrets/app-${ctx.appId}`,
        ...(ctx.dataPaths ?? []),
      ].some((target) => existsSync(target))) {
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

function getSecretsPath(appId: string): string {
  return `app-${appId}`;
}

const LEGACY_IDENTITY_PROVIDER_INTEGRATION = 'youeye-id';

// Shared storage groups live under one root so members share a filesystem (hardlink-safe).

function hasLegacySSOConfigureIntegration(manifest: AppManifest): boolean {
  const setupMethod = manifest.sso?.setup?.method;
  return (
    (setupMethod === 'api' && (manifest.sso?.setup?.api?.steps?.length ?? 0) > 0) ||
    (setupMethod === 'cli' && (manifest.sso?.setup?.cli?.steps?.length ?? 0) > 0)
  );
}

function getDefaultSelectedIntegrations(manifest: AppManifest): string[] {
  const ids = new Set<string>();

  for (const integration of manifest.integrations ?? []) {
    if (integration.required || integration.installByDefault || integration.recommended) {
      ids.add(integration.id);
    }
  }

  if (hasLegacySSOConfigureIntegration(manifest)) {
    ids.add(LEGACY_IDENTITY_PROVIDER_INTEGRATION);
  }

  return [...ids];
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
  secretsPath: string,
  rollbackCtx: RollbackContext
): Promise<NonNullable<InstallMetadata['aiConnection']> | null> {
  if (!usesManagedAI(manifest, config)) return null;
  const actor = await managedAIActor(config);
  const externalInstallationId = config.aiSettings?.externalInstallationId;
  const groupId = config.aiSettings?.modelGroupId;
  if (!externalInstallationId || !groupId) {
    throw new Error('AI Settings preflight did not produce an exact installation and group');
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
  await writeSecret(secretsPath, 'pointer_api_key', delivery.credential);
  const protectedReadBack = await readSecret(secretsPath, 'pointer_api_key');
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
  if (!hasLegacySSOConfigureIntegration(manifest)) return true;
  return selectedIntegrations.includes(LEGACY_IDENTITY_PROVIDER_INTEGRATION);
}

function oauthScopesForManifest(manifest: AppManifest): string[] {
  const scopes = new Set(['openid', 'profile', 'email', 'groups']);
  if (manifest.sso?.adminMapping?.type === 'roleClaim') {
    scopes.add(manifest.sso.adminMapping.claimName);
  }
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

  // SSO configure steps
  const hasConfigureSteps = ssoEnabled && manifest.sso && (
    (manifest.sso.setup?.method === 'api' && (manifest.sso.setup.api?.steps?.length ?? 0) > 0) ||
    (manifest.sso.setup?.method === 'cli' && (manifest.sso.setup.cli?.steps?.length ?? 0) > 0)
  );
  if (hasConfigureSteps) steps++;

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
    containerName: artifact.containerName,
    sourceRepo: artifact.sourceRepo,
    releaseTag: artifact.tag,
    version: artifact.version,
    artifactName: artifact.artifactName,
    sha256: artifact.artifactSHA256,
    bytes: artifact.artifactBytes,
    signature: artifact.signature.status === 'unsigned' ? 'unsigned' as const : 'verified-development' as const,
    signatureKeyId: artifact.signature.status === 'verified-development' ? artifact.signature.keyId : undefined,
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
  const nativeIdentityIntegrationPlanned = config.plannedNativeIdentityIntegration === true;
  const hasOwnAccountLogin = ssoEnabled || nativeIdentityIntegrationPlanned;
  const forwardAuthChoice = hasOwnAccountLogin ? config.forwardAuthGate : config.protectWithAccountLogin;
  const forwardAuthEnabled = resolveForwardAuth(manifest, hasOwnAccountLogin, forwardAuthChoice);
  const ssoSlug = ssoEnabled ? `youeye-app-${manifest.metadata.id}` : undefined;
  const installedVersion = manifest.version ?? '';
  return {
    appId: manifest.metadata.id,
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
    manifestDigest: config.manifestDigest,
    integration: manifest.integration,
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
    entrances: manifest.entrances?.map((entrance) => ({ ...entrance })),
    containers: describeContainers(manifest),
    ssoSlug,
    ssoClientId: ssoSlug,
    forwardAuthSlug: forwardAuthEnabled ? `youeye-fa-${manifest.metadata.id}` : undefined,
    manifestSource: config.repoUrl || config.sourceRepoUrl || 'market',
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
  const routeCollision = (await getRoutes()).find((route) =>
    route.hostname === hostname || route.id.startsWith(`app-${appId}-`),
  );
  if (routeCollision) {
    throw new AppNetworkOperationConflictError(
      `App ${appId} conflicts with existing route ${routeCollision.id} for ${routeCollision.hostname}`,
    );
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
    const orphanPath = [
      `/var/lib/youeye/app-${appId}`,
      `/var/lib/youeye/apps/${appId}`,
      `/var/lib/youeye/secrets/app-${appId}`,
    ].find((candidate) => existsSync(candidate));
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

/**
 * Fetch an icon image and return it as a base64 data URI.
 * This inlines the icon at install time so it works on all domains
 * (UI, native app subdomains) without needing a runtime image proxy.
 * Returns null on failure — caller should fall back to the Lucide icon name.
 */
async function fetchIconAsDataUri(iconRef: string): Promise<string | null> {
  // Extract the real URL from proxy wrapper if present
  let url = iconRef;
  if (iconRef.startsWith('/api/market/image?url=')) {
    const encoded = iconRef.replace('/api/market/image?url=', '');
    url = decodeURIComponent(encoded);
  }

  if (!url.startsWith('http')) return null;

  try {
    const https = await import('https');
    const parsed = new URL(url);
    const isInsecure = false; // GitHub uses valid TLS

    const buffer: Buffer = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        rejectUnauthorized: !isInsecure,
        timeout: 10_000,
      };

      const req = https.request(options, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          fetchIconAsDataUri(redirectUrl).then(r => {
            if (r) {
              // Return the data URI as a Buffer trick — unwrap in caller
              resolve(Buffer.from(r, 'utf-8'));
            } else {
              reject(new Error('Redirect failed'));
            }
          }).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });

    // Determine MIME type from URL extension or content
    const ext = parsed.pathname.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      ico: 'image/x-icon',
    };
    const mime = mimeMap[ext ?? ''] ?? 'image/png';

    // Check if we got a data URI back from redirect handling
    const asString = buffer.toString('utf-8');
    if (asString.startsWith('data:')) return asString;

    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    console.warn('[engine] Failed to inline an app icon');
    return null;
  }
}

async function registerAppWithUI(
  appId: string,
  name: string,
  subdomain: string,
  containerName: string,
  port: number,
  icon: string | null,
  appToken?: string,
  ssoEntryUrl?: string,
  linkHandlers?: Array<{ type: string; description: string; endpoint?: string; triggers: string[] }>,
  manifest?: Record<string, unknown>,
): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) throw new Error('YE-UI container IP is unavailable');

  const bridgeToken = await readBridgeToken();
  if (!bridgeToken) throw new Error('UI bridge token is unavailable');
  const containerUrl = port ? `http://${containerName}.${CONTAINER_DOMAIN}:${port}` : `http://${containerName}.${CONTAINER_DOMAIN}`;

  // Hash the app token so YE-UI can validate future app requests by hash lookup
  let tokenHash: string | undefined;
  if (appToken) {
    const crypto = await import('crypto');
    tokenHash = crypto.createHash('sha256').update(appToken).digest('hex');
  }

  const payload: Record<string, unknown> = {
    id: appId, name, container_url: containerUrl, subdomain, icon,
    token_hash: tokenHash, sso_entry_url: ssoEntryUrl,
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

// ─── Release Repo Helpers ─────────────────────────────────

function repoPartsFromSource(repo: string, fallbackOrg: string): { org: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length >= 2) {
    return { org: parts[0], repo: parts[parts.length - 1] };
  }
  return { org: fallbackOrg, repo: parts[0] };
}

// ─── Main Install Function (v2: unified) ──────────────────

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

  return withAppNetworkOperationLock(appId, 'install', async () => {
    await preflightManagedAISelection(manifest, config);
    rollbackCtx.aiExternalInstallationId = config.aiSettings?.externalInstallationId;
    const selectedIntegrations = getSelectedIntegrations(manifest, config);
    const ssoEnabled = shouldEnableSSO(manifest, selectedIntegrations);
    const needsSSO = ssoEnabled || config.plannedNativeIdentityIntegration === true;
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
    const recoveredNativeContainers = manifest.containers
      .filter((container) => restoreOptions?.runtimeInstances?.[
        getContainerName(appId, container.name, manifest.containers.length)
      ])
      .map((container) => container.name);
    const stagedNativeArtifacts = await stageMarketNativeArtifacts(manifest, config, {
      skipContainerNames: recoveredNativeContainers,
    });

    try {
      try {
        onEvent({ step: 0, totalSteps, status: 'running', message: 'Reserving isolated /27 app network...' });
        const network = await createAppNetwork(appId, {
          nat: true,
          operationId,
          requiredAddresses,
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
        const rollback = await rollbackInstall(rollbackCtx, onEvent, totalSteps);
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
  });
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
  const secretsPath = getSecretsPath(appId);

  // Determine SSO support from manifest
  const selectedIntegrations = getSelectedIntegrations(manifest, config);
  const identityConfig = await getIdentityProviderConfig();
  const ssoEnabled = shouldEnableSSO(manifest, selectedIntegrations);
  const nativeIdentityIntegrationPlanned = config.plannedNativeIdentityIntegration === true;
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
      const secretValue = await readFile(`/var/lib/youeye/app-${appId}/${secret.file}`, 'utf-8');
      secrets[secret.name] = secretValue.trim();
    }
    emit(onEvent, step, totalSteps, 'success', 'Secrets read from backup');
  } else {
    emit(onEvent, step, totalSteps, 'running', 'Generating secrets...');
    for (const secret of manifest.secrets) {
      const generator = getGenerator(secret.generator, secret.length);
      secrets[secret.name] = await getOrCreateSecret(secretsPath, secret.file, generator);
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
      secretsPath,
      rollbackCtx
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

  let dbPassword = '';
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
      prelimCtx.secrets = secrets;

      if (manifest.sso.callback_path) {
        const resolvedCallbackPath = resolveVariables(manifest.sso.callback_path, prelimCtx);
        redirectUris.push(`${appUrl}${resolvedCallbackPath}`);
      }

      for (const cb of manifest.sso.additional_callbacks || []) {
        redirectUris.push(cb);
      }

      rollbackCtx.ssoSlug = ssoSlug;
      const result = await createOAuthClient({
        clientId: ssoSlug,
        name: manifest.metadata.name,
        redirectUris,
        scopes: oauthScopesForManifest(manifest),
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

  const wantsInternet = manifest.containers.some(c => c.network === 'internet')
    || (manifest.internet?.hosts?.length ?? 0) > 0;

  const appToken = await generateAppToken(appId);
  const ctx = await buildCanonicalContext(manifest, config, ssoResult, dbPassword, appToken, !!appBridgeName);
  ctx.secrets = secrets;

  // Populate installParams with type coercion
  if (config.installParams) {
    ctx.installParams = coerceInstallParams(
      config.installParams,
      manifest.installParams || [],
    );
  }

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
            nodeVersion: source.nodeVersion || '22.x',
            appDir: source.appDir || '/opt/app',
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
          if (recoveredRuntime) {
            const recoveryNetwork = appNIC?.eth0?.network;
            if (!recoveryNetwork) throw new Error('Recovered native runtime has no target app network');
            await spineClient.importIncusInstance({
              archivePath: recoveredRuntime.archivePath,
              name: containerName,
              pool: recoveredRuntime.pool,
              network: recoveryNetwork,
            });
            await adoptRestoredLXDContainer(lxdSpec, appNIC);
          } else {
            if (!stagedArtifact) throw new Error(`Native artifact preflight is missing for ${containerSpec.name}`);
            const marketSource = await getMarketSource();
            const gitInfo = repoPartsFromSource(source.repo, marketSource.organization);
            await deployMarketLXDContainer(
              lxdSpec,
            {
              spineSocketPath: '/var/run/youeye/youeye.sock',
              giteaBaseURL: marketSource.base_url,
              giteaOrg: gitInfo.org,
              giteaRepo: gitInfo.repo,
              tagPrefix: source.tagPrefix,
            },
            stagedArtifact,
            appNIC,
            );
          }

          // Write env file to LXD container
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = { ...envFromMapping, ...staticEnv };
          await writeEnvToContainer(containerName, fullEnv);

          // Restart service to pick up env
          await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 15_000 });

          // Post-deploy commands
          if (containerSpec.postDeploy && containerSpec.postDeploy.length > 0) {
            for (const cmd of containerSpec.postDeploy) {
              await execShell(containerName, cmd.exec, { timeout: cmd.timeout });
            }
          }
        } else {
          // ── OCI container deployment ─────────────────
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = { ...envFromMapping, ...staticEnv };
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
          await deployOCIContainer(ociManifest, '', appNIC, { start: !appBridgeName });
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
        let healthy = false;
        if (containerSpec.healthCheck.type === 'http') {
          healthy = await waitForAppHealth(
            containerName,
            containerSpec.port || 80,
            containerSpec.healthCheck.path,
            containerSpec.healthCheck.timeout
          );
        } else if (containerSpec.healthCheck.type === 'postgres') {
          healthy = await waitForPostgresHealth(
            containerName,
            containerSpec.healthCheck.user,
            containerSpec.healthCheck.timeout
          );
        }

        const hcDuration = Date.now() - hcStart;
        if (healthy) {
          onEvent({ step, totalSteps, status: 'success', message: `${containerName} is healthy`, duration: hcDuration });
        } else {
          const hcUrl = containerSpec.healthCheck.type === 'http'
            ? `http://${containerName}:${containerSpec.port || 80}${containerSpec.healthCheck.path || '/'}`
            : `postgres://${containerName}`;
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

  // ── Step 7: SSO Configure Steps ─────────────────────────

  const hasConfigureSteps = ssoEnabled && manifest.sso?.setup && (
    (manifest.sso.setup.method === 'api' && (manifest.sso.setup.api?.steps?.length ?? 0) > 0) ||
    (manifest.sso.setup.method === 'cli' && (manifest.sso.setup.cli?.steps?.length ?? 0) > 0)
  );

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

  if (hasConfigureSteps) {
    checkCancelled();
    // Get primary container IP for SSO configuration
    const primaryIP = await getContainerIP(primaryContainerName);
    if (primaryIP) {
      ctx.container = { ip: primaryIP, port: primaryPort };
    }

    step++;
    emit(onEvent, step, totalSteps, 'running', `Configuring ${manifest.metadata.name} SSO...`);
    try {
      if (manifest.sso!.setup?.method === 'cli' && manifest.sso!.setup.cli?.steps) {
        // CLI-based SSO setup: exec commands in primary container
        for (const cliStep of manifest.sso!.setup.cli.steps) {
          const resolvedCmd = resolveVariables(cliStep.exec, ctx);
          await execShell(primaryContainerName, resolvedCmd, { timeout: cliStep.timeout });
        }
      } else {
        // API-based SSO setup
        await executeSSOSteps(manifest.sso!, ctx);
      }
      emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} SSO configured`);

      // F2: Runtime roleClaim scope warning
      if (manifest.sso?.adminMapping?.type === 'roleClaim') {
        const { checkRoleClaimScope } = await import('./validator');
        const scopeWarning = checkRoleClaimScope(manifest);
        if (scopeWarning) {
          onEvent({
            step,
            totalSteps,
            status: 'warning',
            message: scopeWarning.message,
            detail: scopeWarning.detail,
          });
        }
      }
    } catch (err) {
      const errorContext = err instanceof StepError ? err.errorContext : undefined;
      onEvent({
        step,
        totalSteps,
        status: 'error',
        message: 'SSO configuration failed',
        detail: 'Identity integration configuration failed',
        errorContext,
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
    if (forwardAuthEnabled) {
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

    if (manifest.entrances && manifest.entrances.length > 0) {
      // Multi-entrance routing: each entrance gets its own Caddy route
      const entrances: EntranceConfig[] = manifest.entrances.map((e) => ({
        name: e.name,
        path: e.path || '/',
        port: e.port,
        container: e.container,
        protocol: e.protocol || 'http',
        authLevel: e.authLevel || 'private',
        stripPath: e.stripPath || false,
      }));

      await addAppRoutes(appId, hostname, entrances, primaryContainerName, forwardAuthConfig, appBridgeName);
      emit(onEvent, step, totalSteps, 'success', `Routes added: ${entrances.length} entrances for ${hostname}`);
    } else {
      // Single-route (standard)
      // For per-app bridge containers, use IP instead of DNS name.
      // Caddy's DNS resolver (incusbr0) can't resolve names on app bridges.
      let routeUpstream = primaryContainerName;
      if (appBridgeName) {
        const appIP = await getIncusContainerIP(primaryContainerName);
        if (appIP) routeUpstream = appIP;
      }
      await ensureRoute({
        hostname,
        path: '/*',
        upstream: routeUpstream,
        port: primaryPort,
        forwardAuth: forwardAuthConfig,
      });
      emit(onEvent, step, totalSteps, 'success', `Route added: ${hostname}`);
    }
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
    appId,
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
    manifestDigest: config.manifestDigest,
    nativeArtifacts: describeNativeArtifacts(stagedNativeArtifacts),
    integration: manifest.integration,
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    forwardAuthEnabled,
    protectWithAccountLogin: ssoEnabled || nativeIdentityIntegrationPlanned || forwardAuthEnabled,
    installedAt: new Date().toISOString(),
    installedVersion,
    catalogVersion: installedVersion || undefined,
    enabled: false,
    desiredState: 'stopped',
    autoRestart: true,
    entrances: manifest.entrances?.map((entrance) => ({ ...entrance })),
    containers: containerMetas,
    ssoSlug,
    ssoClientId,
    forwardAuthSlug: rollbackCtx.forwardAuthSlug,
    manifestSource: config.repoUrl || config.sourceRepoUrl || 'market',
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
    hasSSO: ssoEnabled,
    provides: manifest.provides?.length ? manifest.provides : undefined,
    wants: manifest.wants?.length ? manifest.wants : undefined,
    aiConnection,
    usePerAppBridge: !!appBridgeName,
  };
  await saveInstallMetadata(meta);
  finalMetadata = meta;

  emit(onEvent, step, totalSteps, 'success', 'Configuration saved');

  // ── Step 10: Prepare UI dashboard commit ────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Preparing dashboard registration...');
  try {
    const displayName = config.customName || manifest.metadata.name;
    // Inline icon as base64 data URI so it works on all subdomains
    const iconRef = config.customIcon || manifest.metadata.iconUrl || null;
    let displayIcon: string | null = null;
    if (iconRef) {
      displayIcon = await fetchIconAsDataUri(iconRef);
    }
    // Fall back to Lucide icon name if inlining failed or no URL available
    if (!displayIcon) {
      displayIcon = manifest.metadata.icon || null;
    }
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

  // ── Step 11: Detect bridge dependencies from env_mapping ──

  if (manifest.env_mapping) {
    const deps = detectBridgeDependencies(manifest.env_mapping, appId);
    for (const dep of deps) {
      await createBridge({
        from: appId,
        to: dep.targetAppId,
        envMappings: dep.envMappings,
        approvedBy: 'auto',
      });
    }
    if (deps.length > 0) {
      emit(onEvent, step, totalSteps, 'success', `Detected ${deps.length} bridge dependencies`);
    }
  }

  // ── Step 12: Activate approved connections from install dialog ──

  const approvedConnections = config.approvedConnections ?? [];
  const approvedIds = new Set(
    approvedConnections.filter(c => c.approved).map(c => c.targetAppId)
  );

  if (approvedIds.size > 0) {
    step++;
    emit(onEvent, step, totalSteps, 'running', `Setting up ${approvedIds.size} approved connections...`);
    const platform = await getPlatformContext();
    const dom = platform.domain || config.domain;
    let activated = 0;

    for (const targetId of approvedIds) {
        // Build env mappings from manifest.wants (if this app references the target)
        const envMappings = manifest.env_mapping
          ? detectBridgeDependencies(manifest.env_mapping, appId)
              .filter(d => d.targetAppId === targetId)
              .flatMap(d => d.envMappings)
          : [];

        const bridge = await createBridge({
          from: appId,
          to: targetId,
          envMappings,
          approvedBy: 'install',
        });

      // If target is installed, resolve mappings and activate immediately.
      // A missing target remains a durable pending approval; a present target
      // must activate exactly or the install rolls back.
      const targetMeta = await readInstallMetadata(targetId);
      if (targetMeta) {
        const targetContainer = targetMeta.containers?.[0]?.containerName || `app-${targetId}`;
        const targetPort = manifest.wants?.find(w => w.appId === targetId || w.type)?.defaultPort || 8080;
        const targetSub = targetMeta.subdomain || targetId;

        const resolved = await resolveBridgeMappings(
          envMappings, targetContainer, targetPort, targetSub, dom
        );
        const { updateBridge } = await import('../bridges/store');
        await updateBridge(bridge.id, { envMappings: resolved });
        const result = await activateBridge(bridge.id);
        if (!result?.active) throw new Error(`Approved bridge ${bridge.id} did not become active`);
        activated++;
      }
    }

    emit(onEvent, step, totalSteps, 'success',
      activated > 0
        ? `Activated ${activated} connections`
        : `${approvedIds.size} connections created (will activate when targets are installed)`
    );
  }

  // ── Step 12b: Activate pending bridges targeting this app ──

  const pendingPlatform = await getPlatformContext();
  const pendingDomain = pendingPlatform.domain || config.domain;
  const activatedPending = await activatePendingBridges(
    appId,
    primaryContainerName,
    primaryPort,
    config.subdomain,
    pendingDomain,
  );
  if (activatedPending.length > 0) {
    emit(onEvent, step, totalSteps, 'success', `Activated ${activatedPending.length} pending bridges`);
  }

  // ── Step 13: Generate suggestions for unapproved connections ──

  try {
    const suggestions = await generateSuggestionsForApp(manifest, approvedIds);
    if (suggestions.length > 0) {
      emit(onEvent, step, totalSteps, 'success', `Generated ${suggestions.length} connection suggestions`);
    }
  } catch {
    console.warn('[engine] Suggestions generation failed');
  }

  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown post-deploy failure';
    console.error(`[market] Post-deploy configuration failed for ${appId}: ${reason}`);
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
    finalMetadata.enabled = true;
    finalMetadata.desiredState = 'running';
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
      appToken,
      dashboardRegistration.ssoEntryUrl,
      dashboardRegistration.linkHandlers ?? [],
      manifest as unknown as Record<string, unknown>,
    );
    const { isAppRegisteredWithUI } = await import('./reconciler');
    if (!await isAppRegisteredWithUI(appId)) throw new Error('Dashboard registration did not read back after commit');
    await pushConnectionsToUI(appId);
    emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} installed successfully!`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown final installation failure';
    console.error(`[market] Final installation commit failed for ${appId}: ${reason}`);
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw error;
  }
}

// Re-export for backward compat
export { getContainerName } from './engine-helpers';
