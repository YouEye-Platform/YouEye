/**
 * Health Monitor — Background job that watches platform service health
 * and sends notifications on state transitions.
 *
 * Runs every 60 seconds. Only sends notifications when state CHANGES
 * (running → degraded, degraded → running, etc.) — never on every tick.
 *
 * Monitors:
 * - Container service health (Authentik, Pi-Hole, Caddy, PostgreSQL, Spine)
 * - Disk space (every 5 minutes via Spine API)
 * - Memory pressure (via Spine API)
 * - TLS certificate expiry (every 6 hours)
 * - App updates available (from version checker)
 *
 * Pattern: same setInterval + guard flag as update-cache.ts
 */

import { getAllServicesHealth, type ServiceHealth, type ServiceStatus } from './service';
import { sendNotificationToUI } from './notification-bridge';
import { spineClient } from '@/lib/spine/client';

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

// ─── Disk Space Monitoring ────────────────────────────────────

async function checkDiskSpace(): Promise<void> {
  try {
    const status = await spineClient.status();
    // Spine status includes host info but not disk directly.
    // Use execShell to check disk usage on host via Spine.
    const { execShell } = await import('@/lib/incus/server');

    // Check host disk from within the control panel container
    // The CP shares /var/lib/youeye as a volume from host
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
    const { execShell } = await import('@/lib/incus/server');
    const result = await execShell(
      'youeye-control',
      "free -m | grep '^Mem:' | awk '{print $7}'",
      { timeout: 5_000 }
    );

    if (result.exitCode !== 0) return;

    const availableMB = parseInt(result.stdout.trim(), 10);
    if (isNaN(availableMB)) return;

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

    // Every tick: service health
    await checkServiceHealth();

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

  console.log('[health-monitor] Started — checking every 60s');
}

/**
 * Stop the health monitor.
 */
export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

// Auto-start when module is imported in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startHealthMonitor();
}
