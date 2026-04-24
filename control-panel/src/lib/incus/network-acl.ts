/**
 * Incus Network ACL Management — Per-Container Isolation (v2)
 *
 * Each app container gets its own ACL (ye-iso-{containerName}) that explicitly
 * whitelists only the destinations it needs: intra-app siblings, DNS (pihole),
 * reverse proxy (caddy), and optionally shared DB (postgres) and SSO (authentik).
 *
 * Bridge activation adds a destination rule to the source container's ACL.
 * Default egress is 'reject' (set on NIC device, not in ACL rules — see Option E
 * workaround for Incus rule-ordering bug).
 */

import { incusRequest } from './server';
import { getContainerIP } from './container-ip';

const ACL_SYSTEM = 'ye-system';
/** @deprecated — replaced by per-container ye-iso-* ACLs. Kept for migration detection. */
const ACL_APP = 'ye-app-isolated';

interface AclRule {
  action: 'allow' | 'reject' | 'drop';
  state: 'enabled' | 'disabled';
  source?: string;
  destination?: string;
  protocol?: string;
  source_port?: string;
  destination_port?: string;
  description?: string;
}

interface AclConfig {
  name: string;
  description: string;
  ingress: AclRule[];
  egress: AclRule[];
}

// System container names — never valid bridge targets
const SYSTEM_CONTAINERS = [
  'youeye-control', 'youeye-ui', 'youeye-caddy',
  'youeye-postgres', 'youeye-authentik', 'youeye-authentik-worker',
  'youeye-pihole',
];

// System app IDs — the short names used in manifests and bridge records
export const SYSTEM_APP_IDS = [
  'postgres', 'authentik', 'caddy', 'pihole', 'control', 'ui',
  'authentik-worker',
];

// ─── Low-level ACL helpers ──────────────────────────────────

async function aclExists(name: string): Promise<boolean> {
  try {
    const res = await incusRequest('GET', `/1.0/network-acls/${name}`);
    return res.status_code === 200;
  } catch {
    return false;
  }
}

async function getAclRules(name: string): Promise<{ ingress: AclRule[]; egress: AclRule[] }> {
  try {
    const res = await incusRequest<{ ingress: AclRule[]; egress: AclRule[] }>(
      'GET', `/1.0/network-acls/${name}`
    );
    return {
      ingress: res.metadata?.ingress ?? [],
      egress: res.metadata?.egress ?? [],
    };
  } catch {
    return { ingress: [], egress: [] };
  }
}

async function getBridgeSubnet(): Promise<string> {
  try {
    const res = await incusRequest<{
      config: Record<string, string>;
    }>('GET', '/1.0/networks/incusbr0');
    const addr = res.metadata?.config?.['ipv4.address'];
    if (addr) return addr;
  } catch {}
  return '10.27.59.0/24';
}

// ─── NIC helpers ─────────────────────────────────────────────

async function appendAclToContainer(containerName: string, aclName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }

    const existing = devices.eth0['security.acls'] || '';
    const aclList = existing.split(',').filter(Boolean);
    if (!aclList.includes(aclName)) {
      aclList.push(aclName);
    }
    devices.eth0['security.acls'] = aclList.join(',');

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to append ACL ${aclName} to ${containerName}:`, err);
  }
}

async function removeAclFromContainer(containerName: string, aclName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) return;

    const existing = devices.eth0['security.acls'] || '';
    const aclList = existing.split(',').filter(Boolean).filter(a => a !== aclName);
    devices.eth0['security.acls'] = aclList.join(',');

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to remove ACL ${aclName} from ${containerName}:`, err);
  }
}

// ─── System ACL (unchanged) ─────────────────────────────────

let _aclsInitialized = false;

