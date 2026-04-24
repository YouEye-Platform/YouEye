/**
 * Per-App Bridge Network Manager
 *
 * Each app gets its own Incus bridge (ye-appnet-{appId}) with a unique /24 subnet.
 * Isolation is structural: bridges can't communicate by default.
 * Permissions are NIC links: hot-plug a NIC onto the target bridge = access granted.
 *
 * System services (postgres, authentik, UI API) are exposed to app containers
 * via Incus proxy devices at localhost:{port} — no shared bridge needed.
 *
 * Caddy joins every app bridge (Docker/Traefik model) so reverse proxy routes
 * keep working with DNS names.
 *
 * DNS: bridge dnsmasq → pihole (via raw.dnsmasq server= directive) → LAN DNS.
 */

import { incusRequest } from './server';
import { getContainerIP } from './container-ip';

// ─── Constants ──────────────────────────────────────────────

/**
 * Bridge naming: `yeapp{N}` where N is the subnet number (1-254).
 * Linux network interface names are limited to 15 characters.
 * `ye-appnet-{appId}` would exceed this for most app IDs.
 * The subnet registry maps appId ↔ N for programmatic lookup.
 * The bridge description stores the appId for human readability.
 */
const BRIDGE_PREFIX = 'yeapp';

/** Subnet base: 10.76.{N}.0/24 — N ranges from 1 to 254 */
const SUBNET_BASE = '10.76';

/** Registry file for allocated subnets */
const REGISTRY_PATH = '/var/lib/youeye/networks/subnets.json';

/** System containers that live on incusbr0 (never moved to per-app bridges) */
const SYSTEM_CONTAINERS = [
  'youeye-control', 'youeye-ui', 'youeye-caddy',
  'youeye-postgres', 'youeye-authentik', 'youeye-authentik-worker',
  'youeye-pihole',
];

// ─── Subnet Registry ───────────────────────────────────────

interface SubnetRegistry {
  next: number;
  allocated: Record<string, number>; // appId → subnet number
}

