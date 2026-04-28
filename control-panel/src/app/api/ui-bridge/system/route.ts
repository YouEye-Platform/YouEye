/**
 * UI Bridge: System Overview
 *
 * GET /api/ui-bridge/system
 *
 * Returns aggregated system information for the dashboard overview.
 * Host metrics (CPU, RAM, disk) come from Spine's /api/metrics endpoint
 * which reads from the real host /proc, not the container's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import type { SpineMetricsResponse } from '@/lib/spine/client';
import { incusRequest, getServerInfo } from '@/lib/incus/server';

interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  cpu: { cores: number; model: string; usage_percent?: string };
  memory: { total_mb: number; used_mb: number; free_mb: number };
  disk: { total_gb: number; used_gb: number; free_gb: number };
  load_average?: string;
}

/**
 * Get host-level system info from Spine's metrics endpoint.
 * Spine runs on the host, so it reads the real /proc and df.
 */
async function getHostInfo(): Promise<HostInfo> {
  const metrics: SpineMetricsResponse = await spineClient.getMetrics();
  return {
    hostname: metrics.hostname,
    os: metrics.os,
    kernel: metrics.kernel,
    uptime: metrics.uptime,
    cpu: {
      cores: metrics.cpu.cores,
      model: metrics.cpu.model,
      usage_percent: metrics.cpu.usage_percent,
    },
    memory: metrics.memory,
    disk: metrics.disk,
    load_average: metrics.load_average,
  };
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const hostInfo = await getHostInfo();

    // Get Incus server info
    let incusVersion = 'unknown';
    let storagePool = 'unknown';
    try {
      const serverInfo = await getServerInfo();
      const meta = serverInfo.metadata as Record<string, unknown>;
      const env = meta?.environment as Record<string, string> | undefined;
      incusVersion = env?.server_version || 'unknown';
      storagePool = env?.storage || 'default';
    } catch { /* ignore */ }

    // Count containers
    let totalContainers = 0;
    let runningContainers = 0;
    let stoppedContainers = 0;
    try {
      const instancesResponse = await incusRequest<string[]>('GET', '/1.0/instances');
      const instancePaths = instancesResponse.metadata || [];
      totalContainers = instancePaths.length;

      // Get state of each container
      for (const path of instancePaths) {
        const name = path.split('/').pop();
        if (!name) continue;
        try {
          const stateResponse = await incusRequest<{ status: string }>(
            'GET',
            `/1.0/instances/${name}/state`
          );
          const status = stateResponse.metadata?.status?.toLowerCase();
          if (status === 'running') {
            runningContainers++;
          } else {
            stoppedContainers++;
          }
        } catch {
          stoppedContainers++;
        }
      }
    } catch { /* ignore */ }

    return NextResponse.json({
      hostname: hostInfo.hostname,
      os: hostInfo.os,
      kernel: hostInfo.kernel,
      uptime: hostInfo.uptime,
      load_average: hostInfo.load_average,
      cpu: hostInfo.cpu,
      memory: hostInfo.memory,
      disk: hostInfo.disk,
      incus: {
        version: incusVersion,
        storage_pool: storagePool,
      },
      containers: {
        total: totalContainers,
        running: runningContainers,
        stopped: stoppedContainers,
      },
    });
  } catch (err) {
    console.error('[UI Bridge] System info error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve system information' },
      { status: 500 }
    );
  }
}
