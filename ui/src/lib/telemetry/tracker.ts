/**
 * YouEye Usage Tracker (Server-side)
 *
 * Lightweight telemetry for private beta testing.
 * Records which routes and features are actually used, helping identify dead code.
 *
 * Privacy: No personal data, no IPs, no user identifiers.
 * Just counters: "route X was hit N times."
 *
 * Data is stored in a persistent file outside the app directory
 * so it survives redeploys. Counters are kept in memory and flushed
 * to disk every 60 seconds.
 *
 * This module is temporary and will be removed after the beta period.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DISABLED = process.env.TELEMETRY_DISABLED === "true";
const DATA_DIR = process.env.TELEMETRY_DATA_DIR || "/opt/youeye-ui-data";
const DATA_FILE = join(DATA_DIR, "telemetry.json");
const FLUSH_INTERVAL_MS = 60_000; // 1 minute

export interface TelemetryReport {
  version: string;
  period_start: string;
  last_flush: string;
  routes: Record<string, number>;
  features: Record<string, number>;
  apps_launched: Record<string, number>;
  errors: Array<{ route: string; message: string; count: number; last_seen: string }>;
}

function emptyReport(): TelemetryReport {
  return {
    version: "1",
    period_start: new Date().toISOString(),
    last_flush: new Date().toISOString(),
    routes: {},
    features: {},
    apps_launched: {},
    errors: [],
  };
}

/** Singleton tracker instance (survives across requests in the same process) */
class UsageTracker {
  private data: TelemetryReport;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.data = this.loadFromDisk();
    this.startFlushInterval();
  }

  private loadFromDisk(): TelemetryReport {
    try {
      if (existsSync(DATA_FILE)) {
        const raw = readFileSync(DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw) as TelemetryReport;
        // Validate basic structure
        if (parsed.routes && parsed.features && parsed.apps_launched) {
          return parsed;
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
    return emptyReport();
  }

  private writeToDisk(): void {
    if (!this.dirty) return;
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      this.data.last_flush = new Date().toISOString();
      writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch (e) {
      console.error("[telemetry] Failed to write data:", e instanceof Error ? e.message : e);
    }
  }

  private startFlushInterval(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.writeToDisk(), FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for telemetry
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Track a route/page hit */
  trackRoute(pathname: string): void {
    if (DISABLED) return;
    // Normalize: strip query params, collapse dynamic segments
    const normalized = this.normalizeRoute(pathname);
    this.data.routes[normalized] = (this.data.routes[normalized] || 0) + 1;
    this.dirty = true;
  }

  /** Track a named feature usage */
  trackFeature(featureId: string): void {
    if (DISABLED) return;
    this.data.features[featureId] = (this.data.features[featureId] || 0) + 1;
    this.dirty = true;
  }

  /** Track an app launch */
  trackAppLaunch(appSlug: string): void {
    if (DISABLED) return;
    this.data.apps_launched[appSlug] = (this.data.apps_launched[appSlug] || 0) + 1;
    this.dirty = true;
  }

  /** Track an error occurrence */
  trackError(route: string, message: string): void {
    const existing = this.data.errors.find(
      (e) => e.route === route && e.message === message
    );
    if (existing) {
      existing.count++;
      existing.last_seen = new Date().toISOString();
    } else {
      this.data.errors.push({
        route,
        message: message.slice(0, 200), // Truncate long messages
        count: 1,
        last_seen: new Date().toISOString(),
      });
      // Cap error list at 100 entries
      if (this.data.errors.length > 100) {
        this.data.errors = this.data.errors.slice(-100);
      }
    }
    this.dirty = true;
  }

  /** Get the current report (for export) */
  getReport(): TelemetryReport {
    this.writeToDisk(); // Ensure latest data is persisted
    return { ...this.data };
  }

  /** Reset all counters (after export or new period) */
  reset(): void {
    this.data = emptyReport();
    this.dirty = true;
    this.writeToDisk();
  }

  /** Flush to disk immediately (for graceful shutdown) */
  flush(): void {
    this.writeToDisk();
  }

  private normalizeRoute(pathname: string): string {
    // Strip trailing slash
    let p = pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;

    // Collapse UUID-like segments into [id]
    p = p.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "/[id]"
    );

    // Collapse numeric-only segments into [id]
    p = p.replace(/\/\d+(?=\/|$)/g, "/[id]");

    return p;
  }
}

// Use globalThis to ensure singleton across module reloads (Next.js dev mode)
const TRACKER_KEY = "__youeye_telemetry_tracker__";

function getTracker(): UsageTracker {
  const g = globalThis as unknown as Record<string, UsageTracker>;
  if (!g[TRACKER_KEY]) {
    g[TRACKER_KEY] = new UsageTracker();
  }
  return g[TRACKER_KEY];
}

// Public API
export const tracker = getTracker();

export function trackRoute(pathname: string): void {
  tracker.trackRoute(pathname);
}

export function trackFeature(featureId: string): void {
  tracker.trackFeature(featureId);
}

export function trackAppLaunch(appSlug: string): void {
  tracker.trackAppLaunch(appSlug);
}

export function trackError(route: string, message: string): void {
  tracker.trackError(route, message);
}

export function getTelemetryReport(): TelemetryReport {
  return tracker.getReport();
}

export function resetTelemetry(): void {
  tracker.reset();
}
