/**
 * Platform Health Service
 *
 * Queries Incus container state + per-service health endpoints to build
 * a unified health snapshot of the five core platform services:
 * Authentik, Pi-Hole, Caddy, PostgreSQL, and Spine.
 */

import { incusRequest, getInstanceState, execShell } from '@/lib/incus/server';
import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';

export type ServiceStatus = 'running' | 'stopped' | 'error' | 'degraded' | 'unknown';

export interface ServiceHealth {
  name: string;
  slug: string;
  status: ServiceStatus;
  uptime: string;
  version: string;
  lastCheck: string;
  cpu: number;
  /** CPU utilization as a percentage (0-100), or -1 if not available (first poll / Spine) */
  cpuPercent: number;
  memory: number;
  restartable: boolean;
}

// ─── CPU Delta-Sampling State ────────────────────────────────
// Incus reports CPU as cumulative nanoseconds. To get real utilization %,
// we compute (cpu_now - cpu_last) / (wall_now - wall_last) * 100.

interface CpuReading {
  ns: number;
  timestamp: number;
}

const lastCpuReadings = new Map<string, CpuReading>();

function computeCpuPercent(container: string, currentNs: number): number {
  const now = Date.now();
  const prev = lastCpuReadings.get(container);
  lastCpuReadings.set(container, { ns: currentNs, timestamp: now });

  if (!prev) {
    // First poll — no baseline yet
    return -1;
  }

  const wallDeltaMs = now - prev.timestamp;
  if (wallDeltaMs <= 0) return -1;

  const cpuDeltaNs = currentNs - prev.ns;
  if (cpuDeltaNs < 0) return -1; // counter reset

  // Convert wall delta to nanoseconds for consistent units
  const wallDeltaNs = wallDeltaMs * 1_000_000;
  const pct = (cpuDeltaNs / wallDeltaNs) * 100;
  return Math.round(pct * 10) / 10; // one decimal place
}

interface IncusContainerState {
  status: string;
  status_code: number;
  cpu?: { usage: number };
  memory?: { usage: number; peak: number };
  processes: number;
}

/** Map container names to display info */
const SERVICE_MAP: ReadonlyArray<{
  name: string;
  slug: string;
  container: string;
  restartable: boolean;
}> = [
  { name: 'Authentik', slug: 'authentik', container: 'youeye-authentik', restartable: true },
  { name: 'Pi-Hole', slug: 'pihole', container: 'youeye-pihole', restartable: true },
  { name: 'Caddy', slug: 'caddy', container: 'youeye-caddy', restartable: true },
  { name: 'PostgreSQL', slug: 'postgres', container: 'youeye-postgres', restartable: true },
];

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

async function getContainerHealth(container: string): Promise<{
  status: ServiceStatus;
  cpu: number;
  cpuPercent: number;
  memory: number;
  uptime: string;
}> {
  try {
    const stateRes = await getInstanceState(container);
    const state = stateRes.metadata as IncusContainerState | undefined;
    if (!state || state.status !== 'Running') {
      return { status: 'stopped', cpu: 0, cpuPercent: -1, memory: 0, uptime: '—' };
    }

    // CPU usage from Incus is cumulative nanoseconds — delta-sample for real %
    const cpuUsageNs = state.cpu?.usage ?? 0;
    const cpuPercent = computeCpuPercent(container, cpuUsageNs);

    const memoryBytes = state.memory?.usage ?? 0;
    const memoryMB = Math.round(memoryBytes / 1024 / 1024);

    // Get uptime from /proc/uptime inside the container
    let uptime = '—';
    try {
      const result = await execShell(container, 'cat /proc/uptime', { timeout: 5000 });
      if (result.exitCode === 0 && result.stdout.trim()) {
        const uptimeSec = parseFloat(result.stdout.trim().split(' ')[0]);
        uptime = formatUptime(Math.floor(uptimeSec));
      }
    } catch {
      // Uptime not available
    }

    return {
      status: 'running',
      cpu: cpuUsageNs,
      cpuPercent,
      memory: memoryMB,
      uptime,
    };
  } catch {
    return { status: 'unknown', cpu: 0, cpuPercent: -1, memory: 0, uptime: '—' };
  }
}

async function checkAuthentikHealth(ip: string): Promise<ServiceStatus> {
  // BUG-024: Authentik is heavy and /health/ready/ can return 503 transiently.
  // Retry once after a short delay to reduce false positives.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://${ip}:9000/-/health/ready/`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return 'running';
    } catch {
      // Network error — try again
    }
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return 'degraded';
}

