/**
 * Bridge Manager
 *
 * Handles bridge lifecycle: creation, activation, deactivation.
 * Integrates with Incus ACLs for network enforcement and
 * the variable system for env mapping resolution.
 */

import {
  Bridge, EnvMapping,
  addBridge, updateBridge, removeBridge, getBridge,
  getBridgesForApp, getPendingBridgesForTarget, loadBridges,
} from './store';
import {
  appContainerAddress,
  grantBridgeAccess, refreshBridgeAccess, revokeBridgeAccess,
  SYSTEM_APP_IDS,
  withAppNetworkOperationLock,
} from '../incus/app-network';
import { withAppLifecycle } from '../market/update-admission';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import { incusDownloadFile, incusRequest, incusUploadFile } from '../incus/server';
import { CONTAINER_DOMAIN } from '../market/constants';
import { readInstallMetadata, listInstalledApps } from '../market/metadata';
import { readInstalledAppManifest } from '../market/frozen-manifest';
import { injectCaddyRootCA } from '../market/caddy-ca';
import { readFile } from 'fs/promises';
import { listInternetGrants } from './internet-store';
import { addScopedAppGrantRoute, removeScopedAppGrantRoute } from '../caddy/client';
import type { ContainerMeta, InstallMetadata } from '../market/types';
import { managedProxyTransport } from '../../../../shared/managed-proxy';
import { sameConnectionProjection } from './connection-projection';
import { describeErrorChainForLog } from '../market/install-tracker';
import { runConnectionWiring } from '../market/wire-runner';

// ─── UI Connection Push ──────────────────────────────────────
// Push bridge/connection state to YE-UI whenever bridges change.
// UI stores this locally so /api/v1/my-connections can serve apps.

const TOKEN_FILE = '/etc/youeye/ui-bridge-token';
const UI_CONTAINER = 'youeye-ui';
let _bridgeToken: string | null = null;
let _uiIP: string | null = null;

function withBridgeLifecycleLock<T>(operation: string, work: () => Promise<T>): Promise<T> {
  return withAppNetworkOperationLock('bridge-lifecycle', operation, work, { waitMs: 30_000 });
}

function withBridgeAppLocks<T>(from: string, to: string, work: () => Promise<T>): Promise<T> {
  const appIds = [...new Set([from, to])].sort();
  const admit = (index: number): Promise<T> => index === appIds.length
    ? work()
    : withAppLifecycle(appIds[index], () => admit(index + 1));
  return admit(0);
}

async function withBridgeAdmission<T>(
  bridgeId: string,
  operation: string,
  absent: T,
  work: () => Promise<T>,
): Promise<T> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return absent;
  return withBridgeAppLocks(bridge.from, bridge.to, () => withBridgeLifecycleLock(operation, async () => {
    const current = await getBridge(bridgeId);
    if (!current) return absent;
    if (current.from !== bridge.from || current.to !== bridge.to) {
      throw new Error('Bridge ownership changed during lifecycle admission');
    }
    return work();
  }));
}

