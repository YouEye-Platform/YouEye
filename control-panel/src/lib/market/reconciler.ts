import { readFile } from 'fs/promises';
import { getAllInstalledApps, getInstalledApp, removeInstalledApp, upsertInstalledApp } from './installed-apps';
import {
  listInstalledApps,
  readInstallMetadata,
  removeInstallMetadata,
  removeInstallMetadataRecord,
} from './metadata';
import { addAppRoutes, addRoute, getRoutes, removeAppRoutes, removeRoute, resolveCaddyUpstreamDial, type EntranceConfig } from '@/lib/caddy/client';
import { getContainerIP } from '@/lib/incus/container-ip';
import { execCommand, incusRequest } from '@/lib/incus/server';
import { observeIssue, resolveIssue, recordTimelineEvent } from '@/lib/health/issues';
import type { ContainerMeta, InstallMetadata } from './types';
import { CONTAINER_DOMAIN } from './constants';
import { deleteAppStorage } from './storage';
import { pushConnectionsToUI } from '../bridges/manager';
import { getIdentityProviderConfig, removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import { listAppNetworks, reconcileAppNetworks } from '@/lib/incus/app-network';
import {
  getAllActiveInstalls,
  pruneCompletedInstallOperations,
  reconcileCompletedInstallOperation,
  recoverInterruptedInstalls,
} from './install-tracker';

export interface ReconcileResult {
  repaired: string[];
  unresolved: string[];
}

const ISSUE_ID = 'market.reconcile.divergence';
const UI_CONTAINER = 'youeye-ui';
const POSTGRES_CONTAINER = 'youeye-postgres';
const SAFE_FAILURE = 'operation-or-verification-failed';

export async function reconcileApps(): Promise<ReconcileResult> {
  const repaired: string[] = [];
  const unresolved: string[] = [];

  try {
    const recovered = recoverInterruptedInstalls();
    repaired.push(...recovered.map((appId) => `interrupted-operation:${appId}`));
    pruneCompletedInstallOperations();
    await resolveIssue('market.install-operation.state');
  } catch {
    const message = `install-operation-state:${SAFE_FAILURE}`;
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
    appNetworks = await listAppNetworks();
  } catch {
    unresolved.push(`app-network-list:${SAFE_FAILURE}`);
    return { repaired, unresolved };
  }
  const activeNetworkIds = new Set(
    appNetworks.filter((network) => network.state === 'active').map((network) => network.appId),
  );
  const activeInstallIds = new Set(getAllActiveInstalls().map((operation) => operation.appId));
  const networkProblemIds = new Set<string>();
  for (const problem of networkResult.unresolved) {
    const match = problem.match(/^app-network(?:-stop)?:([^:]+):/);
    if (match) networkProblemIds.add(match[1]);
  }

  const [metadata, installedApps, instances] = await Promise.all([
    listInstalledApps(),
    getAllInstalledApps(),
    listInstances(),
  ]);

  const metadataById = new Map(metadata.map((m) => [m.appId, m]));
  const reconcilableMetadataById = new Map(
    metadata
      .filter((item) => activeNetworkIds.has(item.appId) && !networkProblemIds.has(item.appId))
      .map((item) => [item.appId, item]),
  );
  const installedById = new Map(installedApps.map((app) => [app.appId, app]));
  const appInstanceNames = new Set(instances.filter((name) => name.startsWith('app-') || name.startsWith('ye-app-')));

  for (const meta of metadata) {
    const containers = normalizeContainers(meta.containers, meta.appId);
    for (const name of containers) appInstanceNames.delete(name);

    if (meta.lifecycleState === 'installing' && activeInstallIds.has(meta.appId)) {
      // The durable operation record and provisional metadata agree that this
      // installer is still live in this process. Network reconciliation applies
      // the same ownership test before touching its reserved lease.
      continue;
    }

    if (!activeNetworkIds.has(meta.appId)) {
      unresolved.push(`metadata-without-active-network:${meta.appId}`);
      for (const name of containers) {
        if (!instances.includes(name)) continue;
        try {
          await stopInstance(name);
          repaired.push(`stopped-unowned-app:${name}`);
        } catch {
          unresolved.push(`stop-unowned-app:${name}:${SAFE_FAILURE}`);
        }
      }
      if (installedById.has(meta.appId)) {
        try {
          await removeInstalledApp(meta.appId);
          repaired.push(`hidden-incomplete-app:${meta.appId}`);
        } catch {
          unresolved.push(`hidden-incomplete-app:${meta.appId}:${SAFE_FAILURE}`);
        }
      }
      continue;
    }

    if (networkProblemIds.has(meta.appId)) {
      unresolved.push(`app-reconcile-blocked-by-network:${meta.appId}`);
      continue;
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
      } catch {
        unresolved.push(`installed-apps:${meta.appId}:${SAFE_FAILURE}`);
      }
    }

    try {
      const repairedUi = await reconcileUIRegistration(meta);
      if (repairedUi) repaired.push(`ui-drawer:${meta.appId}`);
    } catch {
      unresolved.push(`ui-drawer:${meta.appId}:${SAFE_FAILURE}`);
    }
  }

  for (const app of installedApps) {
    if (!metadataById.has(app.appId)) {
      const hasLive = appInstanceNames.has(`app-${app.appId}`) || appInstanceNames.has(`ye-app-${app.appId}`);
      if (!hasLive) {
        try {
          await removeInstalledApp(app.appId);
          repaired.push(`stale-installed-app:${app.appId}`);
        } catch {
          unresolved.push(`stale-installed-app:${app.appId}:${SAFE_FAILURE}`);
        }
      }
    }
  }

  for (const name of Array.from(appInstanceNames)) {
    const appId = name.replace(/^app-/, '').replace(/^ye-app-/, '');
    if (!metadataById.has(appId)) {
      unresolved.push(`orphan-container:${name}`);
    }
  }

  await reconcileRoutes(reconcilableMetadataById, repaired, unresolved);

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

  return { repaired, unresolved };
}

