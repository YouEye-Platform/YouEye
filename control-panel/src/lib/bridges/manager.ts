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
  grantBridgeAccess, revokeBridgeAccess,
  SYSTEM_APP_IDS,
} from '../incus/app-network';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import { execShell } from '../incus/server';
import { CONTAINER_DOMAIN } from '../market/constants';
import { readInstallMetadata, listInstalledApps } from '../market/metadata';
import { fetchManifest } from '../market/catalog';
import { readFile } from 'fs/promises';
import { listInternetGrants } from './internet-store';

// ─── UI Connection Push ──────────────────────────────────────
// Push bridge/connection state to YE-UI whenever bridges change.
// UI stores this locally so /api/v1/my-connections can serve apps.

const TOKEN_FILE = '/etc/youeye/ui-bridge-token';
const UI_CONTAINER = 'youeye-ui';
let _bridgeToken: string | null = null;
let _uiIP: string | null = null;

/**
 * Compute the list of available backends for an app based on its manifest wants.
 * Used by pushConnectionsToUI to populate the `available` field so Canvas
 * NeedsBackend components can show which backends exist.
 */
async function computeAvailableBackends(appId: string): Promise<Array<{ appId: string; name: string; installed: boolean }>> {
  const available: Array<{ appId: string; name: string; installed: boolean }> = [];
  try {
    const manifest = await fetchManifest(appId);
    const wants = manifest.wants ?? [];
    const allMeta = await listInstalledApps();
    const installedIds = new Set(allMeta.map(m => m.appId));

    for (const want of wants) {
      if (want.appId) {
        // Direct appId want — check if installed
        available.push({
          appId: want.appId,
          name: want.name,
          installed: installedIds.has(want.appId),
        });
      } else if (want.type) {
        // Type-based want — find all providers of this type
        for (const meta of allMeta) {
          if (meta.appId === appId) continue;
          // Check install metadata provides
          if (meta.provides?.some(p => p.type === want.type)) {
            available.push({ appId: meta.appId, name: meta.appId, installed: true });
            continue;
          }
          // Fallback: check manifest
          try {
            const m = await fetchManifest(meta.appId);
            if (m.provides?.some((p: any) => p.type === want.type)) {
              available.push({ appId: meta.appId, name: m.metadata.name, installed: true });
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch {
    // App may not have a manifest — return empty
  }
  return available;
}

async function pushConnectionsToUI(appId: string): Promise<void> {
  try {
    if (!_bridgeToken) {
      _bridgeToken = (await readFile(TOKEN_FILE, 'utf-8')).trim();
    }
    if (!_uiIP) {
      _uiIP = await getIncusContainerIP(UI_CONTAINER);
    }
    if (!_uiIP || !_bridgeToken) return;

    const bridges = await getBridgesForApp(appId);
    const activeBridges = bridges.filter(b => b.active);

    // Resolve IPs for active bridges
    const resolved = await Promise.all(
      activeBridges.map(async (b) => {
        const targetId = b.from === appId ? b.to : b.from;
        const meta = await readInstallMetadata(targetId);
        // For multi-container apps, find the primary container (named "main" or "server"),
        // not just the first one (which may be a sidecar like Redis).
        const primary = meta?.containers && meta.containers.length > 1
          ? (meta.containers.find((c: any) => c.name === 'main' || c.name === 'server') || meta.containers[0])
          : meta?.containers?.[0];
        const containerName = primary?.containerName || `app-${targetId}`;
        const ip = await getIncusContainerIP(containerName);
        const port = primary?.port || 8080;
        return {
          appId: targetId,
          name: targetId,
          host: ip || containerName,
          port,
          direction: b.direction,
          active: b.active,
        };
      }),
    );

    // Get internet grants for this app
    const grants = await listInternetGrants();
    const grant = grants.find(g => g.appId === appId);

    // Build available backends list from the app's wants
    const available = await computeAvailableBackends(appId);

    const payload = {
      appId,
      bridges: resolved,
      internet: {
        granted: !!grant,
        hosts: grant?.hosts ?? [],
      },
      available,
    };

    await fetch(`http://${_uiIP}:3000/api/ui-bridge/app-connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': _bridgeToken,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Non-fatal — UI might not have the endpoint yet during upgrades
    console.warn(`[bridges] Failed to push connections to UI for ${appId}:`, err);
  }
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
    const primary = meta.containers.find((c: any) => c.name === 'main' || c.name === 'server')
      || meta.containers[0];
    const cn = typeof primary === 'string' ? primary : primary.containerName;
    if (cn) return cn;
  }
  return `app-${appId}`;
}

/**
 * Parse env_mapping for ${containers.NAME.*} references
 * to detect which other apps this app needs bridges to.
 */
export function detectBridgeDependencies(
  envMapping: Record<string, string>,
  appId: string,
): { targetAppId: string; envMappings: EnvMapping[] }[] {
  const deps = new Map<string, EnvMapping[]>();
  const pattern = /\$\{containers\.([^.]+)\.(internal_url|internal_host|url)\}/g;

  for (const [envKey, template] of Object.entries(envMapping)) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(template)) !== null) {
      const containerRef = match[1];
      // Skip self-references (containers in the same app use the app's own container names)
      // External references use short names like "jellyfin", "sonarr" etc.
      if (!deps.has(containerRef)) {
        deps.set(containerRef, []);
      }
      deps.get(containerRef)!.push({
        container: appId,
        key: envKey,
        template,
      });
    }
  }

  return Array.from(deps.entries()).map(([targetAppId, envMappings]) => ({
    targetAppId,
    envMappings,
  }));
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

  await addBridge(bridge);
  return bridge;
}

/**
 * Resolve bridge env mappings against live container state.
 * Called when the target app is installed and its containers are running.
 *
 * For per-app bridge apps, internal_host/url uses the container IP (DNS
 * doesn't cross bridges). For legacy incusbr0 apps, uses DNS names.
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

/**
 * Activate a bridge: grant network access + inject env vars + restart source container.
 *
 * Per-app bridge apps: NIC hot-plug (container gets NIC on target's bridge)
 * Legacy apps (incusbr0): ACL rules
 */
export async function activateBridge(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge || bridge.active) return bridge;

  // Resolve actual container names (handles multi-container apps)
  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);

  try {
    await grantBridgeAccess(fromContainer, bridge.to);
    if (bridge.direction === 'both-ways') {
      await grantBridgeAccess(toContainer, bridge.from);
    }
  } catch (err) {
    console.warn(`[bridges] Network access grant failed for ${bridgeId}:`, err);
  }

  // Inject resolved env vars into source container
  const resolvedMappings = bridge.envMappings.filter(m => m.resolved);
  if (resolvedMappings.length > 0) {
    try {
      const envFile = `/etc/${fromContainer}.env`;
      const existingEnv = await execShell(fromContainer, `cat ${envFile} 2>/dev/null || echo ""`, { timeout: 5000 });
      const lines = existingEnv.stdout.split('\n').filter(Boolean);

      for (const mapping of resolvedMappings) {
        const lineIdx = lines.findIndex(l => l.startsWith(`${mapping.key}=`));
        const newLine = `${mapping.key}=${mapping.resolved}`;
        if (lineIdx >= 0) {
          lines[lineIdx] = newLine;
        } else {
          lines.push(newLine);
        }
      }

      const newEnv = lines.join('\n') + '\n';
      const b64 = Buffer.from(newEnv).toString('base64');
      await execShell(fromContainer, `echo '${b64}' | base64 -d > ${envFile}`, { timeout: 5000 });

      // Restart the source container to pick up new env vars
      const { incusRequest } = await import('../incus/server');
      await incusRequest('PUT', `/1.0/instances/${fromContainer}/state`, {
        action: 'restart',
        force: false,
        timeout: 30,
      });
    } catch (err) {
      console.warn(`[bridges] Env injection failed for ${bridgeId}:`, err);
    }
  }

  const updated = await updateBridge(bridgeId, {
    active: true,
    activatedAt: new Date().toISOString(),
  });

  // Push updated connection state to UI (non-blocking)
  pushConnectionsToUI(bridge.from).catch(() => {});
  if (bridge.direction === 'both-ways') {
    pushConnectionsToUI(bridge.to).catch(() => {});
  }

  return updated;
}

/**
 * Deactivate a bridge: revoke network access.
 */
export async function deactivateBridge(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return null;

  const fromContainer = await resolveContainerName(bridge.from);
  const toContainer = await resolveContainerName(bridge.to);

  try {
    await revokeBridgeAccess(fromContainer, bridge.to);
    if (bridge.direction === 'both-ways') {
      await revokeBridgeAccess(toContainer, bridge.from);
    }
  } catch (err) {
    console.warn(`[bridges] Network access revocation failed for ${bridgeId}:`, err);
  }

  const updated = await updateBridge(bridgeId, { active: false });

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
  const bridge = await getBridge(bridgeId);
  if (!bridge) return false;

  if (bridge.active) {
    const fromContainer = await resolveContainerName(bridge.from);
    const toContainer = await resolveContainerName(bridge.to);

    try {
      await revokeBridgeAccess(fromContainer, bridge.to);
      if (bridge.direction === 'both-ways') {
        await revokeBridgeAccess(toContainer, bridge.from);
      }
    } catch (err) {
      console.warn(`[bridges] Network access cleanup failed during delete for ${bridge.id}:`, err);
    }
  }

  const removed = await removeBridge(bridgeId);

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
 * Called when a new app is installed. Checks for pending bridges
 * targeting this app and activates them.
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
  }

  return activated;
}

export { getBridgesForApp, loadBridges };
