/**
 * Health Monitor — Background job that watches platform service health
 * and sends notifications on state transitions.
 *
 * Runs every 60 seconds. Only sends notifications when state CHANGES
 * (running → degraded, degraded → running, etc.) — never on every tick.
 *
 * Monitors:
 * - Container service health (Authentik, Pi-Hole, Caddy, PostgreSQL, Spine)
 * - Container watchdog — auto-restarts crashed containers, detects crash loops
 * - Disk space (every 5 minutes via Spine API)
 * - Memory pressure (via Spine API)
 * - Swap-aware memory throttling — applies soft limits under pressure
 * - TLS certificate expiry (every 6 hours)
 * - App updates available (from version checker)
 *
 * Pattern: same setInterval + guard flag as update-cache.ts
 */

import { getAllServicesHealth, type ServiceHealth, type ServiceStatus } from './service';
import { sendNotificationToUI } from './notification-bridge';
import { spineClient } from '@/lib/spine/client';
import { readFileSync } from 'fs';

// ─── State Tracking ───────────────────────────────────────────

interface ServiceState {
  status: ServiceStatus;
  lastAlertedAt: string | null;
}

/** Last known state per service slug */
const serviceStates = new Map<string, ServiceState>();

/** Last known disk usage percentage */
let lastDiskAlertLevel: 'none' | 'warning' | 'error' | 'critical' = 'none';

/** Last known cert expiry alert level */
let lastCertAlertLevel: 'none' | 'info' | 'warning' | 'critical' | 'expired' = 'none';

/** Last known memory alert state */
let memoryAlertActive = false;
let lowMemoryCount = 0;

/** Last known update notification hash */
let lastUpdateNotificationHash = '';

/** Whether a check is currently running */
let isChecking = false;

/** Tick counter for less-frequent checks */
let tickCount = 0;

const SERVICE_CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const DISK_CHECK_INTERVAL_TICKS = 5;       // Every 5 minutes
const CERT_CHECK_INTERVAL_TICKS = 360;     // Every 6 hours
const MEMORY_CONSECUTIVE_THRESHOLD = 3;    // 3 consecutive low readings

// ─── Container Watchdog State ────────────────────────────────

interface ContainerWatchState {
  previousStatus: string;
  restarts: number[];      // timestamps of recent restarts
  crashLoopDetected: boolean;
}

const watchStates = new Map<string, ContainerWatchState>();
let watchdogFirstTick = true;

/** Containers excluded from auto-restart */
const WATCHDOG_EXCLUDE = new Set(['youeye-pihole', 'youeye-control']);

const CRASH_LOOP_THRESHOLD = 3;           // restarts within window
const CRASH_LOOP_WINDOW_MS = 5 * 60_000;  // 5 minutes
const CRASH_LOOP_CLEAR_MS = 10 * 60_000;  // 10 minutes of stability

// ─── Memory Throttle State ───────────────────────────────────

let isThrottled = false;
const throttledContainers = new Set<string>();
let throttleCheckRunning = false;

const THROTTLE_ENTER_KB = 1_048_576;  // 1 GB in KB
const THROTTLE_EXIT_KB = 2_097_152;   // 2 GB in KB
const THROTTLE_INTERVAL_MS = 15_000;  // 15 seconds

// ─── Notification Helpers ─────────────────────────────────────

async function notify(
  title: string,
  message: string,
  type: 'info' | 'warning' | 'error',
  actionUrl?: string
): Promise<void> {
  try {
    await sendNotificationToUI({
      title,
      message,
      type,
      source: 'system',
      userId: null, // All admins
      actionUrl,
    });
  } catch (err) {
    console.error('[health-monitor] Failed to send notification:', err);
  }
}

// ─── Service Health Checks ────────────────────────────────────

