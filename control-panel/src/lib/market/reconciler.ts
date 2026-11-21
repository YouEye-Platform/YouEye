import { readFile } from 'fs/promises';
import { getAllInstalledApps, getInstalledApp, removeInstalledApp, upsertInstalledApp } from './installed-apps';
import {
  listInstalledApps,
  scanInstalledApps,
  readInstallMetadata,
  removeInstallMetadata,
  removeInstallMetadataRecord,
} from './metadata';
import { addRoute, getRoutes, removeRoute, resolveCaddyUpstreamDial } from '@/lib/caddy/client';
import { deleteOwnedInstance } from './instance-ownership';
import { removeCaddyTrustBundle } from './caddy-ca';
import { deleteAllAppSecrets } from '@/lib/infrastructure/secrets';
import { getContainerIP } from '@/lib/incus/container-ip';
import { execCommand, incusRequest } from '@/lib/incus/server';
import { stopContainerOrForce, stopTimeoutSec } from '@/lib/incus/snapshot';
import { containerRole, containerTargets, orderContainers } from '@/lib/apps/container-order';
import { observeIssue, resolveIssue, recordTimelineEvent } from '@/lib/health/issues';
import type { ContainerMeta, InstallMetadata } from './types';
import { CONTAINER_DOMAIN } from './constants';
import { readReconfigureJournal } from '@/lib/reconfigure/journal';
import { settingsService } from '@/lib/settings';
import { repairRouteForCurrentDomain } from '@/lib/reconfigure/route-repair';
import { deleteAppStorage } from './storage';
import { AppLifecycleAdmissionError, withAppInventory, withAppLifecycle } from './update-admission';
import { pushConnectionsToUI, refreshConnectionGrants } from '../bridges/manager';
import { getIdentityProviderConfig, removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import { appContainerAddress, hasActiveAppNetwork, listAppNetworks, reconcileAppNetworks } from '@/lib/incus/app-network';
import {
  describeErrorChainForLog,
  getAllActiveInstalls,
  getTrackedInstall,
  pruneCompletedInstallOperations,
  reconcileCompletedInstallOperation,
  recoverInterruptedInstalls,
} from './install-tracker';

export interface ReconcileResult {
  repaired: string[];
  unresolved: string[];
  /** Apps whose lock was held (an install, update or user operation): not checked this pass. */
  skipped?: string[];
}

const ISSUE_ID = 'market.reconcile.divergence';
const UI_CONTAINER = 'youeye-ui';
const POSTGRES_CONTAINER = 'youeye-postgres';
const SAFE_FAILURE = 'operation-or-verification-failed';

/** The public item stays a fixed code; the journal gets the cause chain. */
function failed(item: string, error: unknown): string {
  console.error(`[reconcile] ${item} failed: ${describeErrorChainForLog(error)}`);
  return `${item}:${SAFE_FAILURE}`;
}

function admissionExcluded(error: unknown): boolean {
  return error instanceof AppLifecycleAdmissionError
    || (error instanceof Error && error.message.includes('executor lock is busy'));
}

export async function reconcileApps(): Promise<ReconcileResult> {
  const repaired: string[] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];

  // URL migration owns app metadata and routes until its restart recovers.
  // A background repair must not recreate an old hostname from a stale snapshot.
  if (await readReconfigureJournal()) return { repaired, unresolved };

  try {
    const recovered = recoverInterruptedInstalls();
    repaired.push(...recovered.map((appId) => `interrupted-operation:${appId}`));
    pruneCompletedInstallOperations();
    await resolveIssue('market.install-operation.state');
  } catch (error) {
    const message = failed('install-operation-state', error);
    unresolved.push(message);
    await observeIssue({
      id: 'market.install-operation.state',
      severity: 'critical',
      source: 'reconcile',
      title: 'Install recovery state requires attention',
      body: 'Durable install operation state could not be verified. Recovery and new app installs remain blocked.',
      fixable: true,
      repairFn: 'reconcile-apps',
      learnMore: '/settings/system/health',
      debounce: 1,
    });
    return { repaired, unresolved };
  }

  const networkResult = await reconcileAppNetworks();
  repaired.push(...networkResult.repaired);
  unresolved.push(...networkResult.unresolved);

  let appNetworks: Awaited<ReturnType<typeof listAppNetworks>>;
  try {
    appNetworks = networkResult.observedNetworks ?? await listAppNetworks();
  } catch (error) {
    unresolved.push(failed(`app-network-list`, error));
    return { repaired, unresolved };
  }
  const activeNetworkIds = new Set(
    appNetworks.filter((network) => network.state === 'active').map((network) => network.appId),
  );
  const networkProblemIds = new Set<string>();
  for (const problem of networkResult.unresolved) {
    const match = problem.match(/^app-network(?:-stop)?:([^:]+):/);
    if (match) networkProblemIds.add(match[1]);
  }

  const [{ apps: metadata, damaged }, installedApps, instances] = await Promise.all([
    scanInstalledApps(),
    getAllInstalledApps(),
    listInstances(),
  ]);
  // A damaged record's app is left alone: its containers, routes and registration stay (route removal re-reads every
  // record under the inventory lock and refuses while one is damaged).
  for (const appId of damaged) unresolved.push(`install-record:${appId}`);
  const damagedIds = new Set(damaged);

  const metadataById = new Map(metadata.map((m) => [m.appId, m]));
  const reconcilableMetadataById = new Map(
    metadata
      .filter((item) => activeNetworkIds.has(item.appId) && !networkProblemIds.has(item.appId))
      .map((item) => [item.appId, item]),
  );
  const installedById = new Map(installedApps.map((app) => [app.appId, app]));
  const appInstanceNames = new Set(instances.filter((name) => name.startsWith('app-') || name.startsWith('ye-app-')));
  // A pass-local read hint only. Missing registrations are checked again under
  // admission before creating anything; failed batch reads retain the existing
  // per-app verification path. Never carry this snapshot across passes.
  const uiRegistrations = metadata.length > 0 ? await listUIRegistrations().catch(() => null) : new Map<string, unknown>();

  for (let meta of metadata) {
    let containers = normalizeContainers(meta.containers, meta.appId);
    for (const name of containers) appInstanceNames.delete(name);

    // Existing visibility needs no mutation admission when the full network
    // audit and fresh persisted UI projection both match. This path cannot
    // register, publish or complete an operation. Any uncertainty falls back to
    // the existing fresh under-lock visibility and repair checks below.
    if (networkResult.observedNetworks && activeNetworkIds.has(meta.appId)
      && !networkProblemIds.has(meta.appId) && installedById.has(meta.appId)
      && meta.lifecycleState === 'active' && uiRegistrations?.has(meta.appId)) {
      try {
        const operation = getTrackedInstall(meta.appId);
        if (operation && (!operation.done || operation.error)) throw new Error('Install operation needs admission');
        await pushConnectionsToUI(meta.appId, {
          required: true, observed: uiRegistrations.get(meta.appId), auditOnly: true,
        });
        continue;
      } catch {
        // No write is possible in the projection audit. Repair reads current
        // metadata/network state after acquiring lifecycle admission.
      }
    }

    try {
      await withAppLifecycle(meta.appId, async () => {
        const current = await readInstallMetadata(meta.appId);
        if (!current) return;
        meta = current;
        containers = normalizeContainers(meta.containers, meta.appId);
        const networkActive = await hasActiveAppNetwork(meta.appId);
        if (meta.lifecycleState === 'installing' && getAllActiveInstalls().some(operation => operation.appId === meta.appId)) {
          // The durable operation record and provisional metadata agree that this
          // installer is still live in this process. Network reconciliation applies
          // the same ownership test before touching its reserved lease.
          return;
        }

        if (!networkActive) {
          // A fresh install that died before finishing (no live installer, checked above) holds no user data: clean it
          // up completely (containers, routes, DNS, network, record), with backoff when cleanup itself fails.
          const { isUnfinishedFreshInstall } = await import('@/lib/admission/lifecycle');
          if (isUnfinishedFreshInstall(meta) && unfinishedCleanupDue(meta.appId)) {
            try {
              const cleaned = await cleanupAppByScan(meta.appId, { keepData: false });
              repaired.push(...cleaned.repaired.map((item) => `failed-install-cleanup:${item}`));
              unresolved.push(...cleaned.unresolved.map((item) => `failed-install-cleanup:${item}`));
              unfinishedCleanupResult(meta.appId, cleaned.unresolved.length === 0);
              if (cleaned.unresolved.length === 0) {
                for (const id of [`market.install.rollback.${meta.appId}`, `market.app-network.${meta.appId}`]) {
                  await resolveIssue(id).catch(() => undefined);
                }
              }
            } catch (error) {
              unfinishedCleanupResult(meta.appId, false);
              console.error(`[reconcile] Cleanup of the failed install of ${meta.appId}: ${describeErrorChainForLog(error)}`);
              unresolved.push(`failed-install-cleanup:${meta.appId}:${SAFE_FAILURE}`);
            }
            return;
          }
          unresolved.push(`metadata-without-active-network:${meta.appId}`);
          // The app's clients first, its database last; each with its role's timeout.
          const stopOrder = orderContainers(containerTargets(meta.containers), 'stop').map(target => target.name);
          for (const name of [...stopOrder.filter(name => containers.includes(name)),
            ...containers.filter(name => !stopOrder.includes(name))]) {
            if (!instances.includes(name)) continue;
            try {
              // Stopping a stopped container is not a repair.
              if (await instanceRunning(name)) {
                await stopInstance(name, containerRole(meta.containers, name));
                repaired.push(`stopped-unowned-app:${name}`);
              }
            } catch (error) {
              unresolved.push(failed(`stop-unowned-app:${name}`, error));
            }
          }
          if (installedById.has(meta.appId)) {
            try {
              await removeInstalledApp(meta.appId);
              repaired.push(`hidden-incomplete-app:${meta.appId}`);
            } catch (error) {
              unresolved.push(failed(`hidden-incomplete-app:${meta.appId}`, error));
            }
          }
          return;
        }

        if (networkProblemIds.has(meta.appId)) {
          unresolved.push(`app-reconcile-blocked-by-network:${meta.appId}`);
          return;
        }

        if (meta.lifecycleState === 'active' && reconcileCompletedInstallOperation(meta.appId)) {
          repaired.push(`completed-operation:${meta.appId}`);
        }

        const existing = installedById.get(meta.appId);
        if (!existing) {
          try {
            await upsertInstalledApp({
              appId: meta.appId,
              type: meta.integration || 'market',
              installedVersion: meta.installedVersion ?? '',
              catalogVersion: meta.catalogVersion ?? null,
              subdomain: meta.subdomain,
              ssoSlug: meta.ssoSlug,
              forwardAuthEnabled: meta.forwardAuthEnabled,
              catalogKey: meta.catalogKey,
              sourceId: meta.sourceId,
              sourceName: meta.sourceName,
              sourceRepoUrl: meta.sourceRepoUrl,
            });
            repaired.push(`installed-apps:${meta.appId}`);
          } catch (error) {
            unresolved.push(failed(`installed-apps:${meta.appId}`, error));
          }
        }

        try {
          const repairedUi = await reconcileUIRegistration(meta, uiRegistrations);
          if (repairedUi) repaired.push(`ui-drawer:${meta.appId}`);
        } catch (error) {
          unresolved.push(failed(`ui-drawer:${meta.appId}`, error));
        }
      });
    } catch (error) {
      if (admissionExcluded(error)) { skipped.push(meta.appId); continue; }
      unresolved.push(failed(`app-admission:${meta.appId}`, error));
    }
  }

  for (const app of installedApps) {
    if (!metadataById.has(app.appId) && !damagedIds.has(app.appId)) {
      const hasLive = appInstanceNames.has(`app-${app.appId}`) || appInstanceNames.has(`ye-app-${app.appId}`);
      if (!hasLive) {
        try {
          await withAppLifecycle(app.appId, async () => {
            if (await readInstallMetadata(app.appId)) return;
            const live = await listInstances();
            if (live.some(name => name === `app-${app.appId}` || name === `ye-app-${app.appId}`)) return;
            await removeInstalledApp(app.appId);
            repaired.push(`stale-installed-app:${app.appId}`);
          });
        } catch (error) {
          if (admissionExcluded(error)) { skipped.push(app.appId); continue; }
          unresolved.push(failed(`stale-installed-app:${app.appId}`, error));
        }
      }
    }
  }

  // Exact names only: an `app-*` instance no install record names is reported, never
  // attributed to an app by parsing its name (`app-foo-bar` is not `foo`'s).
  for (const name of Array.from(appInstanceNames)) {
    unresolved.push(`orphan-container:${name}`);
  }

  await reconcileRoutes(reconcilableMetadataById, repaired, unresolved);

  // A recreated or restored peer has a new address: point connection ACLs at the current ones.
  for (const bridgeId of await refreshConnectionGrants()) unresolved.push(`connection-grant:${bridgeId}`);

  if (unresolved.length > 0) {
    await observeIssue({
      id: ISSUE_ID,
      severity: 'error',
      source: 'reconcile',
      title: 'App state is out of sync',
      body: `Reconcile repaired ${repaired.length} item(s) and still has ${unresolved.length} unresolved divergence(s): ${unresolved.slice(0, 5).join(', ')}`,
      fixable: true,
      repairFn: 'reconcile-apps',
      learnMore: '/settings/system/health',
      debounce: 1,
    });
  } else if (skipped.length > 0) {
    // A busy app was not checked: an open divergence stays open until a pass covers every app.
    console.log(`[reconcile] skipped busy apps: ${skipped.join(', ')}`);
  } else {
    await resolveIssue(ISSUE_ID);
    if (repaired.length > 0) {
      await recordTimelineEvent({
        id: `market.reconcile.self-healed.${Date.now()}`,
        source: 'reconcile',
        title: 'App state self-healed',
        body: `Reconcile repaired ${repaired.length} divergence(s): ${repaired.slice(0, 6).join(', ')}`,
      });
    }
  }

  return { repaired, unresolved, skipped };
}