export async function ensureNetworkAcls(): Promise<void> {
  if (_aclsInitialized) return;

  let created = false;

  // System ACL — unchanged
  if (!(await aclExists(ACL_SYSTEM))) {
    await incusRequest('POST', '/1.0/network-acls', {
      name: ACL_SYSTEM,
      description: 'System containers tag',
      ingress: [],
      egress: [],
    } as AclConfig);
    created = true;
  }

  if (created) {
    for (const name of SYSTEM_CONTAINERS) {
      await applySystemAcl(name);
    }
    console.log('[acl] System ACL initialized, system containers tagged');
  }

  // Migration: if the old shared ACL still exists and apps reference it, migrate
  if (await aclExists(ACL_APP)) {
    try {
      await migrateToPerContainerAcls();
    } catch (err) {
      console.error('[acl] Migration from ye-app-isolated failed:', err);
    }
  }

  _aclsInitialized = true;
}

export async function applySystemAcl(containerName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
      config: Record<string, string>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }
    devices.eth0['security.acls'] = ACL_SYSTEM;
    devices.eth0['security.acls.default.egress.action'] = 'allow';
    devices.eth0['security.acls.default.ingress.action'] = 'allow';

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to apply system ACL to ${containerName}:`, err);
  }
}

// ─── Per-Container ACL (v2) ──────────────────────────────────

/** ACL name for a specific container. */
export function containerAclName(containerName: string): string {
  return `ye-iso-${containerName}`;
}

export interface ContainerAclOptions {
  /** IPs of sibling containers in the same app */
  siblingIPs: string[];
  /** App needs access to shared postgres */
  needsSharedDb: boolean;
  /** App has SSO configured */
  needsSSO: boolean;
}

/**
 * Create a per-container ACL that explicitly whitelists only permitted destinations.
 * Attaches it to the container's NIC with default.egress.action = reject.
 *
 * ACL contains ONLY allow rules — the reject is handled by the NIC device default
 * (Option E workaround for Incus rule-ordering bug).
 */
export async function createContainerAcl(
  containerName: string,
  opts: ContainerAclOptions,
): Promise<string> {
  const aclName = containerAclName(containerName);

  // Remove stale ACL if it exists (idempotent recreate)
  if (await aclExists(aclName)) {
    // Detach from NIC first so Incus lets us delete it
    await removeAclFromContainer(containerName, aclName);
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  }

  const egress: AclRule[] = [];

  // 1. Intra-app siblings — each sibling IP, all ports
  for (const ip of opts.siblingIPs) {
    egress.push({
      action: 'allow',
      state: 'enabled',
      destination: ip + '/32',
      description: `Sibling container ${ip}`,
    });
  }

  // 2. DNS — pihole
  const piholeIP = await getContainerIP('youeye-pihole');
  if (piholeIP) {
    egress.push({
      action: 'allow',
      state: 'enabled',
      destination: piholeIP + '/32',
      protocol: 'udp',
      destination_port: '53',
      description: 'DNS (pihole UDP)',
    });
    egress.push({
      action: 'allow',
      state: 'enabled',
      destination: piholeIP + '/32',
      protocol: 'tcp',
      destination_port: '53',
      description: 'DNS (pihole TCP)',
    });
  }

  // 3. Reverse proxy — caddy (HTTP/HTTPS for internal service-to-service via proxy)
  const caddyIP = await getContainerIP('youeye-caddy');
  if (caddyIP) {
    egress.push({
      action: 'allow',
      state: 'enabled',
      destination: caddyIP + '/32',
      protocol: 'tcp',
      destination_port: '80',
      description: 'Caddy HTTP',
    });
    egress.push({
      action: 'allow',
      state: 'enabled',
      destination: caddyIP + '/32',
      protocol: 'tcp',
      destination_port: '443',
      description: 'Caddy HTTPS',
    });
  }

  // 4. Shared database — postgres
  if (opts.needsSharedDb) {
    const pgIP = await getContainerIP('youeye-postgres');
    if (pgIP) {
      egress.push({
        action: 'allow',
        state: 'enabled',
        destination: pgIP + '/32',
        protocol: 'tcp',
        destination_port: '5432',
        description: 'Shared PostgreSQL',
      });
    }
  }

  // 5. SSO — authentik
  if (opts.needsSSO) {
    const authIP = await getContainerIP('youeye-authentik');
    if (authIP) {
      egress.push({
        action: 'allow',
        state: 'enabled',
        destination: authIP + '/32',
        protocol: 'tcp',
        destination_port: '9000',
        description: 'Authentik SSO',
      });
      egress.push({
        action: 'allow',
        state: 'enabled',
        destination: authIP + '/32',
        protocol: 'tcp',
        destination_port: '9443',
        description: 'Authentik SSO (HTTPS)',
      });
    }
  }

  // Create the ACL (allow rules only)
  await incusRequest('POST', '/1.0/network-acls', {
    name: aclName,
    description: `Per-container isolation: ${containerName}`,
    ingress: [],
    egress,
  } as AclConfig);

  // Attach to container NIC with default egress reject
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }

    // Replace any existing ACL list with just the new per-container ACL
    // (internet ACLs will be appended separately if needed)
    const existing = devices.eth0['security.acls'] || '';
    const aclList = existing.split(',').filter(Boolean)
      .filter(a => a !== ACL_APP && !a.startsWith('ye-iso-') && !a.startsWith('ye-bridge-'));
    aclList.push(aclName);
    devices.eth0['security.acls'] = aclList.join(',');
    devices.eth0['security.acls.default.egress.action'] = 'reject';
    devices.eth0['security.acls.default.ingress.action'] = 'allow';

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to attach ACL to ${containerName}:`, err);
  }

  console.log(`[acl] Created per-container ACL ${aclName} (${egress.length} rules)`);
  return aclName;
}