async function restartInstanceExact(containerName: string): Promise<void> {
  const response = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(containerName)}/state`, {
    action: 'restart',
    force: false,
    timeout: 30,
  });
  if (response.type === 'error') throw new Error('Container restart failed');
  if (response.type === 'async' && response.operation) {
    const waited = await incusRequest('GET', `${response.operation}/wait?timeout=60`, undefined, { timeout: 70_000 });
    if (waited.type === 'error') throw new Error('Container restart wait failed');
  }
  const readBack = await incusRequest<{ status?: string }>(
    'GET',
    `/1.0/instances/${encodeURIComponent(containerName)}`,
  );
  if (readBack.type === 'error' || readBack.metadata?.status !== 'Running') {
    throw new Error('Container did not read back as Running after restart');
  }
}

async function writeContainerFileExact(
  containerName: string,
  filePath: string,
  content: Buffer,
): Promise<void> {
  await incusUploadFile(containerName, filePath, content, { timeout: 10_000, mode: '0600' });
  if (!content.equals(await incusDownloadFile(containerName, filePath))) {
    throw new Error('Container file did not read back exactly');
  }
}

function applyResolvedMappings(content: string, mappings: EnvMapping[]): string {
  const lines = content.split('\n').filter(Boolean);
  for (const mapping of mappings) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mapping.key)
      || mapping.resolved === undefined || /[\r\n\0]/.test(mapping.resolved)) {
      throw new Error('Connection environment mapping is invalid');
    }
    const lineIndex = lines.findIndex((line) => line.startsWith(`${mapping.key}=`));
    const newLine = `${mapping.key}=${mapping.resolved}`;
    if (lineIndex >= 0) lines[lineIndex] = newLine;
    else lines.push(newLine);
  }
  return `${lines.join('\n')}\n`;
}

function removeResolvedMappings(content: string, mappings: EnvMapping[]): string {
  const keys = new Set(mappings.map((mapping) => mapping.key));
  const lines = content.split('\n').filter((line) =>
    line.length > 0 && ![...keys].some((key) => line.startsWith(`${key}=`)));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function primaryContainer(meta: InstallMetadata | null | undefined): ContainerMeta | undefined {
  const containers = meta?.containers ?? [];
  return containers.length > 1
    ? containers.find((container) =>
      container.primary || container.name === 'main' || container.name === 'server') ?? containers[0]
    : containers[0];
}

/**
 * Compute the list of available backends for an app based on its manifest wants.
 * Used by pushConnectionsToUI to populate the `available` field so Canvas
 * NeedsBackend components can show which backends exist.
 */
async function computeAvailableBackends(appId: string): Promise<Array<Record<string, unknown>>> {
  const available: Array<Record<string, unknown>> = [];
  async function installedTarget(meta: InstallMetadata, fallbackPort?: number): Promise<{ host?: string; port?: number }> {
    const primary = primaryContainer(meta);
    const containerName = primary?.containerName || (meta?.appId ? `app-${meta.appId}` : undefined);
    const host = containerName ? await getIncusContainerIP(containerName) : undefined;
    return {
      host: host || containerName,
      port: primary?.port || fallbackPort,
    };
  }
  try {
    const manifest = await readInstalledAppManifest(appId);
    const wants = manifest.wants ?? [];
    const allMeta = await listInstalledApps();
    const installedById = new Map(allMeta.map(m => [m.appId, m]));

    for (const want of wants) {
      if (want.appId) {
        const meta = installedById.get(want.appId);
        const installed = !!meta;
        const target = installed ? await installedTarget(meta, want.defaultPort) : {};
        available.push({
          appId: want.appId,
          name: want.name,
          description: want.description,
          installed,
          host: target.host,
          port: target.port,
          accessMode: 'proxy',
          allowedPaths: want.proxy?.paths,
          allowedMethods: want.proxy?.methods,
        });
      } else if (want.type) {
        // Type-based want — find all providers of this type
        for (const meta of allMeta) {
          if (meta.appId === appId) continue;
          let name = meta.appId;
          let providesType = meta.provides?.some(p => p.type === want.type) ?? false;
          if (!providesType) {
            try {
              const m = await readInstalledAppManifest(meta.appId);
              providesType = m.provides?.some((provider) => provider.type === want.type) ?? false;
              name = m.metadata.name;
            } catch {
              // skip unknown manifests
            }
          }
          if (!providesType) continue;
          const target = await installedTarget(meta, want.defaultPort);
          available.push({
            appId: meta.appId,
            name,
            description: want.description,
            installed: true,
            host: target.host,
            port: target.port,
            accessMode: 'proxy',
          });
        }
      }
    }
  } catch {
    // App may not have a manifest — return empty
  }
  return available;
}

async function computeInternetProxyScopes(appId: string): Promise<Array<Record<string, unknown>>> {
  try {
    // `proxy:` scopes are the only per-host internet mechanism (`internet:` is NAT on/off).
    const manifest = await readInstalledAppManifest(appId);
    return (manifest.internet?.proxy ?? []).map((scope) => ({
      host: scope.host,
      paths: scope.paths,
      methods: scope.methods?.length ? scope.methods : ['GET'],
    }));
  } catch {
    return [];
  }
}

/**
 * The stored UI projection differs from the desired one: a read-only audit cannot repair it, the caller repairs it
 * under the app's lifecycle admission. Expected drift, not a failure.
 */
export class UIProjectionDriftError extends Error {
  constructor(appId: string) {
    super(`UI connection projection for ${appId} requires an admitted repair`);
    this.name = 'UIProjectionDriftError';
  }
}

/**
 * The connections an app's UI row lists: the ones it consumes (it is `from`), plus both-ways network connections
 * where it is the provider (`to`), which let it reach the consumer back. A one-way connection, and any scoped-proxy
 * connection, gives the provider nothing to call. The activate, deactivate and delete paths push the `to` side only
 * for both-ways connections, so this is the same rule.
 */
export function projectedBridgesFor(appId: string, bridges: Bridge[]): Bridge[] {
  return bridges.filter((bridge) => bridge.active && (bridge.from === appId
    || (bridge.to === appId && bridge.direction === 'both-ways' && isNetworkConnection(bridge))));
}

export async function pushConnectionsToUI(appId: string, options: { required?: boolean; observed?: unknown; auditOnly?: boolean } = {}): Promise<void> {
  try {
    if (!_bridgeToken) {
      _bridgeToken = (await readFile(TOKEN_FILE, 'utf-8')).trim();
    }
    if (!_uiIP) {
      _uiIP = await getIncusContainerIP(UI_CONTAINER);
    }
    if (!_uiIP || !_bridgeToken) throw new Error('UI connection projection authority unavailable');

    const activeBridges = projectedBridgesFor(appId, await getBridgesForApp(appId));

    // Resolve IPs for active bridges
    const resolved = await Promise.all(
      activeBridges.map(async (b) => {
        if (b.from !== appId) {
          // The provider's side of a both-ways network connection: the consumer's address, nothing to proxy.
          return { ...(await peerAddress(b.from)), appId: b.from, name: b.from, accessMode: 'network',
            direction: b.direction, active: b.active };
        }
        const targetId = b.to;
        const meta = await readInstallMetadata(targetId);
        // For multi-container apps, find the primary container (named "main" or "server"),
        // not just the first one (which may be a sidecar like Redis).
        const primary = primaryContainer(meta);
        const containerName = primary?.containerName || `app-${targetId}`;
        const ip = await getIncusContainerIP(containerName);
        const port = primary?.port || 8080;
        let transport;
        if (b.url && (b.accessMode === 'proxy' || b.accessMode === 'caddy')) {
          const hostname = meta?.subdomain && meta.domain ? `${meta.subdomain}.${meta.domain}` : '';
          if (!hostname || b.url !== `https://${hostname}`) {
            throw new Error(`Scoped proxy hostname of connection ${b.id} differs from the installed target ${targetId}`);
          }
          const [address, ca] = await Promise.all([
            getIncusContainerIP('youeye-caddy'),
            incusDownloadFile('youeye-caddy', '/data/caddy/pki/authorities/local/root.crt'),
          ]);
          transport = managedProxyTransport({ schema: 'youeye.managed-proxy.v1',
            address, hostname, ca: ca.toString('utf8') }, b.url);
        }
        return {
          appId: targetId,
          name: targetId,
          host: ip || containerName,
          port,
          url: b.url,
          transport,
          accessMode: b.accessMode || 'network',
          allowedPaths: b.allowedPaths,
          allowedMethods: b.allowedMethods,
          direction: b.direction,
          active: b.active,
        };
      }),
    );

    // Get internet grants for this app
    const grants = await listInternetGrants();
    const grant = grants.find(g => g.appId === appId);
    const internetScopes = await computeInternetProxyScopes(appId);

    // Build available backends list from the app's wants
    const available = await computeAvailableBackends(appId);

    const payload = {
      appId,
      bridges: resolved,
      internet: {
        granted: !!grant,
        hosts: grant?.hosts ?? [],
        proxy: internetScopes,
      },
      available,
    };

    // Only reconciliation supplies a freshly read pass-local database snapshot.
    // Missing/changed projections still use the authenticated write below; no
    // cross-pass remembered success can hide a UI restart or external change.
    if (sameConnectionProjection(options.observed, { bridges: resolved, internet: payload.internet, available })) return;

    if (options.auditOnly) throw new UIProjectionDriftError(appId);

    const response = await fetch(`http://${_uiIP}:3000/api/ui-bridge/app-connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': _bridgeToken,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('UI connection projection was not accepted');
  } catch (error) {
    if (error instanceof UIProjectionDriftError) throw error;
    if (options.required || options.auditOnly) {
      throw new Error('Current UI connection projection could not be verified', { cause: error });
    }
    // Non-fatal — UI might not have the endpoint yet during upgrades
    console.warn(`[bridges] Failed to push connections to UI for ${appId}: ${describeErrorChainForLog(error)}`);
  }
}

/** An app's primary container address and port, as a connection entry lists it. */
async function peerAddress(appId: string): Promise<{ host: string; port: number }> {
  const primary = primaryContainer(await readInstallMetadata(appId));
  const containerName = primary?.containerName || `app-${appId}`;
  const ip = await getIncusContainerIP(containerName);
  return { host: ip || containerName, port: primary?.port || 8080 };
}

/**
 * Resolve an app ID to its primary Incus container name.
 * Single-container apps: app-{appId}
 * Multi-container apps: app-{appId}-{primaryName} (from install metadata)
 * Falls back to app-{appId} if metadata is unavailable.
 */
async function resolveContainerName(appId: string): Promise<string> {
  const meta = await readInstallMetadata(appId);
  if (meta?.containers && meta.containers.length > 1) {
    // Multi-container app — find the primary or use first
    const cn = primaryContainer(meta)?.containerName;
    if (cn) return cn;
  }
  return `app-${appId}`;
}

/**
 * Create a bridge record. Does NOT activate it — call activateBridge() separately.
 */
export async function createBridge(params: {
  from: string;
  to: string;
  direction?: 'one-way' | 'both-ways';
  envMappings: EnvMapping[];
  approvedBy: string;
}): Promise<Bridge> {
  // Reject bridges targeting system containers
  if (SYSTEM_APP_IDS.includes(params.to)) {
    throw new Error(`Cannot create bridge to system container: ${params.to}`);
  }

  const bridge: Bridge = {
    id: `${params.from}-to-${params.to}`,
    from: params.from,
    to: params.to,
    direction: params.direction || 'one-way',
    approved: true,
    active: false,
    envMappings: params.envMappings,
    approvedBy: params.approvedBy,
    approvedAt: new Date().toISOString(),
  };

  return withBridgeAppLocks(params.from, params.to, () => withBridgeLifecycleLock('bridge-create', async () => {
    await addBridge(bridge);
    return bridge;
  }));
}

/**
 * Resolve bridge env mappings against live container state.
 * Called when the target app is installed and its containers are running.
 *
 * For per-app bridge apps, internal_host/url uses the container IP (DNS
 * doesn't cross bridges). When the container IP is unknown, uses DNS names.
 */
export async function resolveBridgeMappings(
  envMappings: EnvMapping[],
  targetContainerName: string,
  targetPort: number,
  targetSubdomain: string,
  domain: string,
): Promise<EnvMapping[]> {
  // Determine if target is on a per-app bridge — if so, use IP for internal refs
  const targetIP = await getIncusContainerIP(targetContainerName);
  const useIP = targetIP ? true : false;
  const internalHost = useIP ? targetIP! : `${targetContainerName}.${CONTAINER_DOMAIN}`;

  return envMappings.map(m => {
    let resolved = m.template;
    const target = m.template.match(/\$\{containers\.([^.]+)\.([^}]+)\}/);
    if (target) {
      const prop = target[2];
      switch (prop) {
        case 'internal_host':
          resolved = internalHost;
          break;
        case 'internal_url':
          resolved = `http://${internalHost}:${targetPort}`;
          break;
        case 'url':
          resolved = `https://${targetSubdomain}.${domain}`;
          break;
      }
    }
    return { ...m, resolved };
  });
}