/**
 * Stop a container of an app whose network is gone. It is kept (with its data), not deleted: a clean stop with its
 * role's timeout, forced (and logged) only after that.
 */
async function stopInstance(name: string, role?: string): Promise<void> {
  const before = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (before.type === 'error' && (before.error_code === 404 || before.status_code === 404)) return;
  if (before.type === 'error') throw new Error(before.error || before.status);
  if (before.metadata?.status === 'Stopped') return;
  await stopContainerOrForce(name, { timeoutSec: stopTimeoutSec(role) });
  const after = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (after.type === 'error' || after.metadata?.status !== 'Stopped') {
    throw new Error(`Container ${name} did not read back as Stopped`);
  }
}

/** Cleanup of failed installs retries with backoff (1, 5, 15 min, then hourly), not on every 30 s pass. */
const failedInstallCleanup = globalThis as typeof globalThis & {
  __youeyeFailedInstallCleanup?: Map<string, { failures: number; nextAt: number }>;
};
function unfinishedCleanupState() {
  failedInstallCleanup.__youeyeFailedInstallCleanup ??= new Map();
  return failedInstallCleanup.__youeyeFailedInstallCleanup;
}
function unfinishedCleanupDue(appId: string): boolean {
  return (unfinishedCleanupState().get(appId)?.nextAt ?? 0) <= Date.now();
}
function unfinishedCleanupResult(appId: string, ok: boolean): void {
  const state = unfinishedCleanupState();
  if (ok) { state.delete(appId); return; }
  const failures = (state.get(appId)?.failures ?? 0) + 1;
  const minutes = [1, 5, 15][failures - 1] ?? 60;
  state.set(appId, { failures, nextAt: Date.now() + minutes * 60_000 });
}
async function instanceRunning(name: string): Promise<boolean> {
  const state = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
  return state.type !== 'error' && state.metadata?.status === 'Running';
}