async function checkServiceHealth(): Promise<void> {
  let services: ServiceHealth[];
  try {
    services = await getAllServicesHealth();
  } catch (err) {
    console.error('[health-monitor] Failed to get service health:', err);
    return;
  }

  for (const svc of services) {
    const prev = serviceStates.get(svc.slug);
    const prevStatus = prev?.status ?? 'unknown';
    const currentStatus = svc.status;

    // Only notify on state transitions
    if (prevStatus !== currentStatus) {
      if (currentStatus === 'stopped' || currentStatus === 'error') {
        await notify(
          `${svc.name} is down`,
          `${svc.name} has transitioned from ${prevStatus} to ${currentStatus}. Check the Health Dashboard for details.`,
          'error',
          '/health'
        );
      } else if (currentStatus === 'degraded') {
        await notify(
          `${svc.name} is degraded`,
          `${svc.name} is responding but not fully healthy. Monitor the Health Dashboard.`,
          'warning',
          '/health'
        );
      } else if (
        currentStatus === 'running' &&
        (prevStatus === 'stopped' || prevStatus === 'error' || prevStatus === 'degraded')
      ) {
        await notify(
          `${svc.name} is back online`,
          `${svc.name} has recovered and is now running normally.`,
          'info',
          '/health'
        );
      }
    }

    serviceStates.set(svc.slug, {
      status: currentStatus,
      lastAlertedAt: prevStatus !== currentStatus ? new Date().toISOString() : (prev?.lastAlertedAt ?? null),
    });
  }
}

// ─── Container Watchdog ──────────────────────────────────────

async function checkContainerWatchdog(): Promise<void> {
  try {
    const { incusRequest } = await import('@/lib/incus/server');
    const { applyResourcePolicy } = await import('@/lib/infrastructure/resource-policy');

    // List all containers with their state
    const resp = await incusRequest<any[]>('GET', '/1.0/instances?recursion=1');
    if (!resp.metadata) return;

    const now = Date.now();

    for (const instance of resp.metadata) {
      const name: string = instance.name;
      const status: string = instance.status; // "Running", "Stopped", etc.

      // Only watch app containers and infrastructure (except excluded)
      const isApp = name.startsWith('app-') || name.startsWith('ye-app-');
      const isInfra = name.startsWith('youeye-');
      if (!isApp && !isInfra) continue;
      if (WATCHDOG_EXCLUDE.has(name)) continue;

      const state = watchStates.get(name);

      if (!state) {
        // First time seeing this container — record state, don't act
        watchStates.set(name, {
          previousStatus: status,
          restarts: [],
          crashLoopDetected: false,
        });
        continue;
      }

      // On first tick after startup, just record states
      if (watchdogFirstTick) {
        state.previousStatus = status;
        continue;
      }

      // Clear crash loop flag after stability period
      if (state.crashLoopDetected && state.restarts.length > 0) {
        const lastRestart = state.restarts[state.restarts.length - 1];
        if (now - lastRestart > CRASH_LOOP_CLEAR_MS) {
          state.crashLoopDetected = false;
          state.restarts = [];
          console.log(`[watchdog] ${name} — crash loop cleared after stability period`);
        }
      }

      // Detect running → stopped transition
      if (state.previousStatus === 'Running' && status === 'Stopped') {
        if (state.crashLoopDetected) {
          // Already in crash loop — don't restart
          state.previousStatus = status;
          continue;
        }

        // Restart the container
        console.log(`[watchdog] ${name} stopped unexpectedly — restarting`);
        try {
          await incusRequest('PUT', `/1.0/instances/${name}/state`, {
            action: 'start',
            timeout: 30,
          });

          // Re-apply resource policy
          const priority = isInfra ? 'critical' as const : 'normal' as const;
          await applyResourcePolicy(name, priority);

          // Track restart
          state.restarts.push(now);
          // Prune old restart timestamps
          state.restarts = state.restarts.filter(t => now - t < CRASH_LOOP_WINDOW_MS);

          // Check for crash loop
          if (state.restarts.length >= CRASH_LOOP_THRESHOLD) {
            state.crashLoopDetected = true;
            console.error(`[watchdog] ${name} — crash loop detected (${state.restarts.length} restarts in 5 min)`);
            await notify(
              `${name} keeps crashing`,
              `${name} has restarted ${state.restarts.length} times in the last 5 minutes. Auto-restart stopped. Your server may not have enough resources for all installed apps.`,
              'error',
              '/health'
            );
          } else {
            // Notify about the restart
            const notifType = isInfra ? 'warning' as const : 'info' as const;
            const suffix = isInfra ? ' — monitor the Health Dashboard' : '';
            await notify(
              `${name} was restarted automatically`,
              `${name} stopped unexpectedly and was restarted by the watchdog${suffix}.`,
              notifType,
              '/health'
            );
          }
        } catch (err) {
          console.error(`[watchdog] Failed to restart ${name}:`, err);
        }
      }

      state.previousStatus = status;
    }

    // Clean up watch states for containers that no longer exist
    const currentNames = new Set(resp.metadata.map((i: any) => i.name));
    for (const name of watchStates.keys()) {
      if (!currentNames.has(name)) watchStates.delete(name);
    }

    watchdogFirstTick = false;
  } catch (err) {
    console.error('[watchdog] Check failed:', err);
  }
}

