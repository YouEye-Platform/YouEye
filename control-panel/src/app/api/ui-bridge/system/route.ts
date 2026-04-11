/**
 * UI Bridge: System Overview
 *
 * GET /api/ui-bridge/system
 *
 * Returns aggregated system information for the dashboard overview.
 * Combines data from Spine status and Incus API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import { incusRequest, getServerInfo } from '@/lib/incus/server';

interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  cpu: { cores: number; model: string };
  memory: { total_mb: number; used_mb: number; free_mb: number };
  disk: { total_gb: number; used_gb: number; free_gb: number };
}

/**
 * Gather host-level system info by reading /proc and /sys.
 * Since the CP runs inside an Incus container, we use the
 * host-shared /proc filesystem for CPU/mem, and Spine for OS info.
 */
async function getHostInfo(): Promise<HostInfo> {
  const info: HostInfo = {
    hostname: 'unknown',
    os: 'unknown',
    kernel: 'unknown',
    uptime: 'unknown',
    cpu: { cores: 0, model: 'unknown' },
    memory: { total_mb: 0, used_mb: 0, free_mb: 0 },
    disk: { total_gb: 0, used_gb: 0, free_gb: 0 },
  };

  try {
    const status = await spineClient.status();
    info.os = status.host?.os || 'unknown';
  } catch {
    // Spine may not be available
  }

  // Read system info from local /proc (shared with host in Incus)
  try {
    const { readFile } = await import('fs/promises');

    // Hostname
    try {
      info.hostname = (await readFile('/etc/hostname', 'utf-8')).trim();
    } catch {
      info.hostname = 'youeye';
    }

    // Kernel
    try {
      const osRelease = (await readFile('/proc/version', 'utf-8')).trim();
      const kernelMatch = osRelease.match(/Linux version ([\d.]+[^\s]*)/);
      info.kernel = kernelMatch ? kernelMatch[1] : osRelease.split(' ').slice(0, 3).join(' ');
    } catch { /* ignore */ }

    // Uptime
    try {
      const uptimeStr = (await readFile('/proc/uptime', 'utf-8')).trim();
      const uptimeSeconds = Math.floor(parseFloat(uptimeStr.split(' ')[0]));
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      info.uptime = `${days}d ${hours}h ${minutes}m`;
    } catch { /* ignore */ }

    // CPU info
    try {
      const cpuInfo = await readFile('/proc/cpuinfo', 'utf-8');
      const cores = (cpuInfo.match(/^processor\s*:/gm) || []).length;
      const modelMatch = cpuInfo.match(/model name\s*:\s*(.+)/);
      info.cpu = {
        cores: cores || 1,
        model: modelMatch ? modelMatch[1].trim() : 'unknown',
      };
    } catch { /* ignore */ }

    // Memory info
    try {
      const memInfo = await readFile('/proc/meminfo', 'utf-8');
      const totalMatch = memInfo.match(/MemTotal:\s+(\d+)/);
      const freeMatch = memInfo.match(/MemAvailable:\s+(\d+)/);
      if (totalMatch) {
        const totalKb = parseInt(totalMatch[1], 10);
        const freeKb = freeMatch ? parseInt(freeMatch[1], 10) : 0;
        info.memory = {
          total_mb: Math.round(totalKb / 1024),
          used_mb: Math.round((totalKb - freeKb) / 1024),
          free_mb: Math.round(freeKb / 1024),
        };
      }
    } catch { /* ignore */ }

    // Disk info (root filesystem)
    try {
      const { execSync } = await import('child_process');
      const dfOutput = execSync('df -BG / 2>/dev/null', { encoding: 'utf-8' });
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        info.disk = {
          total_gb: parseInt(parts[1], 10) || 0,
          used_gb: parseInt(parts[2], 10) || 0,
          free_gb: parseInt(parts[3], 10) || 0,
        };
      }
    } catch { /* ignore */ }
  } catch {
    // /proc may not be accessible — proceed with defaults
  }

  return info;
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