/**
 * Clean up an app from its install.json alone: the exact recorded instances (only when tagged
 * with its installation id), routes by exact hostname or recorded upstream, and — with
 * delete-data — its database and role, volumes, secrets and generated CA directory.
 * No name-prefix matching: cleaning up `foo` never touches `foo-bar`.
 */
export async function cleanupAppByScan(
  appId: string,
  /** force: skip the data-ownership check (youeye app remove --force); resources are still matched by this app's id
   * and recorded installation id, and volumes by their ownership tags. */
  options: { keepData?: boolean; force?: boolean } = {},
): Promise<ReconcileResult> {
  return withAppLifecycle(appId, () => cleanupAppByScanUnderLifecycle(appId, options));
}

async function cleanupAppByScanUnderLifecycle(
  appId: string,
  options: { keepData?: boolean; force?: boolean },
): Promise<ReconcileResult> {
  if (!/^[a-z0-9-]+$/.test(appId)) {
    throw new Error(`Invalid app ID for cleanup: ${appId}`);
  }
  const repaired: string[] = [];
  const unresolved: string[] = [];
  const recoveryMetadata = await readInstallMetadata(appId);
  if (!recoveryMetadata) {
    return { repaired: [], unresolved: [`ownership:${appId}:install metadata is required before cleanup`] };
  }
  const { verifyAdmissionCleanup } = await import('@/lib/admission/lifecycle');
  if (options.force) {
    try {
      await verifyAdmissionCleanup(recoveryMetadata, options.keepData !== false);
    } catch (error) {
      console.warn(`[cleanup] Forced removal of ${appId} without the data-ownership check: ${describeErrorChainForLog(error)}`);
    }
  } else {
    await verifyAdmissionCleanup(recoveryMetadata, options.keepData !== false);
  }
  const interruptedInstall = recoveryMetadata?.lifecycleState === 'installing';
  const instances = await listInstances();
  const owner = recoveryMetadata.installationId
    ? { appId, installationId: recoveryMetadata.installationId }
    : undefined;
  const matchingInstances = [...new Set((recoveryMetadata.containers ?? [])
    .map((container) => container.containerName)
    .filter((name): name is string => Boolean(name) && instances.includes(name)))];
  const matchingIPs = new Set<string>();
  for (const name of matchingInstances) {
    const ip = await getContainerIP(name);
    if (ip) matchingIPs.add(ip);
  }
  const hostname = recoveryMetadata.subdomain && recoveryMetadata.domain
    ? `${recoveryMetadata.subdomain}.${recoveryMetadata.domain}` : null;

  for (const name of matchingInstances) {
    try {
      await deleteOwnedInstance(name, owner);
      repaired.push(`instance:${name}`);
    } catch (error) {
      unresolved.push(failed(`instance:${name}`, error));
    }
  }

  // Routes no longer have a workload target after the instances are gone.
  try {
    const routes = await getRoutes();
    for (const route of routes) {
      if ((hostname && route.hostname === hostname)
        || matchingInstances.includes(route.upstream)
        || matchingIPs.has(route.upstream)) {
        await removeRoute(route.id);
      }
    }
    repaired.push(`routes:${appId}`);
  } catch (error) {
    unresolved.push(failed(`routes:${appId}`, error));
  }

  // Revoke every cross-app grant before attempting to remove the target's
  // primary bridge. A failed revocation retains its bridge record for retry.
  try {
    const { getBridgesForApp, deleteBridge } = await import('../bridges/manager');
    const bridges = await getBridgesForApp(appId);
    for (const bridge of bridges) {
      await deleteBridge(bridge.id);
    }
    if ((await getBridgesForApp(appId)).length > 0) throw new Error('integration records remain');
    repaired.push(`bridges:${appId}`);
  } catch (error) {
    unresolved.push(failed(`bridges:${appId}`, error));
  }

  // Remove the Control-owned holders on the primary bridge. The IPAM lease is
  // deliberately retained until every cleanup step below succeeds.
  try {
    const { removeSystemProxyDevices, removeCaddyFromAppNetwork } = await import('@/lib/incus/app-network');
    await removeSystemProxyDevices(appId);
    await removeCaddyFromAppNetwork(appId);
    repaired.push(`network-attachments:${appId}`);
  } catch (error) {
    unresolved.push(failed(`network-attachments:${appId}`, error));
  }

  if (interruptedInstall && (recoveryMetadata.ssoClientId || recoveryMetadata.ssoSlug)) {
    try {
      const clientId = recoveryMetadata.ssoClientId || recoveryMetadata.ssoSlug!;
      await removeOAuthClient(clientId);
      const { getClient } = await import('@/lib/identity/store');
      if (await getClient(clientId)) throw new Error('identity client remains');
      repaired.push(`identity-client:${appId}`);
    } catch (error) {
      unresolved.push(failed(`identity-client:${appId}`, error));
    }
  }

  if (interruptedInstall && recoveryMetadata.forwardAuthEnabled) {
    try {
      await removeForwardAuth({ hostname: `${recoveryMetadata.subdomain}.${recoveryMetadata.domain}` });
      repaired.push(`forward-auth:${appId}`);
    } catch (error) {
      unresolved.push(failed(`forward-auth:${appId}`, error));
    }
  }

  if (interruptedInstall) {
    try {
      const { getCNAMERecords, getDNSRecords, removeCNAMERecord, removeDNSRecord } = await import('../apps/pihole-api');
      const hostname = `${recoveryMetadata.subdomain}.${recoveryMetadata.domain}`;
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
      repaired.push(`dns:${appId}`);
    } catch (error) {
      unresolved.push(failed(`dns:${appId}`, error));
    }
  }

  // The shared database and role this installation created go with delete-data (and with an
  // interrupted install); one the record does not mark as created here is never dropped.
  const shouldDropDatabase = recoveryMetadata.databaseMode === 'shared' && recoveryMetadata.sharedDatabaseCreated === true
    && (options.keepData === false || (interruptedInstall && !recoveryMetadata.recoveryPreserveData));
  if (shouldDropDatabase && !recoveryMetadata) {
    unresolved.push(`database-ownership:${appId}:install metadata is required for destructive database cleanup`);
  } else if (shouldDropDatabase) {
    try {
      await dropAppDatabase(
        recoveryMetadata!.databaseName || appId,
        recoveryMetadata!.databaseUser || appId,
      );
      repaired.push(`database:${appId}`);
    } catch (error) {
      unresolved.push(failed(`database:${appId}`, error));
    }
  }

  if (options.keepData === false || (interruptedInstall && !recoveryMetadata.recoveryPreserveData)) {
    try {
      // Never a shared folder: a failed install never bound its ownership (that happens at finalize), and other apps
      // may use it. The normal uninstaller decides shared folders; cleanup by scan leaves them.
      const own = (recoveryMetadata?.storageVolumes ?? []).filter(volume => !volume.sharedGroup);
      if (own.length) await deleteAppStorage(own);
      repaired.push(`storage:${appId}`);
    } catch (error) {
      unresolved.push(failed(`storage:${appId}`, error));
    }
    try {
      await deleteAllAppSecrets(appId);
      repaired.push(`secrets:${appId}`);
    } catch (error) {
      unresolved.push(failed(`secrets:${appId}`, error));
    }
  }

  try {
    await removeCaddyTrustBundle(appId);
    repaired.push(`ca:${appId}`);
  } catch (error) {
    unresolved.push(failed(`ca:${appId}`, error));
  }

  try {
    await removeInstalledApp(appId);
    repaired.push(`installed-apps:${appId}`);
  } catch (error) {
    unresolved.push(failed(`installed-apps:${appId}`, error));
  }

  try {
    await deregisterAppFromUI(appId);
    repaired.push(`ui-drawer:${appId}`);
  } catch (error) {
    unresolved.push(failed(`ui-drawer:${appId}`, error));
  }

  // Prove every dependent resource absent before the network lease can be
  // released. Post-release discovery is too late because metadata is the only
  // exact recovery map for interrupted installs.
  const dependenciesAfterCleanup = await listInstances();
  for (const name of matchingInstances) {
    if (dependenciesAfterCleanup.includes(name)) unresolved.push(`verify-instance:${name}`);
  }
  const routesAfterCleanup = await getRoutes();
  if (routesAfterCleanup.some((route) => (hostname && route.hostname === hostname)
    || matchingInstances.includes(route.upstream)
    || matchingIPs.has(route.upstream))) {
    unresolved.push(`verify-routes:${appId}`);
  }
  if (await getInstalledApp(appId)) unresolved.push(`verify-installed-apps:${appId}`);
  try {
    if (await isAppRegisteredWithUI(appId)) unresolved.push(`verify-ui-drawer:${appId}`);
  } catch (error) {
    unresolved.push(failed(`verify-ui-drawer:${appId}`, error));
  }

  const { deleteAppNetwork, getAppNetworkLease, markAppNetworkCleanupPending } = await import('@/lib/incus/app-network');
  if (unresolved.length === 0) {
    try {
      await deleteAppNetwork(appId);
      repaired.push(`network:${appId}`);
    } catch (error) {
      unresolved.push(failed(`network:${appId}`, error));
    }
  } else {
    try {
      await markAppNetworkCleanupPending(appId, 'scan-cleanup', unresolved.join('; '));
    } catch (error) {
      unresolved.push(failed(`network-state:${appId}`, error));
    }
  }

  const remainingInstances = await listInstances();
  for (const name of matchingInstances) {
    if (remainingInstances.includes(name)) unresolved.push(`verify-instance:${name}`);
  }
  const remainingRoutes = await getRoutes();
  if (remainingRoutes.some((route) => (hostname && route.hostname === hostname)
    || matchingInstances.includes(route.upstream)
    || matchingIPs.has(route.upstream))) {
    unresolved.push(`verify-routes:${appId}`);
  }
  if (await getInstalledApp(appId)) unresolved.push(`verify-installed-apps:${appId}`);
  try {
    if (await isAppRegisteredWithUI(appId)) unresolved.push(`verify-ui-drawer:${appId}`);
  } catch (error) {
    unresolved.push(failed(`verify-ui-drawer:${appId}`, error));
  }

  let leasePresent = true;
  try {
    const lease = await getAppNetworkLease(appId);
    leasePresent = lease !== null;
    if (lease) unresolved.push(`verify-network:${appId}:${lease.bridgeName}:${lease.state}`);
  } catch (error) {
    unresolved.push(failed(`verify-network:${appId}`, error));
  }

  // Install metadata is the final recovery map. Remove it only after all
  // resources are verified absent and the lease is safely released.
  if (unresolved.length === 0 && !leasePresent) {
    try {
      // A fresh install that never finished holds no user data: its record and directory go whoever asked
      // (the network reconcile cleans with keep-data by default).
      const freshFailedInstall = interruptedInstall && !recoveryMetadata.recoveryPreserveData;
      const preserveData = !freshFailedInstall && (options.keepData !== false
        || (interruptedInstall && recoveryMetadata.recoveryPreserveData));
      if (preserveData) await removeInstallMetadataRecord(appId);
      else await removeInstallMetadata(appId);
      repaired.push(`metadata:${appId}`);
    } catch (error) {
      unresolved.push(failed(`metadata:${appId}`, error));
    }
  }
  if (unresolved.length === 0 && await readInstallMetadata(appId)) {
    unresolved.push(`verify-metadata:${appId}`);
  }

  return { repaired, unresolved };
}

