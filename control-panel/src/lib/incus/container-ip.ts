/**
 * Incus Container IP Utility
 *
 * For system containers (postgres, identity, caddy, pihole, ui, control),
 * returns the deterministic static IP computed from the incusbr0 subnet.
 * This avoids an API call and works even when the container is stopped.
 *
 * For every other container the address comes from host-side data only
 * (`hostSideNICAddress`): never from what the container reports about itself.
 */

import { incusRequest } from './server';
import { getSystemStaticIP } from './static-ips';
import { isUsableIPv4 } from './ipv4';
import { safeIncusFailure } from './readiness';

interface InstanceRecord {
  status?: string;
  config?: Record<string, string>;
  expanded_devices?: Record<string, Record<string, string>>;
}

interface NetworkLease {
  address?: string;
  hwaddr?: string;
  type?: string;
}

export interface HostSideNIC {
  /** The managed network the NIC is attached to. */
  network: string;
  /** The IPv4 address Incus assigned to it, or null while it has none. */
  address: string | null;
}

/**
 * The IPv4 address Incus itself gave `containerName`'s NIC `iface` (the NIC's
 * interface name; eth0 by default), from host-side data only: the NIC's fixed
 * `ipv4.address`, else the bridge's DHCP lease for the NIC's MAC address
 * (`GET /1.0/networks/<bridge>/leases`). Root in a container can add any
 * address to its interface, so the container's own report (`/state`) is never
 * used. App NICs have `security.ipv4_filtering`: Incus reserves one address per
 * NIC in dnsmasq and the filter lets the NIC use only that one, so the lease is
 * authoritative.
 *
 * Null when the instance does not exist, has no such NIC, or (unless
 * `allowStopped`) is not running; a lease outlives a stopped container.
 */
export async function hostSideNICAddress(
  containerName: string,
  iface = 'eth0',
  options: { allowStopped?: boolean } = {},
): Promise<HostSideNIC | null> {
  const response = await incusRequest<InstanceRecord>('GET', `/1.0/instances/${encodeURIComponent(containerName)}`);
  if (response.type === 'error' && (response.status_code === 404 || response.error_code === 404)) return null;
  if (response.type === 'error' || !response.metadata) {
    throw new Error(`Could not read instance ${containerName.replace(/[^a-zA-Z0-9_-]/g, '')}`);
  }
  const instance = response.metadata;
  if (!options.allowStopped && instance.status !== 'Running') return null;
  const entry = Object.entries(instance.expanded_devices ?? {})
    .find(([key, device]) => device.type === 'nic' && (device.name || key) === iface);
  if (!entry) return null;
  const [deviceName, device] = entry;
  const network = device.network || device.parent;
  if (!network) return null;
  if (device['ipv4.address']) return { network, address: device['ipv4.address'] };
  const hwaddr = (device.hwaddr || instance.config?.[`volatile.${deviceName}.hwaddr`] || '').toLowerCase();
  if (!hwaddr) return { network, address: null };
  const leases = await incusRequest<NetworkLease[]>('GET', `/1.0/networks/${encodeURIComponent(network)}/leases`);
  if (leases.type === 'error' || !Array.isArray(leases.metadata)) {
    throw new Error(`Could not read the leases of ${network.replace(/[^a-zA-Z0-9_-]/g, '')}`);
  }
  const addresses = [...new Set(leases.metadata
    .filter((lease) => (lease.hwaddr ?? '').toLowerCase() === hwaddr && /^\d{1,3}(\.\d{1,3}){3}$/.test(lease.address ?? ''))
    .map((lease) => lease.address!))];
  if (addresses.length > 1) {
    throw new Error(`${containerName.replace(/[^a-zA-Z0-9_-]/g, '')} has more than one IPv4 lease on ${network.replace(/[^a-zA-Z0-9_-]/g, '')}`);
  }
  return { network, address: addresses[0] ?? null };
}

/**
 * Get a container's IPv4 address.
 * System containers use deterministic static IPs (fast, works when stopped).
 * Other containers: the host-side address of a running container's NIC
 * (`iface`, default eth0); see `hostSideNICAddress`.
 */
export async function getContainerIP(
  containerName: string,
  options: { required?: boolean; iface?: string } = {},
): Promise<string | null> {
  const failures: string[] = [];
  // Fast path: system containers have deterministic static IPs
  if (!options.iface) try {
    const staticIP = await getSystemStaticIP(containerName);
    if (staticIP && isUsableIPv4(staticIP)) return staticIP;
    if (staticIP) failures.push('static: INVALID_IPV4');
  } catch (error) {
    failures.push(`static: ${safeIncusFailure(error)}`);
  }

  try {
    const nic = await hostSideNICAddress(containerName, options.iface ?? 'eth0');
    if (nic?.address && isUsableIPv4(nic.address)) return nic.address;
  } catch (error) {
    failures.push(`host: ${safeIncusFailure(error)}`);
  }
  if (options.required) {
    throw new Error(`Managed container ${containerName.replace(/[^a-zA-Z0-9_-]/g, '')} IPv4 discovery failed (${failures.join('; ') || 'no usable IPv4 lease'}); existing routes retained`);
  }
  return null;
}