function getScopedGrantRouteId(from: string, to: string): string {
  return `app-grant-${from}-to-${to}`;
}

async function getProxyScopeSpec(from: string, to: string): Promise<{ paths: string[]; methods: string[] } | null> {
  try {
    const manifest = await readInstalledAppManifest(from);
    const want = manifest.wants?.find((w) => w.appId === to && w.proxy?.paths?.length);
    if (want?.proxy?.paths?.length) {
      return {
        paths: want.proxy.paths,
        methods: want.proxy.methods?.length ? want.proxy.methods : ['GET'],
      };
    }
  } catch {
    console.warn(`[bridges] Could not resolve manifest scoped grant for ${from}->${to}`);
  }

  return null;
}

async function createScopedProxyGrant(bridge: Bridge): Promise<{ url: string; paths: string[]; methods: string[] } | null> {
  const grantSpec = await getProxyScopeSpec(bridge.from, bridge.to);
  if (!grantSpec) return null;
  const { paths, methods } = grantSpec;

  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);
  const envContent = (await incusDownloadFile(fromContainer, `/etc/${fromContainer}.env`)).toString('utf8');
  const appToken = envContent.split(/\r?\n/)
    .filter((line) => line.startsWith('YOUEYE_APP_TOKEN='))
    .map((line) => line.slice('YOUEYE_APP_TOKEN='.length))
    .at(-1)?.trim();
  if (!appToken) throw new Error(`Could not resolve app token for ${fromContainer}`);

  const targetMeta = await readInstallMetadata(bridge.to);
  if (!targetMeta?.subdomain || !targetMeta.domain) {
    throw new Error(`Could not resolve target hostname for ${bridge.to}`);
  }

  const targetPrimary = primaryContainer(targetMeta);
  const targetContainer = targetPrimary?.containerName || toContainer;
  const targetIp = await appContainerAddress(targetContainer, bridge.to);

  const targetPort = targetPrimary?.port || 8080;
  const hostname = `${targetMeta.subdomain}.${targetMeta.domain}`;

  await addScopedAppGrantRoute({
    id: getScopedGrantRouteId(bridge.from, bridge.to),
    hostname,
    upstreamDial: `${targetIp}:${targetPort}`,
    paths,
    methods,
    appToken,
  });
  try {
    await injectCaddyRootCA(fromContainer);
    await restartInstanceExact(fromContainer);
  } catch {
    try {
      await removeScopedAppGrantRoute(getScopedGrantRouteId(bridge.from, bridge.to));
    } catch {
      throw new Error('Scoped proxy activation failed and route rollback could not be verified');
    }
    throw new Error('Scoped proxy activation failed; route rollback verified');
  }

  return {
    url: `https://${hostname}`,
    paths,
    methods,
  };
}

