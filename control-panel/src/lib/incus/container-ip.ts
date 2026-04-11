/**
 * Incus Container IP Utility
 * 
 * Utility function to get a container's IPv4 address
 */

import { incusRequest } from './server';

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
 * Get a container's IPv4 address
 */
export async function getContainerIP(containerName: string): Promise<string | null> {
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