async function readRegistry(): Promise<SubnetRegistry> {
  try {
    const { readFile } = await import('fs/promises');
    const data = await readFile(REGISTRY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { next: 1, allocated: {} };
  }
}

async function writeRegistry(registry: SubnetRegistry): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
  await mkdir('/var/lib/youeye/networks', { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Allocate the next available subnet number for an app.
 * Returns the subnet number (1-254).
 */
async function allocateSubnet(appId: string): Promise<number> {
  const registry = await readRegistry();

  // Already allocated?
  if (registry.allocated[appId] !== undefined) {
    return registry.allocated[appId];
  }

  // Find next available number
  const used = new Set(Object.values(registry.allocated));
  let n = registry.next;
  while (used.has(n) && n <= 254) n++;
  if (n > 254) throw new Error('Subnet exhaustion: no available subnets (max 254)');

  registry.allocated[appId] = n;
  registry.next = n + 1;
  await writeRegistry(registry);
  return n;
}

/**
 * Free a subnet allocation for an app.
 */
async function freeSubnet(appId: string): Promise<void> {
  const registry = await readRegistry();
  delete registry.allocated[appId];
  await writeRegistry(registry);
}

// ─── Bridge Name Helpers ────────────────────────────────────

/**
 * Get the Incus bridge name for an app.
 * Uses the subnet number from the registry: `yeapp{N}`.
 * Returns null if the app has no allocated subnet.
 */
export async function getAppBridgeName(appId: string): Promise<string | null> {
  const registry = await readRegistry();
  const n = registry.allocated[appId];
  if (n === undefined) return null;
  return `${BRIDGE_PREFIX}${n}`;
}

/** Build bridge name from a known subnet number. */
function bridgeNameFromSubnet(n: number): string {
  return `${BRIDGE_PREFIX}${n}`;
}

/** Check if a bridge exists. */
async function bridgeExists(name: string): Promise<boolean> {
  try {
    const res = await incusRequest('GET', `/1.0/networks/${name}`);
    return res.status_code === 200;
  } catch {
    return false;
  }
}

// ─── Core Bridge Operations ─────────────────────────────────

/**
 * Create a per-app bridge network.
 *
 * Creates an Incus managed bridge with:
 * - Unique /24 subnet from the 10.76.x.0 range
 * - DNS domain "youeye" (same as incusbr0 — container names are globally unique)
 * - DNS forwarding to pihole via raw.dnsmasq
 * - Optional NAT for internet access
 */
export async function createAppNetwork(
  appId: string,
  options: { nat?: boolean } = {},
): Promise<{ bridgeName: string; subnet: number; subnetCIDR: string }> {
  const n = await allocateSubnet(appId);
  const bridgeName = bridgeNameFromSubnet(n);

  // Already exists?
  if (await bridgeExists(bridgeName)) {
    return {
      bridgeName,
      subnet: n,
      subnetCIDR: `${SUBNET_BASE}.${n}.0/24`,
    };
  }

  const subnetCIDR = `${SUBNET_BASE}.${n}.0/24`;
  const gatewayIP = `${SUBNET_BASE}.${n}.1/24`;

  // Resolve pihole IP for DNS forwarding
  const piholeIP = await getContainerIP('youeye-pihole');
  if (!piholeIP) {
    console.warn('[app-network] Pihole IP not found — DNS forwarding will not work');
  }

  const config: Record<string, string> = {
    'ipv4.address': gatewayIP,
    'ipv4.dhcp': 'true',
    'ipv4.nat': options.nat ? 'true' : 'false',
    'ipv6.address': 'none',
    'dns.domain': 'youeye',
  };

  // Forward unresolved DNS queries to pihole
  if (piholeIP) {
    config['raw.dnsmasq'] = `server=${piholeIP}`;
  }

  await incusRequest('POST', '/1.0/networks', {
    name: bridgeName,
    description: `App network: ${appId}`,
    type: 'bridge',
    config,
  });

  console.log(`[app-network] Created bridge ${bridgeName} (${subnetCIDR}, nat=${options.nat ?? false})`);

  return { bridgeName, subnet: n, subnetCIDR };
}

/**
 * Delete a per-app bridge network and free its subnet.
 * Bridge must have no containers attached (delete containers first).
 */
export async function deleteAppNetwork(appId: string): Promise<void> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) {
    await freeSubnet(appId);
    return;
  }

  if (await bridgeExists(bridgeName)) {
    try {
      await incusRequest('DELETE', `/1.0/networks/${bridgeName}`);
      console.log(`[app-network] Deleted bridge ${bridgeName}`);
    } catch (err) {
      console.warn(`[app-network] Failed to delete bridge ${bridgeName}:`, err);
    }
  }

  await freeSubnet(appId);
}

/**
 * Enable or disable NAT (internet access) on an app's bridge.
 * NAT is enabled during install so containers can pull packages/images,
 * then disabled post-install for apps that don't declare `network: internet`.
 */
export async function setAppNetworkNAT(appId: string, enable: boolean): Promise<void> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) return;

  try {
    await incusRequest('PATCH', `/1.0/networks/${bridgeName}`, {
      config: { 'ipv4.nat': enable ? 'true' : 'false' },
    });
    console.log(`[app-network] NAT ${enable ? 'enabled' : 'disabled'} on ${bridgeName}`);
  } catch (err) {
    console.warn(`[app-network] Failed to set NAT on ${bridgeName}:`, err);
  }
}

// ─── Caddy NIC Management ──────────────────────────────────

/**
 * Hot-plug a NIC onto youeye-caddy connecting it to an app bridge.
 * This is the Docker/Traefik model: the reverse proxy joins every backend network.
 */