/** A connection through a NIC on the peer's network (not a scoped UI-gateway grant). */
function isNetworkConnection(bridge: Bridge): boolean {
  return bridge.accessMode !== 'proxy' && bridge.accessMode !== 'caddy';
}

/**
 * Activate a bridge: grant network access + inject env vars + restart source container, then run
 * the consumer's connect setup file (every activation path; idempotent, so an already active
 * connection is wired again). A wiring failure is logged and never undoes the activation.
 */
export async function activateBridge(bridgeId: string): Promise<Bridge | null> {
  const bridge = await withBridgeAdmission<Bridge | null>(bridgeId, 'bridge-activate', null, () => activateBridgeLocked(bridgeId));
  if (bridge?.active && isNetworkConnection(bridge)) await runConnectionWiring(bridge.from, bridge.to);
  return bridge;
}

/** Before a connection goes away: run the `remove:` steps of the consumer's connect file (non-fatal). */
async function unwireBridge(bridgeId: string): Promise<void> {
  const bridge = await getBridge(bridgeId);
  if (bridge?.active && isNetworkConnection(bridge)) {
    await runConnectionWiring(bridge.from, bridge.to, undefined, { remove: true });
  }
}

/** Point an active network connection's ACLs (both ways if it has two) at the peers' current addresses. */
async function refreshBridgeGrants(bridge: Bridge): Promise<void> {
  if (!bridge.active || !isNetworkConnection(bridge)) return;
  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);
  await refreshBridgeAccess(fromContainer, bridge.to, toContainer);
  if (bridge.direction === 'both-ways') await refreshBridgeAccess(toContainer, bridge.from, fromContainer);
}