async function reconcileRoutes(
  metadataById: Map<string, Awaited<ReturnType<typeof readInstallMetadata>> & { appId: string }>,
  repaired: string[],
  unresolved: string[],
): Promise<void> {
  let routes: Awaited<ReturnType<typeof getRoutes>>;
  try {
    routes = await getRoutes();
  } catch (error) {
    unresolved.push(failed(`routes:list`, error));
    return;
  }

  // A route whose upstream is an `app-*` container no install record names is stale. Only that
  // exact route is removed; the app is never inferred from a name prefix.
  const recordedNames = (records: Iterable<InstallMetadata>) => new Set([...records].flatMap((record) =>
    normalizeContainers(record.containers, record.appId)));
  const recorded = recordedNames(metadataById.values());
  for (const route of routes) {
    const upstream = String((route as { upstream?: string }).upstream ?? '');
    const containerName = upstream.split('.')[0];
    if (!/^(app|ye-app)-[a-z0-9-]+$/.test(containerName) || recorded.has(containerName)) continue;
    try {
      await withAppInventory(async () => {
        if (recordedNames(await listInstalledApps()).has(containerName)) return;
        await removeRoute(route.id);
        repaired.push(`stale-route:${route.id}`);
      });
    } catch (error) {
      if (admissionExcluded(error)) continue;
      unresolved.push(failed(`stale-route:${route.id}`, error));
    }
  }

  for (let meta of metadataById.values()) {
    if (routesPresent(meta, routes)) continue;
    try {
      await withAppLifecycle(meta.appId, async () => {
        const current = await readInstallMetadata(meta.appId);
        if (!current) return;
        meta = current;
        // Recheck at the write boundary: migration may start after enumeration.
        if (!await repairRouteForCurrentDomain(meta.domain, {
          pending: readReconfigureJournal,
          domain: async () => (await settingsService.getRaw()).domain,
          repair: () => recreateRoutes(meta),
        })) return;
        const verifiedRoutes = await getRoutes();
        if (!routesPresent(meta, verifiedRoutes)) {
          throw new Error('Caddy route did not persist after reconcile');
        }
        repaired.push(`caddy-route:${meta.appId}`);
      });
    } catch (error) {
      if (admissionExcluded(error)) continue;
      unresolved.push(failed(`caddy-route:${meta.appId}`, error));
    }
  }
}