export async function addCaddyToAppNetwork(appId: string): Promise<void> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) {
    console.warn(`[app-network] No bridge found for ${appId}`);
    return;
  }

  const deviceName = `net-${appId}`;

  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', '/1.0/instances/youeye-caddy');

    const devices = { ...res.metadata.devices };

    // Already has this NIC?
    if (devices[deviceName]) return;

    // NIC interface name inside container: max 15 chars
    // Use truncated appId to keep it readable
    const ifName = `eth-${appId.substring(0, 11)}`;

    devices[deviceName] = {
      type: 'nic',
      network: bridgeName,
      name: ifName,
    };

    await incusRequest('PATCH', '/1.0/instances/youeye-caddy', { devices });
    console.log(`[app-network] Added Caddy NIC for ${bridgeName} (${appId})`);
  } catch (err) {
    console.warn(`[app-network] Failed to add Caddy NIC for ${appId}:`, err);
  }
}

/**
 * Remove Caddy's NIC from an app bridge.
 */
export async function removeCaddyFromAppNetwork(appId: string): Promise<void> {
  const deviceName = `net-${appId}`;

  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', '/1.0/instances/youeye-caddy');

    const devices = { ...res.metadata.devices };
    if (!devices[deviceName]) return;

    delete devices[deviceName];
    await incusRequest('PUT', '/1.0/instances/youeye-caddy', {
      ...res.metadata,
      devices,
    });
    console.log(`[app-network] Removed Caddy NIC for ${appId}`);
  } catch (err) {
    console.warn(`[app-network] Failed to remove Caddy NIC for ${appId}:`, err);
  }
}

// ─── Proxy Device Management ───────────────────────────────

/** Service definitions for proxy devices */
interface ProxyService {
  name: string;
  containerName: string;
  port: number;
  /** Port to listen on inside the app container (defaults to same as service port) */
  listenPort?: number;
}

/**
 * Standard system services available via proxy devices.
 * Each proxy makes the service accessible at localhost:{port} inside the app container.
 */
export async function getSystemServices(options: {
  needsSharedDb: boolean;
  needsSSO: boolean;
}): Promise<ProxyService[]> {
  const services: ProxyService[] = [];

  // Platform UI API — all apps need this (header, notifications, settings, timeline)
  services.push({
    name: 'ui-proxy',
    containerName: 'youeye-ui',
    port: 3000,
    listenPort: 3001, // App itself runs on 3000, so UI proxy listens on 3001
  });

  // Shared PostgreSQL
  if (options.needsSharedDb) {
    services.push({
      name: 'pg-proxy',
      containerName: 'youeye-postgres',
      port: 5432,
    });
  }

  // Authentik SSO
  if (options.needsSSO) {
    services.push({
      name: 'auth-proxy',
      containerName: 'youeye-authentik',
      port: 9000,
    });
    services.push({
      name: 'auth-proxy-tls',
      containerName: 'youeye-authentik',
      port: 9443,
    });
  }

  return services;
}

/**
 * Add proxy devices to a container for system services.
 * Each proxy makes a system service accessible at localhost:{port} inside the container.
 *
 * Proxy devices are Incus-managed userspace TCP proxies. The proxy runs on the HOST
 * (which can reach both incusbr0 and the app bridge), so the app container doesn't
 * need any NIC on incusbr0.
 *
 * Performance: <1ms latency per connection. Fine for web apps.
 */
export async function addProxyDevices(
  containerName: string,
  services: ProxyService[],
): Promise<void> {
  if (services.length === 0) return;

  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);

    const devices = { ...res.metadata.devices };

    for (const svc of services) {
      const serviceIP = await getContainerIP(svc.containerName);
      if (!serviceIP) {
        console.warn(`[app-network] Cannot resolve IP for ${svc.containerName}, skipping proxy`);
        continue;
      }

      const listenPort = svc.listenPort ?? svc.port;
      devices[svc.name] = {
        type: 'proxy',
        bind: 'instance',
        listen: `tcp:0.0.0.0:${listenPort}`,
        connect: `tcp:${serviceIP}:${svc.port}`,
      };
    }

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
    console.log(`[app-network] Added ${services.length} proxy devices to ${containerName}`);
  } catch (err) {
    console.warn(`[app-network] Failed to add proxy devices to ${containerName}:`, err);
  }
}