/**
 * Refresh the ACLs of every active network connection (of `appId` only, when given). Run after an
 * app starts and on every reconcile pass, so a recreated peer's new address is picked up. Takes no
 * locks: `refreshBridgeAccess` only replaces ACLs that exist. Returns the bridges it could not check.
 */
export async function refreshConnectionGrants(appId?: string): Promise<string[]> {
  const failed: string[] = [];
  // The periodic pass skips connections with a stopped side: nothing flows, and starting an app refreshes its own
  // connections (apps/lifecycle.ts). One instance listing per pass; if it fails, every connection is checked.
  const running = appId ? null : await runningInstances();
  for (const bridge of await loadBridges()) {
    if (appId && bridge.from !== appId && bridge.to !== appId) continue;
    if (running && bridge.active && isNetworkConnection(bridge)) {
      const [from, to] = await Promise.all([resolveContainerName(bridge.from), resolveContainerName(bridge.to)]);
      if (!running.has(from) || !running.has(to)) continue;
    }
    try {
      await refreshBridgeGrants(bridge);
    } catch (error) {
      failed.push(bridge.id);
      console.error(`[bridges] Refreshing connection ${bridge.id} failed: ${describeErrorChainForLog(error)}`);
    }
  }
  return failed;
}

async function activateBridgeLocked(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return bridge;
  if (bridge.active) {
    // Re-activation: the peer may have a new address since the grant.
    await refreshBridgeGrants(bridge);
    return bridge;
  }

  // Resolve actual container names (handles multi-container apps)
  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);
  let scopedGrant: Awaited<ReturnType<typeof createScopedProxyGrant>> = null;
  let forwardGranted = false;
  let reverseGranted = false;
  let previousEnv: Buffer | null = null;
  let envFile: string | null = null;
  let envModified = false;

  try {
    scopedGrant = await createScopedProxyGrant(bridge);

    if (!scopedGrant) {
      await grantBridgeAccess(fromContainer, bridge.to, toContainer);
      forwardGranted = true;
      if (bridge.direction === 'both-ways') {
        await grantBridgeAccess(toContainer, bridge.from, fromContainer);
        reverseGranted = true;
      }
    }

    // Inject resolved env vars into source container. The file payload is kept
    // out of command arguments so connection values cannot leak in process or
    // command logging.
    const resolvedMappings = bridge.envMappings.filter(m => m.resolved);
    if (resolvedMappings.length > 0) {
      envFile = `/etc/${fromContainer}.env`;
      previousEnv = await incusDownloadFile(fromContainer, envFile);
      const newEnv = Buffer.from(applyResolvedMappings(previousEnv.toString('utf8'), resolvedMappings), 'utf8');
      await writeContainerFileExact(fromContainer, envFile, newEnv);
      envModified = true;
      await restartInstanceExact(fromContainer);
    }

    const updated = await updateBridge(bridgeId, {
      active: true,
      activatedAt: new Date().toISOString(),
      accessMode: scopedGrant ? 'proxy' : 'network',
      url: scopedGrant?.url,
      allowedPaths: scopedGrant?.paths,
      allowedMethods: scopedGrant?.methods,
    });
    if (!updated?.active) throw new Error('Bridge record did not become active');

    // Push updated connection state to UI (non-blocking)
    pushConnectionsToUI(bridge.from).catch(() => {});
    if (bridge.direction === 'both-ways') {
      pushConnectionsToUI(bridge.to).catch(() => {});
    }

    return updated;
  } catch (error) {
    console.error(`[bridges] Activation of ${bridgeId} failed: ${describeErrorChainForLog(error)}`);
    const rollbackErrors: string[] = [];
    if (envModified && envFile && previousEnv) {
      try {
        await writeContainerFileExact(fromContainer, envFile, previousEnv);
        await restartInstanceExact(fromContainer);
      } catch {
        rollbackErrors.push('environment');
      }
    }
    if (scopedGrant) {
      try {
        await removeScopedAppGrantRoute(getScopedGrantRouteId(bridge.from, bridge.to));
      } catch {
        rollbackErrors.push('scoped route');
      }
    }
    if (reverseGranted) {
      try {
        await revokeBridgeAccess(toContainer, bridge.from);
      } catch {
        rollbackErrors.push('reverse grant');
      }
    }
    if (forwardGranted) {
      try {
        await revokeBridgeAccess(fromContainer, bridge.to);
      } catch {
        rollbackErrors.push('forward grant');
      }
    }
    const suffix = rollbackErrors.length > 0 ? `; rollback failed: ${rollbackErrors.join(', ')}` : '';
    throw new Error(`Bridge activation ${bridgeId} failed${suffix}`);
  }
}

