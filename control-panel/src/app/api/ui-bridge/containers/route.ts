/**
 * UI Bridge: Containers List
 *
 * GET /api/ui-bridge/containers
 *
 * Returns a simplified list of all Incus containers with status and IPs.
 * Reuses existing Incus server library functions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { incusRequest } from '@/lib/incus/server';

interface ContainerNetwork {
  addresses?: Array<{
    family: string;
    address: string;
    scope: string;
  }>;
}

interface ContainerState {
  status: string;
  network?: Record<string, ContainerNetwork>;
}

interface ContainerInfo {
  name: string;
  type: string;
  status: string;
  created_at: string;
  profiles: string[];
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    // Get all instances
    const instancesResponse = await incusRequest<string[]>('GET', '/1.0/instances');
    const instancePaths = instancesResponse.metadata || [];

    const containers: Array<{
      name: string;
      status: string;
      type: string;
      ipv4: string | null;
      created_at: string;
      profiles: string[];
    }> = [];

    for (const path of instancePaths) {
      const name = path.split('/').pop();
      if (!name) continue;

      try {
        // Get instance details
        const instanceResponse = await incusRequest<ContainerInfo>(
          'GET',
          `/1.0/instances/${name}`
        );
        const instance = instanceResponse.metadata;

        // Get instance state for IP and status
        let ipv4: string | null = null;
        let status = instance?.status || 'unknown';

        try {
          const stateResponse = await incusRequest<ContainerState>(
            'GET',
            `/1.0/instances/${name}/state`
          );
          const state = stateResponse.metadata;
          status = state?.status || status;

          // Extract IPv4 address from eth0
          if (state?.network) {
            const eth0 = state.network['eth0'];
            if (eth0?.addresses) {
              const v4 = eth0.addresses.find(
                (a) => a.family === 'inet' && a.scope === 'global'
              );
              if (v4) {
                ipv4 = v4.address;
              }
            }
          }
        } catch {
          // State might not be available if container is stopped
        }

        containers.push({
          name: instance?.name || name,
          status: status.toLowerCase(),
          type: instance?.type || 'container',
          ipv4,
          created_at: instance?.created_at || '',
          profiles: instance?.profiles || [],
        });
      } catch (err) {
        console.error(`[UI Bridge] Failed to get container ${name}:`, err);
      }
    }

    return NextResponse.json({ containers });
  } catch (err) {
    console.error('[UI Bridge] Containers list error:', err);
    return NextResponse.json(
      { error: 'Failed to list containers' },
      { status: 500 }
    );
  }
}
