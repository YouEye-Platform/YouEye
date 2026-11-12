/**
 * App uninstaller for the Market. It decides only from the app's install.json (and acts only
 * on the exact resources recorded there): containers by exact name and only when tagged with
 * the installation id, routes by exact hostname/upstream, the app's own database and role,
 * volumes by ownership tags, the generated CA directory and the app's secrets.
 * A failed deletion keeps install.json with `cleanupPending: true`; the next uninstall retries.
 */

import { execCommand } from '../incus/server';
import { containerExists } from '../infrastructure/oci-deployer';
import { getRoutes, removeRoute } from '../caddy/client';
import { readInstallMetadata, saveInstallMetadata, removeInstallMetadata, removeInstallMetadataRecord } from './metadata';
import { getInstalledApp, removeInstalledApp } from './installed-apps';
import { removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import { cleanupAppByScan, isAppRegisteredWithUI } from './reconciler';
import type { StorageVolumeMeta, UninstallVerification } from './types';
import {
  deleteAppNetwork,
  getAppNetworkLease,
  markAppNetworkCleanupPending,
  removeCaddyFromAppNetwork,
  removeSystemProxyDevices,
  withAppNetworkOperationLock,
} from '../incus/app-network';
import { archivePointerManagedAppIfPresent, readPointerManagedApp } from '@/lib/pointer/managed-apps';
import { deleteAllAppSecrets, readAppSecret } from '@/lib/infrastructure/secrets';
import { removeCaddyTrustBundle } from './caddy-ca';
import { deleteOwnedInstance } from './instance-ownership';
import { assertRestoredManagedAI, type RestoredManagedAI } from './restored-managed-ai';
import { deleteAppStorage, verifyAppStorageRemoval } from './storage';
import { withAppInventory, withAppLifecycle } from './update-admission';
import { revokeAppCredential } from '../apps/service-credential-bridge';
import { quiesceAppCredentialRuntime } from '../apps/service-credential-probe';

const POSTGRES_CONTAINER = 'youeye-postgres';

// ─── Unified Uninstall ────────────────────────────────────

/**
 * Fully uninstall any app (Market-installed or native):
 * 0. Stop its containers (credential revocation comes before anything else)
 * 1. Delete its connections (connect files' `remove:` steps are attempted first; see below), then
 *    delete its containers (exact recorded names, installation-tagged only)
 * 2. Remove Caddy routes (exact hostname / upstream)
 * 3. Clean up SSO (identity provider + application)
 * 4. Remove Pi-Hole DNS entries
 * 5. Remove the generated CA directory
 * 6. Delete data (unless keepData): the app's database and role, its volumes and its secrets
 * 7. Remove install metadata (kept with cleanupPending when anything failed)
 * 8. Post-uninstall verification
 */
export async function uninstallApp(
  appId: string,
  options: {
    keepData?: boolean;
    preserveAdmission?: boolean;
    /** Internal paired restore only; validated before any runtime deletion. */
    preserveManagedAI?: RestoredManagedAI;
  } = {}
): Promise<{ success: boolean; errors: string[]; verification: UninstallVerification }> {
  return withAppInventory(() => withAppLifecycle(appId, () =>
    withAppNetworkOperationLock(appId, 'remove', () => uninstallAppLocked(appId, options))));
}

async function uninstallAppLocked(
  appId: string,
  options: {
    keepData?: boolean;
    preserveAdmission?: boolean;
    preserveManagedAI?: RestoredManagedAI;
  },
): Promise<{ success: boolean; errors: string[]; verification: UninstallVerification }> {
  // Revocation must be acknowledged before deleting runtime/registration.
  // Failure keeps the operation recoverable under the app lifecycle lock.
  const metadata = await readInstallMetadata(appId);
  const aiExternalInstallationId = metadata?.aiConnection?.externalInstallationId
    || metadata?.aiConnectionPending?.externalInstallationId;
  if (options.preserveManagedAI && aiExternalInstallationId) {
    if (!options.preserveAdmission || options.keepData !== false
      || aiExternalInstallationId !== options.preserveManagedAI.externalInstallationId) {
      throw new Error('Cannot replace a different managed AI installation during restore');
    }
    assertRestoredManagedAI(appId, options.preserveManagedAI,
      await readPointerManagedApp(aiExternalInstallationId), await readAppSecret(appId, 'pointer_api_key'));
  }
  if (metadata) {
    metadata.serviceCredentialState = 'pending';
    metadata.enabled = false;
    metadata.desiredState = 'stopped';
    await saveInstallMetadata(metadata);
    for (const container of metadata.containers) {
      if (await containerExists(container.containerName)) await quiesceAppCredentialRuntime([container.containerName]);
    }
  }
  await revokeAppCredential(appId);
  if (!metadata) {
    const scanned = await cleanupAppByScan(appId, {
      keepData: options.keepData ?? true,
    });
    const verification = await verifyUninstall(
      appId,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      false,
      options.keepData ?? true,
    );
    const success = scanned.unresolved.length === 0
      && verification.networkRemoved
      && verification.leaseReleased;
    return {
      success,
      errors: success ? [] : [`No install metadata found for app: ${appId}`, ...scanned.unresolved],
      verification,
    };
  }

  const errors: string[] = [];
  const keepData = options.keepData ?? true;
  // Delete-data removes the shared-Postgres database and role only when this installation
  // created them (a database it found, or one another installation made, is never dropped).
  const dropDb = !keepData && metadata.databaseMode === 'shared' && metadata.sharedDatabaseCreated === true;
  const { verifyAdmissionCleanup } = await import('@/lib/admission/lifecycle');
  await verifyAdmissionCleanup(metadata, keepData, options.preserveAdmission === true);
  if (keepData) {
    if (dropDb) throw new Error('Keep-data uninstall cannot drop the app database');
    const { retainAdmissionOnUninstall } = await import('@/lib/admission/lifecycle');
    const { retainAppRoots } = await import('@/lib/admission/retained-data');
    // Close authoritative admission before stopping/copying. The durable map
    // and isolated copy readback must succeed before any original is deleted.
    await retainAdmissionOnUninstall(appId, true);
    await retainAppRoots(metadata);
  }

  if (aiExternalInstallationId && !options.preserveManagedAI) {
    try {
      const archived = await archivePointerManagedAppIfPresent(aiExternalInstallationId);
      if (!archived.archived || !archived.credentialsRevoked) {
        throw new Error('Pointer did not confirm credential revocation');
      }
    } catch {
      errors.push('Pointer AI connection cleanup or verification failed');
    }
  }

  const containers = metadata.containers;
  const containerNames = containers.map((c) => c.containerName);
  const owner = metadata.installationId ? { appId, installationId: metadata.installationId } : undefined;

  // 1. Delete the app's connections before its containers: deleting one attempts the consumer's
  // connect file `remove:` steps (non-fatal), then removes the scoped secondary NIC grants, which
  // must go before the target primary bridge can be deleted. This app's containers were stopped at
  // the start (credential quiescence), so steps that run in it or call it fail and are logged;
  // steps that run in the other app still do.
  try {
    const { getBridgesForApp, deleteBridge } = await import('../bridges/manager');
    const bridges = await getBridgesForApp(appId);
    for (const bridge of bridges) {
      await deleteBridge(bridge.id);
    }
    if ((await getBridgesForApp(appId)).length > 0) throw new Error('integration records remain');
  } catch {
    errors.push('Explicit integration cleanup or verification failed');
  }
  try {
    const { forgetSuggestionsForApp } = await import('../bridges/suggestions');
    await forgetSuggestionsForApp(appId);
  } catch {
    console.warn(`[Market] Connection suggestions for ${appId} could not be cleared`);
  }

  // 1b. Stop and delete the recorded containers, only when tagged with this installation.
  for (const c of containers) {
    try {
      await deleteOwnedInstance(c.containerName, owner);
    } catch {
      errors.push(`Container ${c.containerName} cleanup or verification failed`);
    }
  }

  // 1c. Remove Control-owned proxy and Caddy attachments. Retain the bridge
  // and lease as the durable cleanup owner until every later step succeeds.
  try {
    await removeSystemProxyDevices(appId);
    await removeCaddyFromAppNetwork(appId);
  } catch {
    errors.push('App network attachment cleanup or verification failed');
  }

  // 2. Remove Caddy routes
  let caddyRemoved = false;
  if (metadata.subdomain && metadata.domain) {
    try {
      const hostname = `${metadata.subdomain}.${metadata.domain}`;
      const routes = await getRoutes();
      for (const route of routes) {
        if (route.hostname === hostname) {
          await removeRoute(route.id);
          caddyRemoved = true;
        }
      }
      if (!caddyRemoved) {
        // Also check by upstream container name
        for (const c of containers) {
          for (const route of routes) {
            if (route.upstream === c.containerName) {
              await removeRoute(route.id);
              caddyRemoved = true;
            }
          }
        }
      }
      if (!caddyRemoved) caddyRemoved = true; // No route found = already clean

      const remaining = await getRoutes();
      if (remaining.some((route) => route.hostname === hostname
        || containers.some((container) => route.upstream === container.containerName))) {
        throw new Error('one or more app routes remain');
      }
    } catch {
      errors.push('Caddy route cleanup or verification failed');
    }
  }

  // 3. Remove identity SSO app (OAuth2 + forward-auth proxy)
  const ssoClientId = metadata.ssoClientId || metadata.ssoSlug;
  if (ssoClientId) {
    try {
      await removeOAuthClient(ssoClientId);
      const { getClient } = await import('@/lib/identity/store');
      if (await getClient(ssoClientId)) throw new Error('identity client remains');
    } catch {
      errors.push('Identity OAuth client cleanup or verification failed');
    }
  }

  if (metadata.forwardAuthEnabled && metadata.subdomain && metadata.domain) {
    try {
      await removeForwardAuth({ hostname: `${metadata.subdomain}.${metadata.domain}` });
    } catch {
      errors.push('Identity forward-auth cleanup failed');
    }
  }

  // 4. Remove Pi-Hole DNS entries for app subdomain
  if (metadata.subdomain && metadata.domain) {
    try {
      await removePiholeDNSForApp(metadata.subdomain, metadata.domain);
    } catch {
      errors.push('Pi-Hole DNS cleanup or verification failed');
    }
  }

  // 5. The generated CA directory holds no app data and is regenerated on install; a leftover
  // copy would block the next install's preflight.
  try {
    await removeCaddyTrustBundle(appId);
  } catch {
    errors.push('Generated CA directory cleanup failed');
  }

  // 5b. Drop the app's own shared database and role (delete-data only)
  if (dropDb) {
    try {
      await dropSharedPostgresDatabase(
        metadata.databaseName || appId,
        metadata.databaseUser || appId,
      );
    } catch {
      errors.push('Shared database cleanup or verification failed');
    }
  }

  // 6. Remove volume data and secrets if not keeping
  if (!keepData) {
    try {
      await deleteAppStorage(metadata.storageVolumes ?? []);
    } catch {
      errors.push('App data cleanup or verification failed');
    }
    try {
      await deleteAllAppSecrets(appId);
    } catch {
      errors.push('App secrets cleanup failed');
    }
  }

  // 7. Remove from installed_apps so cleanup_pending is never presented as a
  // successful install. Install metadata remains the exact recovery map until
  // all cleanup postconditions pass.
  try {
    await removeInstalledApp(appId);
    if (await getInstalledApp(appId)) throw new Error('installed-app record remains');
  } catch {
    errors.push('Installed-app state cleanup or verification failed');
  }

  // 7b. Deregister from YE-UI dashboard (remove from app drawer)
  try {
    await deregisterAppFromUI(appId, keepData || options.preserveAdmission === true);
    if (await isAppRegisteredWithUI(appId)) throw new Error('UI registration remains');
  } catch {
    errors.push('Dashboard registration cleanup or verification failed');
  }

  // 8. Delete and release the primary network only after every dependency is
  // absent. Any earlier failure deliberately retains cleanup_pending ownership.
  if (errors.length === 0) {
    try {
      await deleteAppNetwork(appId);
    } catch {
      errors.push('App network cleanup or verification failed');
    }
  } else {
    await markAppNetworkCleanupPending(appId, 'uninstall', errors.join('; ')).catch(() => {
      errors.push('Failed to persist cleanup_pending lease');
    });
  }

  // 9. Metadata is removed only after the network lease has been released.
  if (errors.length === 0) {
    try {
      if (!options.preserveAdmission) {
        const { retainAdmissionOnUninstall } = await import('@/lib/admission/lifecycle');
        await retainAdmissionOnUninstall(appId, keepData);
      }
      if (keepData) await removeInstallMetadataRecord(appId);
      else await removeInstallMetadata(appId);
    } catch (error) {
      errors.push('Install metadata cleanup or verification failed');
      await markAppNetworkCleanupPending(appId, 'uninstall-metadata', error).catch(() => undefined);
    }
  }

  // 10. Post-uninstall verification
  const verification = await verifyUninstall(
    appId,
    containerNames,
    metadata.subdomain,
    metadata.domain,
    ssoClientId,
    metadata.databaseName || appId,
    metadata.storageVolumes ?? [],
    dropDb,
    keepData
  );

  if (!verification.containerRemoved
    || !verification.networkRemoved
    || !verification.leaseReleased
    || !verification.caddyRouteRemoved
    || !verification.identityClientRemoved
    || !verification.dnsRemoved
    || verification.databaseDropped === false
    || verification.dataRemoved === false
    || verification.warnings.length > 0) {
    errors.push(`Post-uninstall verification failed: ${verification.warnings.join('; ') || 'one or more cleanup postconditions are false'}`);
  }
  if (errors.length > 0) await markCleanupPending(appId, errors);

  return {
    success: errors.length === 0,
    errors,
    verification,
  };
}

/**
 * Keep install.json as the recovery map with `cleanupPending: true` so the next uninstall or
 * cleanup retries exactly the recorded resources.
 */
async function markCleanupPending(appId: string, errors: string[]): Promise<void> {
  try {
    const current = await readInstallMetadata(appId);
    if (!current || current.cleanupPending) return;
    current.cleanupPending = true;
    await saveInstallMetadata(current);
  } catch {
    errors.push('Failed to persist cleanup_pending on install metadata');
  }
}

// ─── Dashboard Deregistration ────────────────────────────

export async function deregisterAppFromUI(appId: string, keepData = false): Promise<void> {
  const { getContainerIP } = await import('../incus/container-ip');
  const uiIP = await getContainerIP('youeye-ui');
  if (!uiIP) throw new Error('YE-UI container IP is unavailable');

  let bridgeToken: string | null = null;
  try {
    const { readFileSync } = await import('fs');
    bridgeToken = readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
  } catch {
    bridgeToken = process.env.UI_BRIDGE_TOKEN?.trim() ?? null;
  }

  if (!bridgeToken) throw new Error('UI bridge token is unavailable');

  const response = await fetch(`http://${uiIP}:3000/api/v1/apps/${appId}/unregister`, {
    method: 'DELETE',
    headers: { 'X-UI-Bridge-Token': bridgeToken, 'X-YouEye-Keep-Data': keepData ? 'true' : 'false' },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`YE-UI unregister failed with HTTP ${response.status}`);
  }
}

// ─── Pi-Hole DNS Cleanup ──────────────────────────────────

/**
 * Remove Pi-Hole CNAME records that point to an app subdomain.
 * Apps typically have a CNAME: subdomain.domain → control-panel container IP.
 */
async function removePiholeDNSForApp(subdomain: string, domain: string): Promise<void> {
  const { getCNAMERecords, removeCNAMERecord, getDNSRecords, removeDNSRecord } = await import('../apps/pihole-api');

    // Remove CNAME records matching the app subdomain
    const hostname = `${subdomain}.${domain}`;
    const cnameRecords = await getCNAMERecords();
    for (const record of cnameRecords) {
      if (record.domain === hostname) {
        await removeCNAMERecord(record.domain, record.target);
      }
    }

    // Remove A records matching the app subdomain
    const dnsRecords = await getDNSRecords();
    for (const record of dnsRecords) {
      if (record.domain === hostname) {
        await removeDNSRecord(record.ip, record.domain);
      }
    }
    const [remainingCNAMEs, remainingRecords] = await Promise.all([getCNAMERecords(), getDNSRecords()]);
    if (remainingCNAMEs.some((record) => record.domain === hostname)
      || remainingRecords.some((record) => record.domain === hostname)) {
      throw new Error('app DNS records remain after cleanup');
    }
}

// ─── Shared PostgreSQL ────────────────────────────────────

async function dropSharedPostgresDatabase(databaseName: string, databaseUser: string): Promise<void> {
  const { execCommand } = await import('../incus/server');
  const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
  if (!identifierPattern.test(databaseName) || !identifierPattern.test(databaseUser)) {
    throw new Error('Invalid shared database cleanup identifiers');
  }

  // Check if postgres is reachable first
  const check = await execCommand(POSTGRES_CONTAINER, ['/usr/local/bin/pg_isready', '-U', 'youeye'], { timeout: 5_000 });
  if (check.exitCode !== 0) throw new Error('PostgreSQL is unreachable');

  const database = `"${databaseName}"`;
  const role = `"${databaseUser}"`;

  const cleanup = await execCommand(
    POSTGRES_CONTAINER,
    [
      '/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${databaseName}' AND pid <> pg_backend_pid();`,
      '-c', `DROP DATABASE IF EXISTS ${database}`,
      '-c', `DROP ROLE IF EXISTS ${role}`,
    ],
    { timeout: 15_000 },
  );
  if (cleanup.exitCode !== 0) throw new Error('database cleanup failed');
  const verify = await execCommand(
    POSTGRES_CONTAINER,
    [
      '/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-tAc',
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='${databaseName}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${databaseUser}') THEN 1 ELSE 0 END`,
    ],
    { timeout: 10_000 },
  );
  if (verify.exitCode !== 0 || verify.stdout.trim() === '1') throw new Error('database resources remain after cleanup');
}

// ─── Post-Uninstall Verification ──────────────────────────

async function verifyUninstall(
  appId: string,
  containerNames: string[],
  subdomain?: string,
  domain?: string,
  ssoClientId?: string,
  databaseName?: string,
  storageVolumes: StorageVolumeMeta[] = [],
  droppedDb?: boolean,
  keptData?: boolean
): Promise<UninstallVerification> {
  const warnings: string[] = [];

  // Verify containers are gone
  let containerRemoved = true;
  for (const name of containerNames) {
    if (await containerExists(name)) {
      containerRemoved = false;
      warnings.push(`Container ${name} still exists after uninstall`);
    }
  }

  // Verify Caddy route is gone
  let caddyRouteRemoved = true;
  if (subdomain && domain) {
    try {
      const hostname = `${subdomain}.${domain}`;
      const routes = await getRoutes();
      const found = routes.some((r) => r.hostname === hostname);
      if (found) {
        caddyRouteRemoved = false;
        warnings.push(`Caddy route for ${hostname} still exists`);
      }
    } catch {
      caddyRouteRemoved = false;
      warnings.push('Unable to verify Caddy route removal');
    }
  }

  // Verify the YouEye ID client is absent rather than trusting a
  // successful delete response.
  let identityClientRemoved = true;
  if (ssoClientId) {
    try {
      const { getClient } = await import('@/lib/identity/store');
      identityClientRemoved = await getClient(ssoClientId) === null;
      if (!identityClientRemoved) warnings.push(`Identity OAuth client ${ssoClientId} still exists`);
    } catch {
      identityClientRemoved = false;
      warnings.push('Unable to verify identity OAuth client removal');
    }
  }

  let dnsRemoved = true;
  if (subdomain && domain) {
    try {
      const { getCNAMERecords, getDNSRecords } = await import('../apps/pihole-api');
      const hostname = `${subdomain}.${domain}`;
      const [cnames, records] = await Promise.all([getCNAMERecords(), getDNSRecords()]);
      dnsRemoved = !cnames.some((record) => record.domain === hostname)
        && !records.some((record) => record.domain === hostname);
      if (!dnsRemoved) warnings.push(`Pi-Hole records for ${hostname} still exist`);
    } catch {
      dnsRemoved = false;
      warnings.push('Unable to verify Pi-Hole cleanup');
    }
  }

  // `false` means database cleanup was not requested, not that cleanup failed.
  // Keep that inapplicable postcondition null so non-database apps do not
  // report a false failed uninstall after every owned resource is gone.
  let databaseDropped: boolean | null = droppedDb ? false : null;
  if (droppedDb) {
    try {
      const result = await execCommand(
        POSTGRES_CONTAINER,
        ['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname='${(databaseName || appId).replace(/'/g, "''")}'`],
        { timeout: 10_000 },
      );
      databaseDropped = result.exitCode === 0 && result.stdout.trim() !== '1';
      if (!databaseDropped) warnings.push(`Shared database for ${appId} still exists or could not be queried`);
    } catch {
      databaseDropped = false;
      warnings.push('Unable to verify shared database cleanup');
    }
  }

  let dataRemoved = keptData === false ? true : null;
  if (keptData === false) {
    try {
      dataRemoved = await verifyAppStorageRemoval(storageVolumes);
      if (!dataRemoved) warnings.push(`One or more Incus app volumes still exist for ${appId}`);
    } catch {
      dataRemoved = false;
      warnings.push(`Unable to verify Incus app storage removal for ${appId}`);
    }
  }

  // The allocator is the source of truth for network ownership. It releases a
  // lease only after Incus confirms that the managed bridge is absent.
  let networkRemoved = false;
  let leaseReleased = false;
  try {
    const lease = await getAppNetworkLease(appId);
    networkRemoved = lease === null;
    leaseReleased = lease === null;
    if (lease) {
      warnings.push(`App network ${lease.bridgeName} remains in ${lease.state} state`);
    }
  } catch {
    warnings.push('Unable to verify app network cleanup');
  }

  return {
    containerRemoved,
    networkRemoved,
    leaseReleased,
    caddyRouteRemoved,
    identityClientRemoved,
    dnsRemoved,
    databaseDropped,
    dataRemoved,
    warnings,
  };
}
