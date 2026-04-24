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
  addBridgeRuleToAcl, removeBridgeRuleFromAcl, ensureNetworkAcls,
  SYSTEM_APP_IDS,
} from '../incus/network-acl';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import { execShell } from '../incus/server';
import { CONTAINER_DOMAIN } from '../market/constants';

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
 */
export function resolveBridgeMappings(
  envMappings: EnvMapping[],
  targetContainerName: string,
  targetPort: number,
  targetSubdomain: string,
  domain: string,
): EnvMapping[] {
  return envMappings.map(m => {
    let resolved = m.template;
    const target = m.template.match(/\$\{containers\.([^.]+)\.([^}]+)\}/);
    if (target) {
      const prop = target[2];
      switch (prop) {
        case 'internal_host':
          resolved = `${targetContainerName}.${CONTAINER_DOMAIN}`;
          break;
        case 'internal_url':
          resolved = `http://${targetContainerName}.${CONTAINER_DOMAIN}:${targetPort}`;
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
 * Activate a bridge: create ACL rule + inject env vars + restart source container.
 */
export async function activateBridge(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge || bridge.active) return bridge;

  await ensureNetworkAcls();

  // Add bridge rule to the source container's per-container ACL
  const fromContainer = `app-${bridge.from}`;
  const toContainer = `app-${bridge.to}`;

  let aclName: string | undefined;
  try {
    await addBridgeRuleToAcl(fromContainer, toContainer);
    if (bridge.direction === 'both-ways') {
      await addBridgeRuleToAcl(toContainer, fromContainer);
    }
    aclName = `rule-in-ye-iso-${fromContainer}`;
  } catch (err) {
    console.warn(`[bridges] ACL rule addition failed for ${bridgeId}:`, err);
  }

  // Inject resolved env vars into source container
  const resolvedMappings = bridge.envMappings.filter(m => m.resolved);
  if (resolvedMappings.length > 0) {
    try {
      const envFile = `/etc/app-${bridge.from}.env`;
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

  return updateBridge(bridgeId, {
    active: true,
    aclName,
    activatedAt: new Date().toISOString(),
  });
}

/**
 * Deactivate a bridge: remove ACL rule.
 */
export async function deactivateBridge(bridgeId: string): Promise<Bridge | null> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return null;

  const fromContainer = `app-${bridge.from}`;
  const toContainer = `app-${bridge.to}`;

  try {
    await removeBridgeRuleFromAcl(fromContainer, toContainer);
    if (bridge.direction === 'both-ways') {
      await removeBridgeRuleFromAcl(toContainer, fromContainer);
    }
  } catch (err) {
    console.warn(`[bridges] ACL rule removal failed for ${bridgeId}:`, err);
  }

  return updateBridge(bridgeId, { active: false, aclName: undefined });
}

/**
 * Delete a bridge entirely.
 */
export async function deleteBridge(bridgeId: string): Promise<boolean> {
  const bridge = await getBridge(bridgeId);
  if (!bridge) return false;

  if (bridge.active) {
    const fromContainer = `app-${bridge.from}`;
    const toContainer = `app-${bridge.to}`;
    try {
      await removeBridgeRuleFromAcl(fromContainer, toContainer);
      if (bridge.direction === 'both-ways') {
        await removeBridgeRuleFromAcl(toContainer, fromContainer);
      }
    } catch (err) {
      console.warn(`[bridges] ACL rule removal failed during delete for ${bridge.id}:`, err);
    }
  }

  return removeBridge(bridgeId);
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
    const resolvedMappings = resolveBridgeMappings(
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