function routesPresent(meta: InstallMetadata, routes: Awaited<ReturnType<typeof getRoutes>>): boolean {
  const hostname = `${meta.subdomain}.${meta.domain}`;
  return routes.some((route) => route.hostname === hostname);
}

async function recreateRoutes(meta: InstallMetadata): Promise<void> {
  if (!meta.subdomain || !meta.domain) throw new Error('install metadata lacks subdomain or domain');
  const primary = pickPrimaryContainer(meta.containers, meta.appId);
  const hostname = `${meta.subdomain}.${meta.domain}`;
  const { bindInstalledAdmission, admissionForwardAuth } = await import('@/lib/admission/lifecycle');
  await bindInstalledAdmission(meta);
  const forwardAuth = await admissionForwardAuth();

  let upstream = primary.containerName;
  if (meta.usePerAppBridge) {
    upstream = await appContainerAddress(primary.containerName, meta.appId);
  }
  await addRoute({ hostname, path: '/*', upstream, port: primary.port || 3000, forwardAuth, appId: meta.appId });
}

async function forwardAuthConfig(): Promise<{ upstreamDial: string; uri: string; copyHeaders: string[] }> {
  const identity = await getIdentityProviderConfig();
  return {
    upstreamDial: await resolveCaddyUpstreamDial(identity.containerName, identity.port),
    uri: '/forward-auth/caddy',
    copyHeaders: ['X-YouEye-Username', 'X-YouEye-Groups', 'X-YouEye-Email', 'X-YouEye-Name', 'X-YouEye-Uid'],
  };
}