// ─── Disk Space Monitoring ────────────────────────────────────

async function checkDiskSpace(): Promise<void> {
  try {
    const status = await spineClient.status();
    // Spine status includes host info but not disk directly.
    // Use execShell to check disk usage on host via Spine.
    const { execShell } = await import('@/lib/incus/server');

    // Check host disk from within the control panel container
    // The Control Panel shares /var/lib/youeye as a volume from host
    const result = await execShell(
      'youeye-control',
      "df -h / | tail -1 | awk '{print $5}'",
      { timeout: 5_000 }
    );

    if (result.exitCode !== 0) return;

    const usageStr = result.stdout.trim().replace('%', '');
    const usage = parseInt(usageStr, 10);
    if (isNaN(usage)) return;

    let newLevel: typeof lastDiskAlertLevel = 'none';
    if (usage >= 95) newLevel = 'critical';
    else if (usage >= 90) newLevel = 'error';
    else if (usage >= 75) newLevel = 'warning';

    if (newLevel !== lastDiskAlertLevel) {
      if (newLevel === 'critical') {
        await notify(
          'Critical: Disk space at 95%+',
          `Disk usage is at ${usage}%. Immediate action required — consider cleaning up old backups or expanding storage.`,
          'error'
        );
      } else if (newLevel === 'error') {
        await notify(
          'Disk space at 90%+',
          `Disk usage is at ${usage}%. Consider freeing up space soon.`,
          'error'
        );
      } else if (newLevel === 'warning') {
        await notify(
          'Disk space warning',
          `Disk usage is at ${usage}%. Monitor and plan for cleanup.`,
          'warning'
        );
      } else if (newLevel === 'none' && lastDiskAlertLevel !== 'none') {
        await notify(
          'Disk space recovered',
          `Disk usage has dropped below 75%. No action needed.`,
          'info'
        );
      }
      lastDiskAlertLevel = newLevel;
    }
  } catch (err) {
    // Disk check is best-effort
    console.error('[health-monitor] Disk check failed:', err);
  }
}

// ─── Memory Monitoring ────────────────────────────────────────

async function checkMemory(): Promise<void> {
  try {
    // Read host memory from bind-mounted /host/proc/meminfo (same source as throttle).
    // Previously used `free -m` inside the Control Panel container, which showed cgroup values.
    let meminfo: string;
    try {
      meminfo = readFileSync('/host/proc/meminfo', 'utf-8');
    } catch {
      return; // Host meminfo not mounted yet
    }

    const memAvailableKB = parseMemInfoValue(meminfo, 'MemAvailable');
    if (memAvailableKB === 0) return;

    const availableMB = Math.floor(memAvailableKB / 1024);

    if (availableMB < 512) {
      lowMemoryCount++;
    } else {
      lowMemoryCount = 0;
    }

    if (lowMemoryCount >= MEMORY_CONSECUTIVE_THRESHOLD && !memoryAlertActive) {
      memoryAlertActive = true;
      await notify(
        'Low memory warning',
        `Available RAM has been below 512 MB for ${lowMemoryCount} consecutive checks (${availableMB} MB available now).`,
        'warning',
        '/health'
      );
    } else if (lowMemoryCount === 0 && memoryAlertActive) {
      memoryAlertActive = false;
      await notify(
        'Memory recovered',
        `Available RAM is now ${availableMB} MB — above the 512 MB threshold.`,
        'info'
      );
    }
  } catch {
    // Memory check is best-effort
  }
}

// ─── Swap-Aware Memory Throttling ────────────────────────────

function parseMemInfoValue(meminfo: string, key: string): number {
  const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
  return match ? parseInt(match[1], 10) : 0;
}