/**
 * Remove all proxy devices from a container (cleanup on uninstall).
 */
export async function removeProxyDevices(containerName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);

    const devices = { ...res.metadata.devices };
    let removed = 0;

    for (const [name, device] of Object.entries(devices)) {
      if (device.type === 'proxy' && device.bind === 'instance') {
        delete devices[name];
        removed++;
      }
    }

    if (removed > 0) {
      await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
      console.log(`[app-network] Removed ${removed} proxy devices from ${containerName}`);
    }
  } catch {
    // Container may already be deleted
  }
}

// ─── Cross-App NIC Permissions ──────────────────────────────

/**
 * Grant a container access to another app's bridge by hot-plugging a NIC.
 * This is the NIC-based permission model: NIC on bridge = access granted.
 *
 * The container gets a new network interface that connects it to the target bridge.
 * systemd-resolved automatically picks up the new DNS server (the target bridge's
 * dnsmasq), so container names on the target bridge resolve immediately.
 */
export async function grantBridgeAccess(
  containerName: string,
  targetAppId: string,
): Promise<void> {
  const targetBridge = await getAppBridgeName(targetAppId);
  if (!targetBridge) {
    console.warn(`[app-network] No bridge found for target ${targetAppId}`);
    return;
  }

  const deviceName = `net-${targetAppId}`;

  if (!(await bridgeExists(targetBridge))) {
    console.warn(`[app-network] Target bridge ${targetBridge} does not exist`);
    return;
  }

  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);

    const devices = { ...res.metadata.devices };
    if (devices[deviceName]) return; // Already has access

    devices[deviceName] = {
      type: 'nic',
      network: targetBridge,
      name: `eth-${targetAppId.substring(0, 11)}`,
    };

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
    console.log(`[app-network] Granted ${containerName} access to ${targetBridge} (${targetAppId})`);
  } catch (err) {
    console.warn(`[app-network] Failed to grant bridge access to ${containerName}:`, err);
  }
}

/**
 * Revoke a container's access to another app's bridge by removing the NIC.
 */
export async function revokeBridgeAccess(
  containerName: string,
  targetAppId: string,
): Promise<void> {
  const deviceName = `net-${targetAppId}`;

  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);

    const devices = { ...res.metadata.devices };
    if (!devices[deviceName]) return; // Doesn't have access

    delete devices[deviceName];
    // Use PUT with full metadata to properly remove the device
    await incusRequest('PUT', `/1.0/instances/${containerName}`, {
      ...res.metadata,
      devices,
    });
    console.log(`[app-network] Revoked ${containerName} access to ye-appnet-${targetAppId}`);
  } catch (err) {
    console.warn(`[app-network] Failed to revoke bridge access from ${containerName}:`, err);
  }
}

// ─── Container NIC Configuration ────────────────────────────

/**
 * Build NIC device config for a container on a per-app bridge.
 * Returns the device map to include in container creation payload.
 * Requires the bridge to already exist (subnet allocated).
 */
export async function buildAppNIC(appId: string): Promise<Record<string, Record<string, string>>> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) {
    throw new Error(`No bridge allocated for app ${appId} — call createAppNetwork() first`);
  }
  return {
    eth0: {
      type: 'nic',
      network: bridgeName,
      name: 'eth0',
    },
  };
}

/**
 * Change a running container's NIC from one network to another.
 * Used during migration from incusbr0 to per-app bridge.
 * The container must be stopped first.
 */