/**
 * Change a connection's direction. On an active network connection the provider's grant to reach the consumer back
 * is added (both-ways) or revoked (one-way) first, then the record changes, then both sides' UI rows are pushed (the
 * provider's row gains or loses its entry). A scoped-proxy connection has no reverse grant; only its record changes.
 * Runs under the same admission as activate and deactivate.
 */
export async function setBridgeDirection(bridgeId: string, direction: Bridge['direction']): Promise<Bridge | null> {
  return withBridgeAdmission<Bridge | null>(bridgeId, 'bridge-direction', null, async () => {
    const bridge = await getBridge(bridgeId);
    if (!bridge) return null;
    if (bridge.direction === direction) return bridge;
    // The provider's grant to reach the consumer is one NIC and ACL per (container, target app): another active
    // connection the other way may hold the same one, and then it is neither added nor taken away here.
    const reverseGrant = bridge.active && isNetworkConnection(bridge)
      && !(await networkGrantNeededElsewhere(bridge.to, bridge.from, bridgeId));
    const fromContainer = reverseGrant ? await resolveContainerName(bridge.from) : '';
    const toContainer = reverseGrant ? await resolveContainerName(bridge.to) : '';
    const grant = () => grantBridgeAccess(toContainer, bridge.from, fromContainer);
    const revoke = () => revokeBridgeAccess(toContainer, bridge.from);
    try {
      if (reverseGrant) await (direction === 'both-ways' ? grant() : revoke());
      const updated = await updateBridge(bridgeId, { direction });
      if (updated?.direction !== direction) throw new Error('Bridge record did not take the new direction');
      if (updated.active) {
        pushConnectionsToUI(updated.from).catch(() => {});
        pushConnectionsToUI(updated.to).catch(() => {});
      }
      return updated;
    } catch (error) {
      // Put the grant back as the unchanged record describes it (a revoke can fail halfway, a grant cleans up
      // after itself but is undone here too).
      if (reverseGrant) {
        try {
          await (direction === 'both-ways' ? revoke() : grant());
        } catch (rollback) {
          console.error(`[bridges] Restoring the reverse grant of ${bridgeId} failed: ${describeErrorChainForLog(rollback)}`);
        }
      }
      throw new Error(`Changing the direction of ${bridgeId} failed`, { cause: error });
    }
  });
}