async function checkMemoryThrottle(): Promise<void> {
  if (throttleCheckRunning) return;
  throttleCheckRunning = true;

  try {
    // Read host /proc/meminfo mounted at /host/proc/meminfo.
    // The Control Panel container's own /proc/meminfo shows cgroup-limited values (~8 GB)
    // regardless of actual host memory state. The host meminfo is bind-mounted
    // by Spine during Control Panel deployment.
    let meminfo: string;
    try {
      meminfo = readFileSync('/host/proc/meminfo', 'utf-8');
    } catch {
      return; // procfs not available
    }

    const memAvailableKB = parseMemInfoValue(meminfo, 'MemAvailable');
    const swapFreeKB = parseMemInfoValue(meminfo, 'SwapFree');
    const totalAvailableKB = memAvailableKB + swapFreeKB;

    if (totalAvailableKB < THROTTLE_ENTER_KB && !isThrottled) {
      // Enter throttle mode — apply soft memory limits to app containers
      isThrottled = true;
      console.log(`[throttle] Entering throttle mode — available: ${Math.round(totalAvailableKB / 1024)} MB`);

      const { incusRequest } = await import('@/lib/incus/server');
      const resp = await incusRequest<any[]>('GET', '/1.0/instances?recursion=1');
      if (!resp.metadata) return;

      for (const instance of resp.metadata) {
        const name: string = instance.name;
        if (!name.startsWith('app-') && !name.startsWith('ye-app-')) continue; // Only throttle app containers
        if (instance.status !== 'Running') continue;

        try {
          // Read current memory usage
          const stateResp = await incusRequest<any>('GET', `/1.0/instances/${name}/state`);
          const currentUsageBytes = stateResp.metadata?.memory?.usage ?? 0;
          if (currentUsageBytes === 0) continue;

          // Set soft limit to current usage
          const limitMB = Math.max(64, Math.ceil(currentUsageBytes / (1024 * 1024)));
          await incusRequest('PATCH', `/1.0/instances/${name}`, {
            config: {
              'limits.memory': `${limitMB}MiB`,
              'limits.memory.enforce': 'soft',
            },
          });
          throttledContainers.add(name);
        } catch (err) {
          console.error(`[throttle] Failed to throttle ${name}:`, err);
        }
      }

      if (throttledContainers.size > 0) {
        await notify(
          'Server memory is low',
          'Apps are running slower to stay stable. Consider closing unused apps or adding more RAM.',
          'warning',
          '/health'
        );
      }
    } else if (totalAvailableKB > THROTTLE_EXIT_KB && isThrottled) {
      // Exit throttle mode — remove soft limits
      isThrottled = false;
      console.log(`[throttle] Exiting throttle mode — available: ${Math.round(totalAvailableKB / 1024)} MB`);

      const { incusRequest } = await import('@/lib/incus/server');

      for (const name of throttledContainers) {
        try {
          await incusRequest('PATCH', `/1.0/instances/${name}`, {
            config: {
              'limits.memory': '',
              'limits.memory.enforce': '',
            },
          });
        } catch (err) {
          console.error(`[throttle] Failed to unthrottle ${name}:`, err);
        }
      }

      throttledContainers.clear();

      await notify(
        'Memory recovered',
        'All apps running at full speed again.',
        'info',
        '/health'
      );
    }
  } catch (err) {
    console.error('[throttle] Check failed:', err);
  } finally {
    throttleCheckRunning = false;
  }
}

// ─── Certificate Expiry ───────────────────────────────────────