async function stopInstance(name: string): Promise<void> {
  const before = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (before.type === 'error' && (before.error_code === 404 || before.status_code === 404)) return;
  if (before.type === 'error') throw new Error(before.error || before.status);
  if (before.metadata?.status === 'Stopped') return;
  const stopped = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
    action: 'stop',
    force: true,
    timeout: 30,
  });
  if (stopped.type === 'error') throw new Error(stopped.error || stopped.status);
  if (stopped.type === 'async' && stopped.operation) {
    const waited = await incusRequest('GET', `${stopped.operation}/wait?timeout=60`, undefined, { timeout: 70_000 });
    if (waited.type === 'error') throw new Error(waited.error || waited.status);
  }
  const after = await incusRequest<{ status?: string }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (after.type === 'error' || after.metadata?.status !== 'Stopped') {
    throw new Error(`Container ${name} did not read back as Stopped`);
  }
}

export async function cleanupAppByScan(
  appId: string,
  options: { keepData?: boolean; dropDatabase?: boolean } = {},
): Promise<ReconcileResult> {
  if (!/^[a-z0-9-]+$/.test(appId)) {
    throw new Error(`Invalid app ID for cleanup: ${appId}`);
  }
  const repaired: string[] = [];
  const unresolved: string[] = [];
  const recoveryMetadata = await readInstallMetadata(appId);
  const interruptedInstall = recoveryMetadata?.lifecycleState === 'installing';
  const prefixes = new Set([`app-${appId}`, `ye-app-${appId}`, appId]);
  const instances = await listInstances();
  const recordedInstances = new Set((recoveryMetadata?.containers ?? [])
    .map((container) => typeof container === 'string' ? container : container.containerName)
    .filter(Boolean));
  const matchingInstances = [...new Set([
    ...instances.filter((name) => [...prefixes].some((prefix) => name === prefix || name.startsWith(`${prefix}-`))),
    ...instances.filter((name) => recordedInstances.has(name)),
  ])];
  const matchingIPs = new Set<string>();
  for (const name of matchingInstances) {
    const ip = await getContainerIP(name);
    if (ip) matchingIPs.add(ip);
  }

  for (const name of matchingInstances) {
    try {
      await deleteInstance(name);
      repaired.push(`instance:${name}`);
    } catch {
      unresolved.push(`instance:${name}:${SAFE_FAILURE}`);
    }
  }

  // Routes no longer have a workload target after the instances are gone.
  try {
    const routes = await getRoutes();
    for (const route of routes) {
      if (route.id.startsWith(`app-${appId}-`)
        || matchingInstances.includes(route.upstream)
        || matchingIPs.has(route.upstream)) {
        await removeRoute(route.id);
      }
    }
    await removeAppRoutes(appId);
    repaired.push(`routes:${appId}`);
  } catch {
    unresolved.push(`routes:${appId}:${SAFE_FAILURE}`);
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
  } catch {
    unresolved.push(`bridges:${appId}:${SAFE_FAILURE}`);
  }

  // Remove the Control-owned holders on the primary bridge. The IPAM lease is
  // deliberately retained until every cleanup step below succeeds.
  try {
    const { removeSystemProxyDevices, removeCaddyFromAppNetwork } = await import('@/lib/incus/app-network');
    await removeSystemProxyDevices(appId);
    await removeCaddyFromAppNetwork(appId);
    repaired.push(`network-attachments:${appId}`);
  } catch {
    unresolved.push(`network-attachments:${appId}:${SAFE_FAILURE}`);
  }

  if (interruptedInstall && (recoveryMetadata.ssoClientId || recoveryMetadata.ssoSlug)) {
    try {
      const clientId = recoveryMetadata.ssoClientId || recoveryMetadata.ssoSlug!;
      await removeOAuthClient(clientId);
      const { getClient } = await import('@/lib/identity/store');
      if (await getClient(clientId)) throw new Error('identity client remains');
      repaired.push(`identity-client:${appId}`);
    } catch {
      unresolved.push(`identity-client:${appId}:${SAFE_FAILURE}`);
    }
  }

  if (interruptedInstall && recoveryMetadata.forwardAuthEnabled) {
    try {
      await removeForwardAuth({ hostname: `${recoveryMetadata.subdomain}.${recoveryMetadata.domain}` });
      repaired.push(`forward-auth:${appId}`);
    } catch {
      unresolved.push(`forward-auth:${appId}:${SAFE_FAILURE}`);
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
    } catch {
      unresolved.push(`dns:${appId}:${SAFE_FAILURE}`);
    }
  }

  const shouldDropDatabase = options.dropDatabase
    || (interruptedInstall && recoveryMetadata.databaseMode === 'shared');
  if (shouldDropDatabase && !recoveryMetadata) {
    unresolved.push(`database-ownership:${appId}:install metadata is required for destructive database cleanup`);
  } else if (shouldDropDatabase) {
    try {
      await dropAppDatabase(
        recoveryMetadata!.databaseName || appId,
        recoveryMetadata!.databaseUser || appId,
      );
      repaired.push(`database:${appId}`);
    } catch {
      unresolved.push(`database:${appId}:${SAFE_FAILURE}`);
    }
  }

  if (options.keepData === false || (interruptedInstall && !recoveryMetadata.recoveryPreserveData)) {
    try {
      if (recoveryMetadata?.storageVolumes?.length) {
        await deleteAppStorage(recoveryMetadata.storageVolumes);
      }
      repaired.push(`storage:${appId}`);
    } catch {
      unresolved.push(`storage:${appId}:${SAFE_FAILURE}`);
    }
  }

  try {
    await removeInstalledApp(appId);
    repaired.push(`installed-apps:${appId}`);
  } catch {
    unresolved.push(`installed-apps:${appId}:${SAFE_FAILURE}`);
  }

  try {
    await deregisterAppFromUI(appId);
    repaired.push(`ui-drawer:${appId}`);
  } catch {
    unresolved.push(`ui-drawer:${appId}:${SAFE_FAILURE}`);
  }

  // Prove every dependent resource absent before the network lease can be
  // released. Post-release discovery is too late because metadata is the only
  // exact recovery map for interrupted installs.
  const dependenciesAfterCleanup = await listInstances();
  for (const name of matchingInstances) {
    if (dependenciesAfterCleanup.includes(name)) unresolved.push(`verify-instance:${name}`);
  }
  const routesAfterCleanup = await getRoutes();
  if (routesAfterCleanup.some((route) => route.id.startsWith(`app-${appId}-`)
    || matchingInstances.includes(route.upstream)
    || matchingIPs.has(route.upstream))) {
    unresolved.push(`verify-routes:${appId}`);
  }
  if (await getInstalledApp(appId)) unresolved.push(`verify-installed-apps:${appId}`);
  try {
    if (await isAppRegisteredWithUI(appId)) unresolved.push(`verify-ui-drawer:${appId}`);
  } catch {
    unresolved.push(`verify-ui-drawer:${appId}:${SAFE_FAILURE}`);
  }

  const { deleteAppNetwork, getAppNetworkLease, markAppNetworkCleanupPending } = await import('@/lib/incus/app-network');
  if (unresolved.length === 0) {
    try {
      await deleteAppNetwork(appId);
      repaired.push(`network:${appId}`);
    } catch {
      unresolved.push(`network:${appId}:${SAFE_FAILURE}`);
    }
  } else {
    try {
      await markAppNetworkCleanupPending(appId, 'scan-cleanup', unresolved.join('; '));
    } catch {
      unresolved.push(`network-state:${appId}:${SAFE_FAILURE}`);
    }
  }

  const remainingInstances = await listInstances();
  for (const name of matchingInstances) {
    if (remainingInstances.includes(name)) unresolved.push(`verify-instance:${name}`);
  }
  const remainingRoutes = await getRoutes();
  if (remainingRoutes.some((route) => route.id.startsWith(`app-${appId}-`)
    || matchingInstances.includes(route.upstream)
    || matchingIPs.has(route.upstream))) {
    unresolved.push(`verify-routes:${appId}`);
  }
  if (await getInstalledApp(appId)) unresolved.push(`verify-installed-apps:${appId}`);
  try {
    if (await isAppRegisteredWithUI(appId)) unresolved.push(`verify-ui-drawer:${appId}`);
  } catch {
    unresolved.push(`verify-ui-drawer:${appId}:${SAFE_FAILURE}`);
  }

  let leasePresent = true;
  try {
    const lease = await getAppNetworkLease(appId);
    leasePresent = lease !== null;
    if (lease) unresolved.push(`verify-network:${appId}:${lease.bridgeName}:${lease.state}`);
  } catch {
    unresolved.push(`verify-network:${appId}:${SAFE_FAILURE}`);
  }

  // Install metadata is the final recovery map. Remove it only after all
  // resources are verified absent and the lease is safely released.
  if (unresolved.length === 0 && !leasePresent) {
    try {
      const preserveData = options.keepData !== false
        || (interruptedInstall && recoveryMetadata.recoveryPreserveData);
      if (preserveData) await removeInstallMetadataRecord(appId);
      else await removeInstallMetadata(appId);
      repaired.push(`metadata:${appId}`);
    } catch {
      unresolved.push(`metadata:${appId}:${SAFE_FAILURE}`);
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
  } catch {
    unresolved.push(`routes:list:${SAFE_FAILURE}`);
    return;
  }

  for (const route of routes) {
    const upstream = String((route as { upstream?: string }).upstream ?? '');
    const match = upstream.match(/^(app|ye-app)-([a-z0-9-]+)/);
    if (!match) continue;
    const appId = match[2];
    if (metadataById.has(appId)) continue;
    try {
      await removeAppRoutes(appId);
      repaired.push(`stale-route:${appId}`);
    } catch {
      unresolved.push(`stale-route:${appId}:${SAFE_FAILURE}`);
    }
  }

  for (const meta of metadataById.values()) {
    if (routesPresent(meta, routes)) continue;
    try {
      await recreateRoutes(meta);
      const verifiedRoutes = await getRoutes();
      if (!routesPresent(meta, verifiedRoutes)) {
        throw new Error('Caddy route did not persist after reconcile');
      }
      repaired.push(`caddy-route:${meta.appId}`);
    } catch {
      unresolved.push(`caddy-route:${meta.appId}:${SAFE_FAILURE}`);
    }
  }
}

function routesPresent(meta: InstallMetadata, routes: Awaited<ReturnType<typeof getRoutes>>): boolean {
  const hostname = `${meta.subdomain}.${meta.domain}`;
  const entrances = (meta.entrances ?? []).filter((entrance) => entrance.protocol !== 'tcp' && entrance.authLevel !== 'internal');
  if (entrances.length === 0) return routes.some((route) => route.hostname === hostname);
  return entrances.every((entrance) => routes.some((route) => route.id === `app-${meta.appId}-${entrance.name}`));
}

async function recreateRoutes(meta: InstallMetadata): Promise<void> {
  if (!meta.subdomain || !meta.domain) throw new Error('install metadata lacks subdomain or domain');
  const primary = pickPrimaryContainer(meta.containers, meta.appId);
  const hostname = `${meta.subdomain}.${meta.domain}`;
  const forwardAuth = meta.forwardAuthEnabled ? await forwardAuthConfig() : undefined;
  const entrances = (meta.entrances ?? []) as EntranceConfig[];
  if (entrances.length > 0) {
    await addAppRoutes(meta.appId, hostname, entrances, primary.containerName, forwardAuth, meta.usePerAppBridge ? 'reconcile' : undefined);
    return;
  }

  let upstream = primary.containerName;
  if (meta.usePerAppBridge) {
    const ip = await getContainerIP(primary.containerName);
    if (!ip) throw new Error(`container address unavailable for ${primary.containerName}`);
    upstream = ip;
  }
  await addRoute({ hostname, path: '/*', upstream, port: primary.port || 3000, forwardAuth });
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

async function deleteInstance(name: string): Promise<void> {
  try {
    await incusRequest('PUT', `/1.0/instances/${name}/state`, { action: 'stop', force: true, timeout: 30 });
  } catch {
    console.warn(`[reconcile] Could not confirm stop for ${name}; delete verification will decide the result`);
  }
  const result = await incusRequest<{ operation?: string; type?: string }>('DELETE', `/1.0/instances/${name}`);
  if (result.type === 'async' && result.operation) {
    await incusRequest('GET', `${result.operation}/wait?timeout=60`, undefined, { timeout: 70_000 });
  }
}

function normalizeContainers(containers: Array<ContainerMeta | string> | undefined, appId: string): string[] {
  if (!containers || containers.length === 0) return [`app-${appId}`];
  return containers
    .map((c) => typeof c === 'string' ? c : c?.containerName || c?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

async function reconcileUIRegistration(meta: InstallMetadata): Promise<boolean> {
  const alreadyRegistered = await isAppRegisteredWithUI(meta.appId);
  if (alreadyRegistered) return false;

  await registerAppWithUI(meta);
  await pushConnectionsToUI(meta.appId);

  const verified = await isAppRegisteredWithUI(meta.appId);
  if (!verified) {
    throw new Error('UI registration did not persist after reconcile');
  }
  return true;
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
  const terminate = await execCommand(
    POSTGRES_CONTAINER,
    ['/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapeSqlLiteral(databaseName)}' AND pid <> pg_backend_pid();`],
    { timeout: 10_000 },
  );
  if (terminate.exitCode !== 0) throw new Error('could not terminate database sessions');
  const drop = await execCommand(
    POSTGRES_CONTAINER,
    ['/usr/local/bin/psql', '-v', 'ON_ERROR_STOP=1', '-U', 'youeye', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${database}`, '-c', `DROP ROLE IF EXISTS ${role}`],
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