/**
 * Add a bridge rule to a container's per-container ACL.
 * Resolves the target container's IP and adds an egress allow rule to that IP.
 */
export async function addBridgeRuleToAcl(
  containerName: string,
  targetContainerName: string,
): Promise<void> {
  const aclName = containerAclName(containerName);
  if (!(await aclExists(aclName))) {
    console.warn(`[acl] Cannot add bridge rule: ACL ${aclName} does not exist`);
    return;
  }

  const targetIP = await getContainerIP(targetContainerName);
  if (!targetIP) {
    console.warn(`[acl] Cannot resolve IP for ${targetContainerName}`);
    return;
  }

  const { egress } = await getAclRules(aclName);

  // Check if rule already exists
  const desc = `Bridge to ${targetContainerName}`;
  if (egress.some(r => r.description === desc)) {
    return; // Already has this bridge rule
  }

  egress.push({
    action: 'allow',
    state: 'enabled',
    destination: targetIP + '/32',
    description: desc,
  });

  await incusRequest('PUT', `/1.0/network-acls/${aclName}`, {
    description: `Per-container isolation: ${containerName}`,
    ingress: [],
    egress,
  });

  console.log(`[acl] Added bridge rule: ${containerName} → ${targetContainerName} (${targetIP})`);
}

/**
 * Remove a bridge rule from a container's per-container ACL.
 */
export async function removeBridgeRuleFromAcl(
  containerName: string,
  targetContainerName: string,
): Promise<void> {
  const aclName = containerAclName(containerName);
  if (!(await aclExists(aclName))) return;

  const { egress } = await getAclRules(aclName);
  const desc = `Bridge to ${targetContainerName}`;
  const filtered = egress.filter(r => r.description !== desc);

  if (filtered.length === egress.length) return; // Rule didn't exist

  await incusRequest('PUT', `/1.0/network-acls/${aclName}`, {
    description: `Per-container isolation: ${containerName}`,
    ingress: [],
    egress: filtered,
  });

  console.log(`[acl] Removed bridge rule: ${containerName} → ${targetContainerName}`);
}

/**
 * Delete a container's per-container ACL entirely (called on uninstall).
 */
export async function deleteContainerAcl(containerName: string): Promise<void> {
  const aclName = containerAclName(containerName);
  try {
    await removeAclFromContainer(containerName, aclName);
  } catch {
    // Container may already be deleted
  }
  if (await aclExists(aclName)) {
    try {
      await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
      console.log(`[acl] Deleted ACL ${aclName}`);
    } catch (err) {
      console.warn(`[acl] Failed to delete ACL ${aclName}:`, err);
    }
  }
}

