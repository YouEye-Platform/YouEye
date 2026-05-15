/**
 * Incus Container IP Utility
 *
 * For system containers (postgres, authentik, caddy, pihole, ui, control),
 * returns the deterministic static IP computed from the incusbr0 subnet.
 * This avoids an API call and works even when the container is stopped.
 *
 * For non-system containers, falls back to querying the Incus state API.
 */

import { incusRequest } from './server';
import { getSystemStaticIP } from './static-ips';

interface NetworkInfo {
  addresses?: Array<{
    family: string;
    address: string;
    scope?: string;
  }>;
}

interface StateMetadata {
  status: string;
  status_code: number;
  network?: Record<string, NetworkInfo>;
}

/**
 * Get a container's IPv4 address.
 * System containers use deterministic static IPs (fast, works when stopped).
 * Non-system containers query the Incus state API.
 */
export async function getContainerIP(containerName: string): Promise<string | null> {
  // Fast path: system containers have deterministic static IPs
  try {
    const staticIP = await getSystemStaticIP(containerName);
    if (staticIP) return staticIP;
  } catch {
    // Static IP lookup failed — fall through to dynamic lookup
  }

  // Slow path: query Incus API for non-system containers
  try {
    const state = await incusRequest<StateMetadata>(
      'GET',
      `/1.0/instances/${containerName}/state`
    );

    if (state.metadata?.network) {
      for (const [, net] of Object.entries(state.metadata.network)) {
        const addr = net.addresses?.find((a) =>
          a.family === 'inet' && a.scope === 'global'
        );
        if (addr) {
          return addr.address;
        }
      }
    }
  } catch {
    // Container might not exist or not running
  }
  return null;
}