async function listInstances(): Promise<string[]> {
  const resp = await incusRequest<Array<{ name?: unknown }>>('GET', '/1.0/instances?recursion=1');
  return (resp.metadata ?? []).map((instance) => String(instance.name ?? '')).filter(Boolean);
}

function normalizeContainers(containers: ContainerMeta[] | undefined, appId: string): string[] {
  if (!containers || containers.length === 0) return [`app-${appId}`];
  return containers
    .map((c) => c?.containerName || c?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

async function reconcileUIRegistration(meta: InstallMetadata, observed: ReadonlyMap<string, unknown> | null): Promise<boolean> {
  const alreadyRegistered = observed?.has(meta.appId) || await isAppRegisteredWithUI(meta.appId);
  if (alreadyRegistered) {
    // Refresh current gateway addressing/trust after CP/UI updates or recovery.
    // Existing registration does not prove that its connection projection is current.
    await pushConnectionsToUI(meta.appId, { required: true, observed: observed?.get(meta.appId) });
    return false;
  }

  await registerAppWithUI(meta);
  await pushConnectionsToUI(meta.appId, { required: true });

  const verified = await isAppRegisteredWithUI(meta.appId);
  if (!verified) {
    throw new Error('UI registration did not persist after reconcile');
  }
  return true;
}

async function listUIRegistrations(): Promise<Map<string, unknown>> {
  const result = await execCommand(
    POSTGRES_CONTAINER,
    ['/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'youeye_ui', '-tAc',
      "SELECT COALESCE(json_agg(json_build_object('id', id, 'connections', connections)), '[]'::json)::text FROM apps"],
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) throw new Error('Failed to list YE-UI registrations');
  const rows: unknown = JSON.parse(result.stdout.trim());
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string')) throw new Error('Invalid YE-UI registration inventory');
  return new Map(rows.map(row => [row.id, row.connections]));
}

export async function isAppRegisteredWithUI(appId: string): Promise<boolean> {
  const escapedAppId = escapeSqlLiteral(appId);
  const result = await execCommand(
    POSTGRES_CONTAINER,
    ['/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'youeye_ui', '-tAc', `SELECT 1 FROM apps WHERE id = '${escapedAppId}' LIMIT 1`],
    { timeout: 10_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error('Failed to query YE-UI registration state');
  }

  return result.stdout.trim() === '1';
}

async function registerAppWithUI(meta: InstallMetadata): Promise<void> {
  const primary = pickPrimaryContainer(meta.containers, meta.appId);
  const uiIP = await getContainerIP(UI_CONTAINER);
  if (!uiIP) {
    throw new Error('YE-UI container IP is unavailable');
  }

  const bridgeToken = await readBridgeToken();
  const port = primary.port || 3000;
  const containerUrl = port
    ? `http://${primary.containerName}.${CONTAINER_DOMAIN}:${port}`
    : `http://${primary.containerName}.${CONTAINER_DOMAIN}`;

  const response = await fetch(`http://${uiIP}:3000/api/v1/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-UI-Bridge-Token': bridgeToken,
    },
    body: JSON.stringify({
      id: meta.appId,
      name: meta.appId,
      container_url: containerUrl,
      subdomain: meta.subdomain,
      sso_entry_url: meta.ssoEntryUrl,
      manifest: { integration: meta.integration },
    }),
  });

  if (!response.ok) {
    throw new Error(`YE-UI register failed with HTTP ${response.status}`);
  }
}

async function deregisterAppFromUI(appId: string): Promise<void> {
  const uiIP = await getContainerIP(UI_CONTAINER);
  if (!uiIP) {
    throw new Error('YE-UI container IP is unavailable');
  }

  const bridgeToken = await readBridgeToken();
  const response = await fetch(`http://${uiIP}:3000/api/v1/apps/${appId}/unregister`, {
    method: 'DELETE',
    headers: { 'X-UI-Bridge-Token': bridgeToken },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`YE-UI unregister failed with HTTP ${response.status}`);
  }
}

function pickPrimaryContainer(containers: ContainerMeta[] | undefined, appId: string): ContainerMeta {
  if (!containers || containers.length === 0) {
    return {
      name: `app-${appId}`,
      containerName: `app-${appId}`,
      type: 'oci',
      primary: true,
      port: 3000,
    };
  }

  return containers.find((container) => container.primary)
    ?? containers.find((container) => container.role === 'app')
    ?? containers[0];
}

async function readBridgeToken(): Promise<string> {
  for (const candidate of ['/etc/youeye/ui-bridge-token', '/var/lib/youeye/control/.bridge_token']) {
    try {
      const token = await readFile(candidate, 'utf-8');
      const trimmed = token.trim();
      if (trimmed.length > 0) return trimmed;
    } catch {
      // try next location
    }
  }

  const envToken = process.env.UI_BRIDGE_TOKEN?.trim();
  if (envToken) return envToken;
  throw new Error('UI bridge token is unavailable; refusing an unauthenticated UI request');
}

async function dropAppDatabase(databaseName: string, databaseUser: string): Promise<void> {
  const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
  if (!identifierPattern.test(databaseName) || !identifierPattern.test(databaseUser)) {
    throw new Error('Invalid shared database recovery identifiers');
  }
  const database = `"${databaseName}"`;
  const role = `"${databaseUser}"`;
  // FORCE ends open sessions under the drop's lock; no reconnect can slip in between.
  const drop = await execCommand(
    POSTGRES_CONTAINER,
    ['/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, '-c', `DROP ROLE IF EXISTS ${role}`],
    { timeout: 15_000 },
  );
  if (drop.exitCode !== 0) throw new Error('could not drop app database and role');
  const verify = await execCommand(
    POSTGRES_CONTAINER,
    [
      '/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-tAc',
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='${escapeSqlLiteral(databaseName)}') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${escapeSqlLiteral(databaseUser)}') THEN 1 ELSE 0 END`,
    ],
    { timeout: 10_000 },
  );
  if (verify.exitCode !== 0 || verify.stdout.trim() === '1') {
    throw new Error('shared database recovery resources remain after cleanup');
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
