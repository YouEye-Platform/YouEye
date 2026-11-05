/**
 * Edge-compatible route counter (no Node.js APIs)
 *
 * Used by the middleware to track route hits in memory.
 * The full tracker (tracker.ts) merges these counters when flushing to disk.
 *
 * Works in both Edge and Node.js runtimes via globalThis.
 */

const COUNTER_KEY = "__cp_telemetry_counters__";

interface CounterStore {
  routes: Record<string, number>;
  period_start: string;
}

function getStore(): CounterStore {
  const g = globalThis as unknown as Record<string, CounterStore>;
  if (!g[COUNTER_KEY]) {
    g[COUNTER_KEY] = { routes: {}, period_start: new Date().toISOString() };
  }
  return g[COUNTER_KEY];
}

function normalizeRoute(pathname: string): string {
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

/** Increment route counter (Edge-safe, no I/O) */
export function countRoute(pathname: string): void {
  const store = getStore();
  const key = normalizeRoute(pathname);
  store.routes[key] = (store.routes[key] || 0) + 1;
}

/** Read and clear counters (called by the Node.js tracker on flush) */
export function drainCounters(): Record<string, number> {
  const store = getStore();
  const routes = { ...store.routes };
  store.routes = {};
  return routes;
}
