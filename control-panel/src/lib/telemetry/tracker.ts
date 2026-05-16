/**
 * Control Panel Usage Tracker (Node.js runtime only)
 *
 * Lightweight telemetry for private beta testing.
 * Tracks which CP API routes and embed pages are accessed.
 * Merges in-memory counters from Edge middleware (counter.ts) on flush.
 *
 * Privacy: No personal data, no IPs, no user identifiers.
 * Just counters: "route X was hit N times."
 *
 * Temporary — will be removed after beta period.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { drainCounters } from "./counter";

const DATA_DIR = process.env.TELEMETRY_DATA_DIR || "/opt/youeye-control-data";
const DATA_FILE = join(DATA_DIR, "telemetry.json");
const FLUSH_INTERVAL_MS = 60_000;

export interface CpTelemetryReport {
  version: string;
  component: "control-panel";
  period_start: string;
  last_flush: string;
  routes: Record<string, number>;
  errors: Array<{ route: string; message: string; count: number; last_seen: string }>;
}

function emptyReport(): CpTelemetryReport {
  return {
    version: "1",
    component: "control-panel",
    period_start: new Date().toISOString(),
    last_flush: new Date().toISOString(),
    routes: {},
    errors: [],
  };
}

class CpUsageTracker {
  private data: CpTelemetryReport;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.data = this.loadFromDisk();
    this.startFlushInterval();
  }

  private loadFromDisk(): CpTelemetryReport {
    try {
      if (existsSync(DATA_FILE)) {
        const raw = readFileSync(DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw) as CpTelemetryReport;
        if (parsed.routes) return parsed;
      }
    } catch { /* start fresh */ }
    return emptyReport();
  }

  private mergeEdgeCounters(): void {
    const edgeCounts = drainCounters();
    for (const [route, count] of Object.entries(edgeCounts)) {
      this.data.routes[route] = (this.data.routes[route] || 0) + count;
    }
    if (Object.keys(edgeCounts).length > 0) {
      this.dirty = true;
    }
  }

  private writeToDisk(): void {
    this.mergeEdgeCounters();
    if (!this.dirty) return;
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      this.data.last_flush = new Date().toISOString();
      writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch (e) {
      console.error("[cp-telemetry] Write failed:", e instanceof Error ? e.message : e);
    }
  }

  private startFlushInterval(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.writeToDisk(), FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  trackRoute(pathname: string): void {
    const normalized = this.normalizeRoute(pathname);
    this.data.routes[normalized] = (this.data.routes[normalized] || 0) + 1;
    this.dirty = true;
  }

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
        message: message.slice(0, 200),
        count: 1,
        last_seen: new Date().toISOString(),
      });
      if (this.data.errors.length > 100) {
        this.data.errors = this.data.errors.slice(-100);
      }
    }
    this.dirty = true;
  }

  getReport(): CpTelemetryReport {
    this.mergeEdgeCounters();
    this.writeToDisk();
    return { ...this.data };
  }

  reset(): void {
    drainCounters(); // Clear edge counters too
    this.data = emptyReport();
    this.dirty = true;
    this.writeToDisk();
  }

  private normalizeRoute(pathname: string): string {
    let p = pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;
    p = p.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "/[id]"
    );
    p = p.replace(/\/\d+(?=\/|$)/g, "/[id]");
    return p;
  }
}

const TRACKER_KEY = "__cp_telemetry_tracker__";

function getTracker(): CpUsageTracker {
  const g = globalThis as unknown as Record<string, CpUsageTracker>;
  if (!g[TRACKER_KEY]) {
    g[TRACKER_KEY] = new CpUsageTracker();
  }
  return g[TRACKER_KEY];
}

export const cpTracker = getTracker();

export function trackRoute(pathname: string): void {
  cpTracker.trackRoute(pathname);
}

export function trackError(route: string, message: string): void {
  cpTracker.trackError(route, message);
}

export function getCpTelemetryReport(): CpTelemetryReport {
  return cpTracker.getReport();
}

export function resetCpTelemetry(): void {
  cpTracker.reset();
}