/**
 * Whether another active network connection than `exceptBridgeId` needs app `appId` to reach app `targetAppId`:
 * one from `appId` to `targetAppId`, or a both-ways one from `targetAppId` to `appId`. Both use the same NIC and ACL.
 */
async function networkGrantNeededElsewhere(appId: string, targetAppId: string, exceptBridgeId: string): Promise<boolean> {
  return (await loadBridges()).some((other) => other.id !== exceptBridgeId && other.active && isNetworkConnection(other)
    && ((other.from === appId && other.to === targetAppId)
      || (other.direction === 'both-ways' && other.from === targetAppId && other.to === appId)));
}

/**
 * Deactivate a bridge: revoke network access.
 */
export async function deactivateBridge(bridgeId: string): Promise<Bridge | null> {
  // Unwire under the same admission: a busy lock must leave the connection fully wired and recorded active, never
  // unwired but still recorded active.
  return withBridgeAdmission<Bridge | null>(bridgeId, 'bridge-deactivate', null, async () => {
    await unwireBridge(bridgeId);
    return deactivateBridgeLocked(bridgeId);
  });
}

async function deactivateBridgeLocked(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return null;

  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);

  if (bridge.accessMode === 'proxy' || bridge.accessMode === 'caddy') {
    await removeScopedAppGrantRoute(getScopedGrantRouteId(bridge.from, bridge.to));
  } else {
    // A grant another active connection still uses (a connection the other way) stays.
    if (!(await networkGrantNeededElsewhere(bridge.from, bridge.to, bridgeId))) {
      await revokeBridgeAccess(fromContainer, bridge.to);
    }
    if (bridge.direction === 'both-ways' && !(await networkGrantNeededElsewhere(bridge.to, bridge.from, bridgeId))) {
      await revokeBridgeAccess(toContainer, bridge.from);
    }
  }

  const resolvedMappings = bridge.envMappings.filter((mapping) => mapping.resolved);
  if (resolvedMappings.length > 0) {
    const envFile = `/etc/${fromContainer}.env`;
    const current = await incusDownloadFile(fromContainer, envFile);
    const updatedContent = Buffer.from(removeResolvedMappings(current.toString('utf8'), resolvedMappings), 'utf8');
    await writeContainerFileExact(fromContainer, envFile, updatedContent);
    await restartInstanceExact(fromContainer);
  }

  const updated = await updateBridge(bridgeId, { active: false });
  if (!updated || updated.active) throw new Error('Bridge record did not become inactive');

  // Push updated connection state to UI (non-blocking)
  if (bridge) {
    pushConnectionsToUI(bridge.from).catch(() => {});
    if (bridge.direction === 'both-ways') {
      pushConnectionsToUI(bridge.to).catch(() => {});
    }
  }

  return updated;
}