async function checkPiholeHealth(container: string): Promise<{ status: ServiceStatus; version: string }> {
  try {
    // Pi-Hole v6 requires authentication for all API endpoints (returns 401).
    // Use 'pihole status' inside the container instead.
    const result = await execShell(container, 'pihole status 2>&1', { timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.includes('FTL is listening')) {
      // Try to extract version from pihole -v
      let version = '';
      try {
        const vResult = await execShell(container, 'pihole -v -c 2>&1', { timeout: 5000 });
        if (vResult.exitCode === 0) {
          const match = vResult.stdout.match(/v(\d+\.\d+[\.\d]*)/);
          version = match?.[1] || '';
        }
      } catch {
        // Version not critical
      }
      return { status: 'running', version };
    }
    return { status: 'degraded', version: '' };
  } catch {
    return { status: 'degraded', version: '' };
  }
}

async function checkCaddyHealth(container: string): Promise<ServiceStatus> {
  // FIX-3: Switch from IP-based fetch to exec-based check.
  // Fetching from outside the container via IP was unreliable when CP's
  // fetch() couldn't reach the Caddy admin API from inside youeye-control.
  // Using execShell to run curl inside the Caddy container is always reliable,
  // consistent with how Pi-Hole and PostgreSQL health checks work.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await execShell(
        container,
        'curl -s -o /dev/null -w "%{http_code}" http://localhost:2019/config/',
        { timeout: 5000 }
      );
      const code = result.stdout?.trim().replace(/'/g, '');
      if (code === '200') return 'running';
    } catch {
      // exec failed — try again
    }
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return 'degraded';
}

async function checkPostgresHealth(container: string): Promise<{ status: ServiceStatus; version: string }> {
  try {
    // BUG-019: BusyBox 'su' in Alpine containers doesn't support 'su - postgres'
    // syntax. Use pg_isready for health check (no shell user switch needed).
    const result = await execShell(container, 'pg_isready', { timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.includes('accepting connections')) {
      // Try to get version via psql with BusyBox-compatible su
      let version = '';
      try {
        const vResult = await execShell(
          container,
          'su postgres -c "psql -t -c \'SELECT version()\'"',
          { timeout: 5000 }
        );
        if (vResult.exitCode === 0 && vResult.stdout.includes('PostgreSQL')) {
          const match = vResult.stdout.match(/PostgreSQL\s+(\d+\.\d+)/);
          version = match?.[1] || '';
        }
      } catch {
        // Version extraction not critical
      }
      return { status: 'running', version };
    }
    return { status: 'degraded', version: '' };
  } catch {
    return { status: 'degraded', version: '' };
  }
}

async function checkSpineHealth(): Promise<ServiceHealth> {
  // BUG-024: Retry Spine health check to reduce transient false positives
  // caused by socket connection timing or brief Spine restarts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [health, version] = await Promise.all([
        spineClient.health(),
        spineClient.version(),
      ]);
      return {
        name: 'Spine',
        slug: 'spine',
        status: health.status === 'ok' ? 'running' : 'degraded',
        uptime: '—',
        version: version.version || '',
        lastCheck: new Date().toISOString(),
        cpu: 0,
        cpuPercent: -2, // -2 = N/A (Spine is a host process, not a container)
        memory: 0,
        restartable: false, // Spine self-manages
      };
    } catch {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  return {
    name: 'Spine',
    slug: 'spine',
    status: 'error',
    uptime: '—',
    version: '',
    lastCheck: new Date().toISOString(),
    cpu: 0,
    cpuPercent: -2,
    memory: 0,
    restartable: false,
  };
}

/**
 * Get health status for all platform services
 */
export async function getAllServicesHealth(): Promise<ServiceHealth[]> {
  const now = new Date().toISOString();

  // Check all container services in parallel
  const containerResults = await Promise.all(
    SERVICE_MAP.map(async (svc) => {
      const containerHealth = await getContainerHealth(svc.container);

      let appStatus = containerHealth.status;
      let version = '';

      // If container is running, check the service-level health
      if (containerHealth.status === 'running') {
        switch (svc.slug) {
          case 'authentik': {
            // Network-based: Authentik exposes /health/ready endpoint
            const ip = await getContainerIP(svc.container);
            if (ip) {
              appStatus = await checkAuthentikHealth(ip);
            }
            break;
          }
          case 'caddy': {
            // FIX-3: Exec-based check inside the Caddy container (no IP fetch needed)
            appStatus = await checkCaddyHealth(svc.container);
            break;
          }
          case 'pihole': {
            // BUG-019: Pi-Hole v6 requires auth for all API endpoints.
            // Use exec-based 'pihole status' inside container instead.
            const ph = await checkPiholeHealth(svc.container);
            appStatus = ph.status;
            version = ph.version;
            break;
          }
          case 'postgres': {
            // BUG-019: BusyBox su doesn't support 'su - postgres'.
            // Use pg_isready for health check.
            const pg = await checkPostgresHealth(svc.container);
            appStatus = pg.status;
            version = pg.version;
            break;
          }
        }
      }

      const health: ServiceHealth = {
        name: svc.name,
        slug: svc.slug,
        status: appStatus,
        uptime: containerHealth.uptime,
        version,
        lastCheck: now,
        cpu: containerHealth.cpu,
        cpuPercent: containerHealth.cpuPercent,
        memory: containerHealth.memory,
        restartable: svc.restartable,
      };
      return health;
    })
  );

  // Check Spine (not a container)
  const spineHealth = await checkSpineHealth();

  return [...containerResults, spineHealth];
}
