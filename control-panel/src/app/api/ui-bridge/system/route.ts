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
 * Falls back to /api/status (less detail) if /api/metrics is unavailable
 * (older Spine versions don't have the metrics endpoint).
 */
async function getHostInfo(): Promise<HostInfo> {
  try {
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
  } catch {
    // Fallback: older Spine without /api/metrics — use /api/status for basics
    const status = await spineClient.status();
    return {
      hostname: 'unknown',
      os: status.host?.os || 'unknown',
      kernel: 'unknown',
      uptime: 'unknown',
      cpu: { cores: 0, model: 'unknown' },
      memory: { total_mb: 0, used_mb: 0, free_mb: 0 },
      disk: { total_gb: 0, used_gb: 0, free_gb: 0 },
    };
  }
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

    // Get per-container details with resource stats
    interface ContainerDetail {
      name: string;
      status: string;
      type: string;
      ipv4: string | null;
      memory_usage_mb: number;
      memory_limit_mb: number;
      cpu_usage_ns: number;
      disk_usage_mb: number;
    }

    const containerDetails: ContainerDetail[] = [];
    let totalContainers = 0;
    let runningContainers = 0;
    let stoppedContainers = 0;

    try {
      const instancesResponse = await incusRequest<string[]>('GET', '/1.0/instances');
      const instancePaths = instancesResponse.metadata || [];
      totalContainers = instancePaths.length;

      for (const path of instancePaths) {
        const cname = path.split('/').pop();
        if (!cname) continue;

        let status = 'unknown';
        let ctype = 'container';
        let ipv4: string | null = null;
        let memUsage = 0;
        let memLimit = 0;
        let cpuUsage = 0;
        let diskUsage = 0;

        try {
          const instResp = await incusRequest<{ name: string; type: string; status: string }>(
            'GET', `/1.0/instances/${cname}`
          );
          ctype = instResp.metadata?.type || 'container';
        } catch { /* ignore */ }

        try {
          const stateResp = await incusRequest<{
            status: string;
            memory?: { usage: number; total: number };
            cpu?: { usage: number };
            disk?: Record<string, { usage: number }>;
            network?: Record<string, { addresses?: Array<{ family: string; address: string; scope: string }> }>;
          }>('GET', `/1.0/instances/${cname}/state`);

          const st = stateResp.metadata;
          status = st?.status?.toLowerCase() || 'unknown';
          memUsage = Math.round((st?.memory?.usage || 0) / (1024 * 1024));
          memLimit = Math.round((st?.memory?.total || 0) / (1024 * 1024));
          cpuUsage = st?.cpu?.usage || 0;
          diskUsage = Math.round((st?.disk?.root?.usage || 0) / (1024 * 1024));

          const eth0 = st?.network?.['eth0'];
          if (eth0?.addresses) {
            const v4 = eth0.addresses.find(a => a.family === 'inet' && a.scope === 'global');
            if (v4) ipv4 = v4.address;
          }
        } catch {
          status = 'stopped';
        }

        if (status === 'running') runningContainers++;
        else stoppedContainers++;

        containerDetails.push({
          name: cname,
          status,
          type: ctype,
          ipv4,
          memory_usage_mb: memUsage,
          memory_limit_mb: memLimit,
          cpu_usage_ns: cpuUsage,
          disk_usage_mb: diskUsage,
        });
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
      container_details: containerDetails,
    });
  } catch (err) {
    console.error('[UI Bridge] System info error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve system information' },
      { status: 500 }
    );
  }
}
