/**
 * Static IP management for system containers on incusbr0.
 *
 * System containers get deterministic IPs in the .10–.19 range of whatever
 * /24 subnet Incus auto-assigns to incusbr0. This eliminates the failure
 * mode where proxy devices (baked at install time with a system container's
 * DHCP IP) break silently when the system container restarts with a new IP.
 *
 * These offsets MUST match spine/internal/incus/static_ips.go.
 */

import { incusRequest } from './server';

/** Static IP offsets within the incusbr0 /24 subnet. */
export const SYSTEM_IP_OFFSETS: Record<string, number> = {
  'youeye-postgres': 10,
  'youeye-authentik': 11,
  'youeye-authentik-worker': 12,
  'youeye-caddy': 13,
  'youeye-pihole': 14,
  'youeye-ui': 15,
  'youeye-control': 16,
};

/** Cached subnet base to avoid repeated API calls. */
let cachedSubnetBase: string | null = null;

/**
 * Read the incusbr0 bridge configuration and extract the subnet base
 * (e.g., "10.75.26" from "10.75.26.1/24").
 */
export async function getSubnetBase(): Promise<string> {
  if (cachedSubnetBase) return cachedSubnetBase;

  const resp = await incusRequest<{
    config: Record<string, string>;
  }>('GET', '/1.0/networks/incusbr0');

  const addr = resp.metadata?.config?.['ipv4.address'];
  if (!addr) throw new Error('Cannot read incusbr0 ipv4.address');

  // Parse "10.75.26.1/24" → "10.75.26"
  const ip = addr.split('/')[0];
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Unexpected incusbr0 address format: ${addr}`);

  cachedSubnetBase = parts.slice(0, 3).join('.');
  return cachedSubnetBase;
}

/**
 * Get the static IP for a system container.
 * Returns null if the container is not a known system container.
 */
export async function getSystemStaticIP(containerName: string): Promise<string | null> {
  const offset = SYSTEM_IP_OFFSETS[containerName];
  if (offset === undefined) return null;

  const base = await getSubnetBase();
  return `${base}.${offset}`;
}

/**
 * Apply a static IP device override to a system container via the Incus API.
 * Must be called AFTER container creation but BEFORE starting it.
 * The container inherits eth0 from the default profile; this override
 * adds ipv4.address to pin it to a deterministic IP.
 */
export async function applyStaticIP(containerName: string): Promise<void> {
  const ip = await getSystemStaticIP(containerName);
  if (!ip) return; // Not a system container — no static IP needed

  await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
    devices: {
      eth0: {
        type: 'nic',
        network: 'incusbr0',
        name: 'eth0',
        'ipv4.address': ip,
      },
    },
  });

  console.log(`[static-ips] Assigned ${ip} to ${containerName}`);
}