export async function switchContainerNetwork(
  containerName: string,
  newBridgeName: string,
): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
      config: Record<string, string>;
    }>('GET', `/1.0/instances/${containerName}`);

    const instance = res.metadata;
    const devices = { ...instance.devices };

    // Remove ACL-related properties from eth0 (they belonged to the old system)
    if (devices.eth0) {
      delete devices.eth0['security.acls'];
      delete devices.eth0['security.acls.default.egress.action'];
      delete devices.eth0['security.acls.default.ingress.action'];
    } else {
      devices.eth0 = { type: 'nic', name: 'eth0' };
    }

    devices.eth0.network = newBridgeName;

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
    console.log(`[app-network] Switched ${containerName} to ${newBridgeName}`);
  } catch (err) {
    console.warn(`[app-network] Failed to switch network for ${containerName}:`, err);
    throw err;
  }
}

// ─── Migration Helper ───────────────────────────────────────

/**
 * Migrate an existing app from incusbr0 to a per-app bridge.
 *
 * Steps:
 * 1. Create the app bridge
 * 2. Stop container(s)
 * 3. Switch NIC from incusbr0 to app bridge
 * 4. Add proxy devices for system services
 * 5. Start container(s)
 * 6. Add Caddy NIC to app bridge
 * 7. Verify container is reachable
 */
export async function migrateAppToPerAppBridge(
  appId: string,
  containerNames: string[],
  options: {
    nat: boolean;
    needsSharedDb: boolean;
    needsSSO: boolean;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. Create bridge
    const { bridgeName } = await createAppNetwork(appId, { nat: options.nat });

    // 2. Stop containers
    for (const cn of containerNames) {
      try {
        await incusRequest('PUT', `/1.0/instances/${cn}/state`, {
          action: 'stop', force: true, timeout: 30,
        });
        await new Promise(r => setTimeout(r, 2000));
      } catch {
        // May already be stopped
      }
    }

    // 3. Switch NICs
    for (const cn of containerNames) {
      await switchContainerNetwork(cn, bridgeName);
    }

    // 4. Add proxy devices
    const services = await getSystemServices({
      needsSharedDb: options.needsSharedDb,
      needsSSO: options.needsSSO,
    });
    for (const cn of containerNames) {
      await addProxyDevices(cn, services);
    }

    // 5. Start containers
    for (const cn of containerNames) {
      const startResult = await incusRequest('PUT', `/1.0/instances/${cn}/state`, {
        action: 'start',
      });
      if (startResult.type === 'async' && startResult.operation) {
        try {
          await incusRequest('GET', `${startResult.operation}/wait?timeout=30`, undefined, { timeout: 40_000 });
        } catch {}
      }
    }

    // 6. Add Caddy NIC
    await addCaddyToAppNetwork(appId);

    // 7. Wait for containers to get IPs
    await new Promise(r => setTimeout(r, 5000));

    // Verify at least the first container got an IP on the new bridge
    const firstIP = await getContainerIP(containerNames[0]);
    if (!firstIP) {
      return { success: false, error: `Container ${containerNames[0]} has no IP after migration` };
    }

    console.log(`[app-network] Migration complete: ${appId} → ${bridgeName} (${containerNames.length} containers)`);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Query Helpers ──────────────────────────────────────────

/**
 * List all per-app bridges.
 */
export async function listAppNetworks(): Promise<Array<{
  appId: string;
  bridgeName: string;
  subnet: number;
}>> {
  const registry = await readRegistry();
  return Object.entries(registry.allocated).map(([appId, subnet]) => ({
    appId,
    bridgeName: bridgeNameFromSubnet(subnet),
    subnet,
  }));
}

/**
 * Check if an app has a per-app bridge.
 */
export async function hasAppNetwork(appId: string): Promise<boolean> {
  const registry = await readRegistry();
  return appId in registry.allocated;
}

export { SYSTEM_CONTAINERS, BRIDGE_PREFIX };
