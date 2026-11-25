/**
 * App uninstaller for the Market. It decides only from the app's install.json (and acts only
 * on the exact resources recorded there): containers by exact name and only when tagged with
 * the installation id, routes by exact hostname/upstream, the app's own database and role,
 * volumes by ownership tags, the generated CA directory and the app's secrets.
 * A failed deletion keeps install.json with `cleanupPending: true`; the next uninstall retries.
 */

import { describeErrorChainForLog } from './install-tracker';
import { execCommand } from '../incus/server';
import { containerExists } from '../infrastructure/oci-deployer';
import { getRoutes, removeRoute } from '../caddy/client';
import { readInstallMetadata, saveInstallMetadata, removeInstallMetadata, removeInstallMetadataRecord } from './metadata';
import { getInstalledApp, removeInstalledApp } from './installed-apps';
import { removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import { cleanupAppByScan, isAppRegisteredWithUI, keptDataRefusal } from './reconciler';
import type { StorageVolumeMeta, UninstallVerification } from './types';
import {
  deleteAppNetwork,
  getAppNetworkLease,
  markAppNetworkCleanupPending,
  recordRemovalMode,
  removalStage,
  removeCaddyFromAppNetwork,
  removeSystemProxyDevices,
  withAppNetworkOperationLock,
  withRemovalRequest,
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
 * 0. Undo its connections while it still runs (the connect files' `remove:` steps, both ways; a failure is
 *    logged and reported in `warnings`, never blocks), then stop its containers (credential revocation comes
 *    before any deletion)
 * 1. Delete its connections (their `remove:` steps already ran), then delete its containers (exact recorded
 *    names, installation-tagged only)
 * 2. Remove Caddy routes (exact hostname / upstream)
 * 3. Clean up SSO (identity provider + application)
 * 4. Remove Pi-Hole DNS entries
 * 5. Remove the generated CA directory
 * 6. Delete data (unless keepData): the app's database and role, its volumes and its secrets
 * 7. Remove install metadata (kept with cleanupPending when anything failed)
 * 8. Post-uninstall verification
 */
/**
 * `errors`: what failed to clean up (the uninstall is not complete). `warnings`: what did not stop it, such as a
 * connection whose `remove:` steps failed. `connectionsLeft`: the apps that may still list this one (one entry per
 * app; no `appId` when the connections could not be read), shown after the uninstall (YE-199).
 */
export interface UninstallResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  connectionsLeft: { appId?: string; name?: string }[];
  verification: UninstallVerification;
}

/** A cleanup or verification step failed: the result keeps the fixed message, the journal gets the cause chain. */
function cleanupFailure(appId: string, message: string, error: unknown): string {
  console.error(`[Market] Uninstall of ${appId}: ${message}: ${describeErrorChainForLog(error)}`);
  return message;
}

export async function uninstallApp(
  appId: string,
  options: {
    keepData?: boolean;
    preserveAdmission?: boolean;
    /** Internal paired restore only; validated before any runtime deletion. */
    preserveManagedAI?: RestoredManagedAI;
  } = {}
): Promise<UninstallResult> {
  // A keep-data request records its mode before it waits for the locks: even when it is refused (the app is busy),
  // the reconcile pass must not finish an earlier attempt as delete-data. A delete-data request records its mode only
  // once admitted, under the lock (uninstallAppLocked). While the request runs or waits, the pass leaves the removal
  // to it (withRemovalRequest). YE-222.
  return withRemovalRequest(appId, async () => {
    if ((options.keepData ?? true) && !options.preserveAdmission) await recordRemovalMode(appId, true).catch(() => undefined);
    return withAppInventory(() => withAppLifecycle(appId, () =>
      withAppNetworkOperationLock(appId, 'remove', () => uninstallAppLocked(appId, options))));
  });
}

type UninstallOptions = {
  keepData?: boolean;
  preserveAdmission?: boolean;
  preserveManagedAI?: RestoredManagedAI;
};

/**
 * Once the connections' `remove:` steps ran, an uninstall that does not complete (it throws, e.g. the credential
 * revocation fails, or it returns with errors) leaves the app installed with connections recorded active whose
 * wiring was undone: mark them for re-wiring, so the app's next start wires them again (YE-209).
 */
async function uninstallAppLocked(appId: string, options: UninstallOptions): Promise<UninstallResult> {
  const progress = { unwired: false };
  let result: UninstallResult;
  try {
    result = await uninstallAppSteps(appId, options, progress);
  } catch (error) {
    if (progress.unwired) await markForRewire(appId);
    throw error;
  }
  if (progress.unwired && !result.success) await markForRewire(appId);
  return result;
}

async function markForRewire(appId: string): Promise<void> {
  try {
    const { markConnectionsForRewire } = await import('../bridges/manager');
    await markConnectionsForRewire(appId);
  } catch (error) {
    console.error(`[Market] Uninstall of ${appId}: its connections could not be marked for re-wiring: ${describeErrorChainForLog(error)}`);
  }
}

async function uninstallAppSteps(
  appId: string,
  options: UninstallOptions,
  progress: { unwired: boolean },
): Promise<UninstallResult> {
  // Revocation must be acknowledged before deleting runtime/registration.
  // Failure keeps the operation recoverable under the app lifecycle lock.
  const warnings: string[] = [];
  const connectionsLeft: UninstallResult['connectionsLeft'] = [];
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
  const keepData = options.keepData ?? true;
  // A keep request records keep again first thing once admitted: the one before the locks found nothing to record on
  // when a first attempt was still running (its lease active), and that attempt's failure wrote delete-data (YE-222,
  // Iris's batch-1 review). A delete-data request records only after the kept-data refusal below.
  if (keepData && !options.preserveAdmission) await recordRemovalMode(appId, true);
  // Delete-data removes the shared-Postgres database and role only when this installation
  // created them (a database it found, or one another installation made, is never dropped).
  const dropDb = !keepData && metadata?.databaseMode === 'shared' && metadata.sharedDatabaseCreated === true;
  if (metadata) {
    // Every check that can refuse runs before anything changes: a refused uninstall leaves the app running, enabled
    // and with a valid credential.
    // Delete-data never runs on kept data (YE-222): a keep-data removal that started (a retained policy, retained.json)
    // is finished with --keep-data. A restore replacing the app owns its data and is not refused here. First, so a
    // refused delete-data request changes nothing, not even the recorded mode.
    if (!keepData && !options.preserveAdmission) {
      const kept = await keptDataRefusal(appId);
      if (kept) throw new Error(kept.replace(/^ownership:[^:]+:/, `${appId}: `));
    }
    // This attempt's mode goes on a lease an earlier attempt left pending, before the other checks: even a request
    // refused below (a keep-data retry whose containers are gone) is the user's latest, so the reconcile pass never
    // finishes the removal in an earlier attempt's mode (YE-222, seen live). An active lease is not touched.
    if (!keepData || options.preserveAdmission) await recordRemovalMode(appId, keepData);
    const { verifyAdmissionCleanup } = await import('@/lib/admission/lifecycle');
    await verifyAdmissionCleanup(metadata, keepData, options.preserveAdmission === true);
    if (keepData && dropDb) throw new Error('Keep-data uninstall cannot drop the app database');
    // The connect files' `remove:` steps call the other app with both apps' secrets and addresses: they run now,
    // while this app still runs and before anything is deleted (both ways: this app as the consumer, and as the app
    // another one connects to). A failure never blocks the uninstall; it is logged and reported in `warnings`.
    const { unwireAppConnections } = await import('../bridges/manager');
    progress.unwired = true;
    for (const leftover of await unwireAppConnections(appId)) {
      warnings.push(leftover.message);
      if (!connectionsLeft.some((left) => left.appId === leftover.appId)) {
        connectionsLeft.push(leftover.appId ? { appId: leftover.appId, name: leftover.name } : {});
      }
    }
    metadata.serviceCredentialState = 'pending';
    metadata.enabled = false;
    metadata.desiredState = 'stopped';
    await saveInstallMetadata(metadata);
    const existing: string[] = [];
    for (const container of metadata.containers) {
      if (await containerExists(container.containerName)) existing.push(container.containerName);
    }
    if (existing.length > 0) await quiesceAppCredentialRuntime(existing, metadata.containers);
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
      warnings,
      connectionsLeft,
      verification,
    };
  }

  const errors: string[] = [];
  if (keepData) {
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
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Pointer AI connection cleanup or verification failed', error));
    }
  }

  const containers = metadata.containers;
  const containerNames = containers.map((c) => c.containerName);
  const owner = metadata.installationId ? { appId, installationId: metadata.installationId } : undefined;

  // 1. Delete the app's connections before its containers: this removes the scoped secondary NIC
  // grants, which must go before the target primary bridge can be deleted. Their `remove:` steps
  // already ran at the start, before the app was stopped, so they are not run again.
  try {
    const { getBridgesForApp, deleteBridge } = await import('../bridges/manager');
    const bridges = await getBridgesForApp(appId);
    for (const bridge of bridges) {
      await deleteBridge(bridge.id, { unwired: true });
    }
    if ((await getBridgesForApp(appId)).length > 0) throw new Error('integration records remain');
  } catch (error) {
    errors.push(cleanupFailure(appId, 'Explicit integration cleanup or verification failed', error));
  }
  try {
    const { forgetSuggestionsForApp } = await import('../bridges/suggestions');
    await forgetSuggestionsForApp(appId);
  } catch (error) {
    console.warn(`[Market] Connection suggestions for ${appId} could not be cleared: ${describeErrorChainForLog(error)}`);
  }

  // 1b. Stop and delete the recorded containers, only when tagged with this installation. deleteOwnedInstance waits
  // for each delete's real outcome (YE-222); the data below goes only once every container is confirmed gone.
  let containersGone = true;
  for (const c of containers) {
    try {
      await deleteOwnedInstance(c.containerName, owner);
    } catch (error) {
      containersGone = false;
      errors.push(cleanupFailure(appId, `Container ${c.containerName} cleanup or verification failed`, error));
    }
  }

  // 1c. Remove Control-owned proxy and Caddy attachments. Retain the bridge
  // and lease as the durable cleanup owner until every later step succeeds.
  try {
    await removeSystemProxyDevices(appId);
    await removeCaddyFromAppNetwork(appId);
  } catch (error) {
    errors.push(cleanupFailure(appId, 'App network attachment cleanup or verification failed', error));
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
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Caddy route cleanup or verification failed', error));
    }
  }

  // 3. Remove identity SSO app (OAuth2 + forward-auth proxy)
  const ssoClientId = metadata.ssoClientId || metadata.ssoSlug;
  if (ssoClientId) {
    try {
      await removeOAuthClient(ssoClientId);
      const { getClient } = await import('@/lib/identity/store');
      if (await getClient(ssoClientId)) throw new Error('identity client remains');
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Identity OAuth client cleanup or verification failed', error));
    }
  }

  if (metadata.forwardAuthEnabled && metadata.subdomain && metadata.domain) {
    try {
      await removeForwardAuth({ hostname: `${metadata.subdomain}.${metadata.domain}` });
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Identity forward-auth cleanup failed', error));
    }
  }

  // 4. Remove Pi-Hole DNS entries for app subdomain
  if (metadata.subdomain && metadata.domain) {
    try {
      await removePiholeDNSForApp(metadata.subdomain, metadata.domain);
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Pi-Hole DNS cleanup or verification failed', error));
    }
  }

  // 5. The generated CA directory holds no app data and is regenerated on install; a leftover
  // copy would block the next install's preflight.
  try {
    await removeCaddyTrustBundle(appId);
  } catch (error) {
    errors.push(cleanupFailure(appId, 'Generated CA directory cleanup failed', error));
  }

  // 5b. Drop the app's own shared database and role (delete-data only), like the volumes only once every container
  // is confirmed gone (YE-222 review).
  if (dropDb && !containersGone) {
    errors.push(cleanupFailure(appId, 'Shared database cleanup or verification failed',
      new Error('its database is kept until its containers are gone; remove it again to finish')));
  } else if (dropDb) {
    try {
      await dropSharedPostgresDatabase(
        metadata.databaseName || appId,
        metadata.databaseUser || appId,
      );
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Shared database cleanup or verification failed', error));
    }
  }

  // 6. Remove volume data and secrets if not keeping
  if (!keepData) {
    try {
      if (!containersGone) throw new Error('its data is kept until its containers are gone; remove it again to finish');
      await deleteAppStorage(metadata.storageVolumes ?? []);
      // The secrets go with the data, never before it: kept data with new secrets would not match (YE-222).
      try {
        await deleteAllAppSecrets(appId);
      } catch (error) {
        errors.push(cleanupFailure(appId, 'App secrets cleanup failed', error));
      }
    } catch (error) {
      errors.push(cleanupFailure(appId, 'App data cleanup or verification failed', error));
    }
    // Stale copies of an earlier adoption go too, before the app directory (with their record) is removed.
    try {
      const { cleanupAdoptedRetainedCopies } = await import('@/lib/admission/retained-data');
      await cleanupAdoptedRetainedCopies(appId);
    } catch (error) {
      errors.push(cleanupFailure(appId, 'Stale kept-data copy cleanup failed', error));
    }
  }

  // 7. Remove from installed_apps so cleanup_pending is never presented as a
  // successful install. Install metadata remains the exact recovery map until
  // all cleanup postconditions pass.
  try {
    await removeInstalledApp(appId);
    if (await getInstalledApp(appId)) throw new Error('installed-app record remains');
  } catch (error) {
    errors.push(cleanupFailure(appId, 'Installed-app state cleanup or verification failed', error));
  }

  // 7b. Deregister from YE-UI dashboard (remove from app drawer)
  try {
    await deregisterAppFromUI(appId, keepData || options.preserveAdmission === true);
    if (await isAppRegisteredWithUI(appId)) throw new Error('UI registration remains');
  } catch (error) {
    errors.push(cleanupFailure(appId, 'Dashboard registration cleanup or verification failed', error));
  }

  // 8. Delete and release the primary network only after every dependency is
  // absent. Any earlier failure deliberately retains cleanup_pending ownership.
  if (errors.length === 0) {
    try {
      await deleteAppNetwork(appId);
    } catch (error) {
      errors.push(cleanupFailure(appId, 'App network cleanup or verification failed', error));
      // A failed network delete leaves the lease pending under its own stage: put the requested mode back (YE-222).
      await markAppNetworkCleanupPending(appId, removalStage('uninstall', keepData), error).catch(() => undefined);
    }
  } else {
    // The requested mode goes with the lease, so the reconcile pass (or Health's Fix) finishes it as asked (YE-222).
    await markAppNetworkCleanupPending(appId, removalStage('uninstall', keepData), errors.join('; ')).catch((error) => {
      errors.push(cleanupFailure(appId, 'Failed to persist cleanup_pending lease', error));
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
      await markAppNetworkCleanupPending(appId, removalStage('uninstall-metadata', keepData), error).catch(() => undefined);
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
    warnings,
    connectionsLeft,
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
  } catch (error) {
    errors.push(cleanupFailure(appId, 'Failed to persist cleanup_pending on install metadata', error));
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
      // FORCE ends open sessions under the drop's lock; no reconnect can slip in between.
      '-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
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
    } catch (error) {
      caddyRouteRemoved = false;
      warnings.push(cleanupFailure(appId, 'Unable to verify Caddy route removal', error));
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
    } catch (error) {
      identityClientRemoved = false;
      warnings.push(cleanupFailure(appId, 'Unable to verify identity OAuth client removal', error));
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
    } catch (error) {
      dnsRemoved = false;
      warnings.push(cleanupFailure(appId, 'Unable to verify Pi-Hole cleanup', error));
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
    } catch (error) {
      databaseDropped = false;
      warnings.push(cleanupFailure(appId, 'Unable to verify shared database cleanup', error));
    }
  }

  let dataRemoved = keptData === false ? true : null;
  if (keptData === false) {
    try {
      dataRemoved = await verifyAppStorageRemoval(storageVolumes);
      if (!dataRemoved) warnings.push(`One or more Incus app volumes still exist for ${appId}`);
    } catch (error) {
      dataRemoved = false;
      warnings.push(cleanupFailure(appId, `Unable to verify Incus app storage removal for ${appId}`, error));
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
  } catch (error) {
    warnings.push(cleanupFailure(appId, 'Unable to verify app network cleanup', error));
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