// ─── Migration ───────────────────────────────────────────────

/**
 * Migrate from the old shared ye-app-isolated ACL to per-container ACLs.
 * Called automatically by ensureNetworkAcls() if the old ACL still exists.
 *
 * Strategy:
 * 1. List all installed apps from file-based metadata
 * 2. For each container, create a per-container ACL
 * 3. Attach new ACL to NIC, then remove old ACL from NIC
 * 4. Re-read active bridges and add bridge rules to new ACLs
 * 5. Delete old ye-app-isolated ACL and legacy ye-bridge-* ACLs
 */
async function migrateToPerContainerAcls(): Promise<void> {
  console.log('[acl] Starting migration from ye-app-isolated to per-container ACLs...');

  const { listInstalledApps, readInstallMetadata } = await import('../market/metadata');
  const { loadBridges } = await import('../bridges/store');

  const apps = await listInstalledApps();
  if (apps.length === 0) {
    // No apps installed — just delete the old ACL
    try {
      await incusRequest('DELETE', `/1.0/network-acls/${ACL_APP}`);
      console.log('[acl] Deleted empty ye-app-isolated (no apps installed)');
    } catch {}
    return;
  }

  // Build a map of containerName → container info for all installed apps
  const containerMap = new Map<string, {
    appId: string;
    siblingNames: string[];
    needsSharedDb: boolean;
    needsSSO: boolean;
  }>();

  for (const meta of apps) {
    const containers = (meta.containers || []).map(c =>
      typeof c === 'string' ? c : c.containerName
    );
    const needsSharedDb = (meta as any).databaseMode === 'shared';
    const needsSSO = meta.enableSSO || (meta as any).hasSSO || false;

    for (const cn of containers) {
      containerMap.set(cn, {
        appId: meta.appId,
        siblingNames: containers.filter(s => s !== cn),
        needsSharedDb,
        needsSSO,
      });
    }
  }

  // Create per-container ACLs
  let migrated = 0;
  for (const [containerName, info] of containerMap) {
    try {
      // Resolve sibling IPs
      const siblingIPs: string[] = [];
      for (const sib of info.siblingNames) {
        const ip = await getContainerIP(sib);
        if (ip) siblingIPs.push(ip);
      }

      await createContainerAcl(containerName, {
        siblingIPs,
        needsSharedDb: info.needsSharedDb,
        needsSSO: info.needsSSO,
      });
      migrated++;
    } catch (err) {
      console.warn(`[acl] Migration: failed to create ACL for ${containerName}:`, err);
    }
  }

  // Re-apply active bridge rules
  const bridges = await loadBridges();
  for (const bridge of bridges) {
    if (!bridge.active) continue;
    const fromContainer = `app-${bridge.from}`;
    const toContainer = `app-${bridge.to}`;
    try {
      await addBridgeRuleToAcl(fromContainer, toContainer);
      if (bridge.direction === 'both-ways') {
        await addBridgeRuleToAcl(toContainer, fromContainer);
      }
    } catch (err) {
      console.warn(`[acl] Migration: failed to re-apply bridge ${bridge.id}:`, err);
    }
  }

  // Clean up legacy bridge ACLs (ye-bridge-*)
  try {
    const aclListRes = await incusRequest<string[]>('GET', '/1.0/network-acls');
    const aclNames = (aclListRes.metadata || []).map((path: string) =>
      path.split('/').pop() || ''
    );
    for (const name of aclNames) {
      if (name.startsWith('ye-bridge-')) {
        // First remove from any container NICs
        try {
          const aclDetail = await incusRequest<{ used_by: string[] }>(
            'GET', `/1.0/network-acls/${name}`
          );
          for (const ref of aclDetail.metadata?.used_by || []) {
            const cn = ref.split('/').pop() || '';
            if (cn) await removeAclFromContainer(cn, name);
          }
        } catch {}
        try {
          await incusRequest('DELETE', `/1.0/network-acls/${name}`);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[acl] Migration: failed to clean up legacy bridge ACLs:', err);
  }

  // Delete the old shared ACL
  // First remove it from any container NICs that still reference it
  try {
    const aclDetail = await incusRequest<{ used_by: string[] }>(
      'GET', `/1.0/network-acls/${ACL_APP}`
    );
    for (const ref of aclDetail.metadata?.used_by || []) {
      const cn = ref.split('/').pop() || '';
      if (cn) await removeAclFromContainer(cn, ACL_APP);
    }
    await incusRequest('DELETE', `/1.0/network-acls/${ACL_APP}`);
    console.log(`[acl] Deleted legacy ${ACL_APP}`);
  } catch (err) {
    console.warn(`[acl] Migration: failed to delete ${ACL_APP}:`, err);
  }

  console.log(`[acl] Migration complete: ${migrated} containers migrated to per-container ACLs`);
}

// ─── Deprecated functions (kept for backward compat during transition) ──

/**
 * @deprecated Use createContainerAcl() instead. This applies the old shared ACL.
 */
export async function applyAppAcl(containerName: string): Promise<void> {
  console.warn(`[acl] DEPRECATED: applyAppAcl() called for ${containerName}. Use createContainerAcl() instead.`);
  // Fallback: create a minimal per-container ACL with no siblings
  await createContainerAcl(containerName, {
    siblingIPs: [],
    needsSharedDb: false,
    needsSSO: false,
  });
}

/**
 * @deprecated Use addBridgeRuleToAcl() instead.
 */
export async function createBridgeAcl(
  fromContainer: string,
  toContainer: string,
  direction: 'one-way' | 'both-ways',
): Promise<string> {
  console.warn('[acl] DEPRECATED: createBridgeAcl() called. Use addBridgeRuleToAcl() instead.');
  await addBridgeRuleToAcl(fromContainer, toContainer);
  if (direction === 'both-ways') {
    await addBridgeRuleToAcl(toContainer, fromContainer);
  }
  return `rule-in-${containerAclName(fromContainer)}`;
}

/**
 * @deprecated Use removeBridgeRuleFromAcl() instead.
 */
export async function removeBridgeAcl(aclName: string): Promise<void> {
  console.warn('[acl] DEPRECATED: removeBridgeAcl() called. Legacy bridge ACLs are no longer used.');
  // Try to delete as a legacy ACL
  try {
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  } catch {
    // ACL may not exist
  }
}

// ─── Internet access (unchanged) ────────────────────────────

/**
 * Grant internet access to an app container for specific hosts.
 * Creates a dedicated ACL with per-host egress allow rules.
 */
export async function grantInternetAccess(
  containerName: string,
  hosts: string[],
  blanket?: boolean,
): Promise<string> {
  const aclName = `ye-internet-${containerName}`;

  // Remove existing grant ACL if any
  if (await aclExists(aclName)) {
    await removeAclFromContainer(containerName, aclName);
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  }

  const egress: AclRule[] = [];

  if (blanket) {
    egress.push({
      action: 'allow',
      state: 'enabled',
      description: 'Blanket internet access',
    });
  } else {
    for (const host of hosts) {
      egress.push({
        action: 'allow',
        state: 'enabled',
        destination: host,
        protocol: 'tcp',
        destination_port: '443',
        description: `HTTPS to ${host}`,
      });
      egress.push({
        action: 'allow',
        state: 'enabled',
        destination: host,
        protocol: 'tcp',
        destination_port: '80',
        description: `HTTP to ${host}`,
      });
    }
  }

  await incusRequest('POST', '/1.0/network-acls', {
    name: aclName,
    description: `Internet grant: ${containerName} → ${blanket ? 'all' : hosts.join(', ')}`,
    ingress: [],
    egress,
  } as AclConfig);

  await appendAclToContainer(containerName, aclName);
  return aclName;
}

/**
 * Revoke internet access for an app container.
 */
export async function revokeInternetAccess(
  containerName: string,
  aclName: string,
): Promise<void> {
  await removeAclFromContainer(containerName, aclName);
  try {
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  } catch {
    // ACL may not exist
  }
}

export { ACL_SYSTEM, ACL_APP };
