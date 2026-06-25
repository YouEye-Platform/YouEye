/**
 * App Status API
 * 
 * Returns the status of a specific app.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getAppManifest } from '@/lib/apps/manifest';
import type { AppManifest } from '@/lib/apps/manifest';
import { containerStatusToAppStatus } from '@/lib/apps/registry';
import { incusRequest } from '@/lib/incus/server';
import type { AppInstance } from '@/types/apps';

interface ContainerMetadata {
  status: string;
  status_code: number;
}

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    // Check authentication
    const session = await getSession();
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { name } = await params;

    // Get app manifest
    const manifest = getAppManifest(name);
    if (!manifest) {
      return NextResponse.json(
        { error: `Unknown app: ${name}` },
        { status: 404 }
      );
    }

    // Check container status
    try {
      const containerResponse = await incusRequest<ContainerMetadata>(
        'GET',
        `/1.0/instances/${manifest.containerName}`
      );

      if (containerResponse.status_code !== 200 || !containerResponse.metadata) {
        const appInstance: AppInstance = {
          manifest,
          status: 'not-installed',
        };
        return NextResponse.json(appInstance);
      }

      // Get container state for more details
      const stateResponse = await incusRequest<StateMetadata>(
        'GET',
        `/1.0/instances/${manifest.containerName}/state`
      );

      const containerStatus = containerResponse.metadata.status;
      const state = stateResponse.metadata;

      // Find IPv4 address
      let ipv4: string | undefined;
      if (state?.network) {
        for (const [, net] of Object.entries(state.network)) {
          const addr = net.addresses?.find((a) => 
            a.family === 'inet' && a.scope === 'global'
          );
          if (addr) {
            ipv4 = addr.address;
            break;
          }
        }
      }

      const appInstance: AppInstance = {
        manifest,
        status: containerStatusToAppStatus(containerStatus),
        containerStatus: {
          status: containerStatus,
          statusCode: containerResponse.metadata.status_code,
          ipv4,
        },
      };

      return NextResponse.json(appInstance);
    } catch {
      // Container doesn't exist
      const appInstance: AppInstance = {
        manifest,
        status: 'not-installed',
      };
      return NextResponse.json(appInstance);
    }
  } catch (error) {
    console.error('Error getting app status:', error);
    return NextResponse.json(
      { error: 'Failed to get app status' },
      { status: 500 }
    );
  }
}
