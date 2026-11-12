/**
 * Incus Container IP Utility
 *
 * For system containers (postgres, identity, caddy, pihole, ui, control),
 * returns the deterministic static IP computed from the incusbr0 subnet.
 * This avoids an API call and works even when the container is stopped.
 *
 * For non-system containers, falls back to querying the Incus state API.
 */

import { incusRequest } from './server';
import { getSystemStaticIP } from './static-ips';
import { isUsableIPv4 } from './ipv4';
import { safeIncusFailure } from './readiness';

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
export async function getContainerIP(containerName: string, options: { required?: boolean } = {}): Promise<string | null> {
  const failures: string[] = [];
  // Fast path: system containers have deterministic static IPs
  try {
    const staticIP = await getSystemStaticIP(containerName);
    if (staticIP && isUsableIPv4(staticIP)) return staticIP;
    if (staticIP) failures.push('static: INVALID_IPV4');
  } catch (error) {
    failures.push(`static: ${safeIncusFailure(error)}`);
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
          a.family === 'inet' && a.scope === 'global' && isUsableIPv4(a.address)
        );
        if (addr) {
          return addr.address;
        }
      }
    }
  } catch (error) {
    failures.push(`live: ${safeIncusFailure(error)}`);
  }
  if (options.required) {
    throw new Error(`Managed container ${containerName.replace(/[^a-zA-Z0-9_-]/g, '')} IPv4 discovery failed (${failures.join('; ') || 'no usable global IPv4'}); existing routes retained`);
  }
  return null;
}