/**
 * Delete a bridge entirely.
 */
export async function deleteBridge(bridgeId: string): Promise<boolean> {
  return withBridgeAdmission(bridgeId, 'bridge-delete', false, async () => {
    await unwireBridge(bridgeId);
    return deleteBridgeLocked(bridgeId);
  });
}

async function deleteBridgeLocked(bridgeId: string): Promise<boolean> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return false;

  if (bridge.active) {
    await deactivateBridgeLocked(bridgeId);
  }

  const removed = await removeBridge(bridgeId);
  if (await getBridge(bridgeId)) throw new Error('Bridge record remains after deletion');

  // Push updated connection state to UI (non-blocking)
  if (bridge) {
    pushConnectionsToUI(bridge.from).catch(() => {});
    if (bridge.direction === 'both-ways') {
      pushConnectionsToUI(bridge.to).catch(() => {});
    }
  }

  return removed;
}

/**
 * Called when a new app is installed (after its network lease is active). Activates the pending
 * bridges targeting this app and wires them; one failing bridge is logged and does not stop the
 * others.
 */
export async function activatePendingBridges(
  targetAppId: string,
  targetContainerName: string,
  targetPort: number,
  targetSubdomain: string,
  domain: string,
): Promise<Bridge[]> {
  const pending = await getPendingBridgesForTarget(targetAppId);
  const activated: Bridge[] = [];

  for (const bridge of pending) {
    try {
      const resolvedMappings = await resolveBridgeMappings(
        bridge.envMappings,
        targetContainerName,
        targetPort,
        targetSubdomain,
        domain,
      );

      await updateBridge(bridge.id, { envMappings: resolvedMappings });

      const result = await activateBridge(bridge.id);
      if (result?.active) {
        activated.push(result);
      }
    } catch (error) {
      console.error(`[bridges] Waiting connection ${bridge.id} could not be activated: ${describeErrorChainForLog(error)}`);
    }
  }

  return activated;
}

export { getBridgesForApp, loadBridges };

async function runningInstances(): Promise<Set<string> | null> {
  try {
    const listed = await incusRequest<Array<{ name: string; status: string }>>('GET', '/1.0/instances?recursion=1');
    if (listed.type === 'error' || !Array.isArray(listed.metadata)) return null;
    return new Set(listed.metadata.filter(instance => instance.status === 'Running').map(instance => instance.name));
  } catch {
    return null;
  }
}
