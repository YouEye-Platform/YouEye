/**
 * LAN Port API
 *
 * POST /api/containers/[name]/lan-port - Toggle LAN port exposure via Incus proxy device
 *
 * Adds or removes an Incus proxy device that maps a host port to the container's web port.
 * This allows direct LAN access without going through the Caddy reverse proxy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { incusRequest } from '@/lib/incus/server';
import { getAppManifests } from '@/lib/apps/manifest';

const SYSTEM_CONTAINERS: Record<string, number> = {
  'youeye-control': 3000,
};

const LAN_DEVICE_NAME = 'lan-web';

function getContainerWebPort(containerName: string): number | null {
  if (SYSTEM_CONTAINERS[containerName]) return SYSTEM_CONTAINERS[containerName];
  const manifest = getAppManifests().find(m => m.containerName === containerName);
  return manifest?.webPort ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrf = request.headers.get('X-CSRF-Token');
    if (!csrf || !(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { name: containerName } = await params;
    const body = await request.json();
    const { enabled, hostPort } = body as { enabled: boolean; hostPort?: number };

    const webPort = getContainerWebPort(containerName);
    if (!webPort) {
      return NextResponse.json({ error: 'Container has no web port' }, { status: 400 });
    }

    if (enabled && (!hostPort || hostPort < 1 || hostPort > 65535)) {
      return NextResponse.json({ error: 'Valid host port required (1-65535)' }, { status: 400 });
    }

    // Get current instance config — need full config for PUT (PATCH can't remove device keys)
    interface InstanceConfig {
      architecture: string;
      devices: Record<string, Record<string, string>>;
      config: Record<string, string>;
      profiles: string[];
    }
    const instance = await incusRequest<InstanceConfig>('GET', `/1.0/instances/${containerName}`);
    if (!instance.metadata) {
      return NextResponse.json({ error: 'Container not found' }, { status: 404 });
    }

    const devices = { ...instance.metadata.devices };

    if (enabled) {
      devices[LAN_DEVICE_NAME] = {
        type: 'proxy',
        listen: `tcp:0.0.0.0:${hostPort}`,
        connect: `tcp:127.0.0.1:${webPort}`,
      };
    } else {
      delete devices[LAN_DEVICE_NAME];
    }

    // Use PUT to replace full config — Incus PATCH merges the devices map
    // and cannot remove keys, so removing a device requires PUT
    const putResult = await incusRequest('PUT', `/1.0/instances/${containerName}`, {
      architecture: instance.metadata.architecture,
      config: instance.metadata.config,
      devices,
      profiles: instance.metadata.profiles,
    });
    if (putResult.type === 'error' || putResult.error_code > 0) {
      return NextResponse.json(
        { error: 'Incus error', details: putResult.error || 'Failed to update devices' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: enabled
        ? `LAN port ${hostPort} → ${containerName}:${webPort} enabled`
        : `LAN port for ${containerName} disabled`,
    });
  } catch (error) {
    console.error('Error toggling LAN port:', error);
    return NextResponse.json(
      { error: 'Failed to toggle LAN port', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