async function checkCertExpiry(): Promise<void> {
  try {
    const { execShell } = await import('@/lib/incus/server');
    // Check TLS cert expiry from Caddy's auto-renewed cert
    const result = await execShell(
      'youeye-caddy',
      'echo | openssl s_client -connect localhost:443 -servername localhost 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null',
      { timeout: 10_000 }
    );

    if (result.exitCode !== 0 || !result.stdout.includes('notAfter=')) return;

    const dateStr = result.stdout.replace('notAfter=', '').trim();
    const expiryDate = new Date(dateStr);
    const now = new Date();
    const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    let newLevel: typeof lastCertAlertLevel = 'none';
    if (daysUntilExpiry < 0) newLevel = 'expired';
    else if (daysUntilExpiry <= 3) newLevel = 'critical';
    else if (daysUntilExpiry <= 14) newLevel = 'warning';
    else if (daysUntilExpiry <= 30) newLevel = 'info';

    if (newLevel !== lastCertAlertLevel) {
      if (newLevel === 'expired') {
        await notify(
          'TLS certificate expired!',
          'The platform TLS certificate has expired. Check that Caddy is running and can reach the ACME provider.',
          'error'
        );
      } else if (newLevel === 'critical') {
        await notify(
          'TLS certificate expires in 3 days',
          `Certificate expires on ${expiryDate.toISOString().split('T')[0]}. Verify Caddy is running for auto-renewal.`,
          'error'
        );
      } else if (newLevel === 'warning') {
        await notify(
          'TLS certificate expires in 14 days',
          `Certificate expires on ${expiryDate.toISOString().split('T')[0]}. Caddy should auto-renew, but verify it is running.`,
          'warning'
        );
      } else if (newLevel === 'info') {
        await notify(
          'TLS certificate renewing soon',
          `Certificate expires in ${daysUntilExpiry} days. Caddy handles auto-renewal — no action needed.`,
          'info'
        );
      }
      lastCertAlertLevel = newLevel;
    }
  } catch {
    // Cert check is best-effort
  }
}

// ─── App Updates Notification ─────────────────────────────────

async function checkAppUpdates(): Promise<void> {
  try {
    const { getLastVersionCheckResults } = await import('@/lib/market/version-checker');
    const updates = getLastVersionCheckResults();

    if (updates.length === 0) {
      if (lastUpdateNotificationHash !== '' && lastUpdateNotificationHash !== 'none') {
        lastUpdateNotificationHash = 'none';
        // Don't notify when updates are resolved — user installed them
      }
      return;
    }

    // Build a hash to avoid duplicate notifications
    const hash = updates.map((u) => `${u.appId}:${u.catalogVersion}`).sort().join(',');
    if (hash === lastUpdateNotificationHash) return;

    const appNames = updates.map((u) => u.appId).join(', ');
    await notify(
      `Updates available for ${updates.length} app${updates.length > 1 ? 's' : ''}`,
      `Update available: ${appNames}. Visit the App Market to update.`,
      'info',
      '/market'
    );

    lastUpdateNotificationHash = hash;
  } catch {
    // Update notification is best-effort
  }
}

// ─── Main Check Loop ──────────────────────────────────────────

async function runHealthChecks(): Promise<void> {
  if (isChecking) return;
  isChecking = true;

  try {
    tickCount++;

    // Every tick: service health + container watchdog
    await checkServiceHealth();
    await checkContainerWatchdog();

    // Every 5 ticks: disk + memory
    if (tickCount % DISK_CHECK_INTERVAL_TICKS === 0) {
      await checkDiskSpace();
      await checkMemory();
    }

    // Every 360 ticks (6 hours): cert expiry
    if (tickCount % CERT_CHECK_INTERVAL_TICKS === 0) {
      await checkCertExpiry();
    }

    // Every 30 ticks (30 minutes): check for app update notifications
    if (tickCount % 30 === 0) {
      await checkAppUpdates();
    }
  } catch (err) {
    console.error('[health-monitor] Check loop error:', err);
  } finally {
    isChecking = false;
  }
}

// ─── Background Timer ─────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let throttleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the health monitor background job.
 */
export function startHealthMonitor(): void {
  if (monitorTimer) return;

  // Initial check after 60 seconds (let services boot)
  setTimeout(() => {
    runHealthChecks().catch((err) => {
      console.error('[health-monitor] Initial check failed:', err);
    });
  }, 60_000);

  monitorTimer = setInterval(() => {
    runHealthChecks().catch((err) => {
      console.error('[health-monitor] Periodic check failed:', err);
    });
  }, SERVICE_CHECK_INTERVAL_MS);

  // Memory throttle check runs on a faster 15-second interval
  throttleTimer = setInterval(() => {
    checkMemoryThrottle().catch((err) => {
      console.error('[health-monitor] Throttle check failed:', err);
    });
  }, THROTTLE_INTERVAL_MS);

  console.log('[health-monitor] Started — health every 60s, throttle every 15s');
}

/**
 * Stop the health monitor.
 */
export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (throttleTimer) {
    clearInterval(throttleTimer);
    throttleTimer = null;
  }
}

// Auto-start when module is imported in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startHealthMonitor();
}
