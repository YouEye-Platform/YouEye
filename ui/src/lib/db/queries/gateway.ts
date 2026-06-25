/**
 * Gateway Request Queries
 *
 * Logs and queries inter-app API calls through the YE-UI gateway.
 * Rolling window: keeps last 10,000 entries, auto-deletes older ones.
 */

import { db, ensureSchema } from "@/db";
import { gatewayRequests } from "@/db/schema";
import { desc, sql, eq, and, gte } from "drizzle-orm";

const MAX_ENTRIES = 10_000;

// ─── Logging ────────────────────────────────────────────

/**
 * Log a gateway request. Auto-cleans old entries beyond the rolling window.
 */
export async function logGatewayRequest(data: {
  appSlug: string;
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
  rateLimited?: boolean;
}): Promise<void> {
  await ensureSchema();

  await db.insert(gatewayRequests).values({
    appSlug: data.appSlug,
    endpoint: data.endpoint,
    method: data.method,
    statusCode: data.statusCode,
    durationMs: data.durationMs,
    rateLimited: data.rateLimited ?? false,
  });

  // Cleanup: delete oldest entries beyond the rolling window
  // Only run cleanup ~1% of the time to avoid overhead
  if (Math.random() < 0.01) {
    await cleanupOldEntries();
  }
}

async function cleanupOldEntries(): Promise<void> {
  try {
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(gatewayRequests);

    const count = Number(countResult?.count ?? 0);
    if (count <= MAX_ENTRIES) return;

    const toDelete = count - MAX_ENTRIES;
    // Delete oldest entries
    await db.execute(sql`
      DELETE FROM gateway_requests
      WHERE id IN (
        SELECT id FROM gateway_requests
        ORDER BY created_at ASC
        LIMIT ${toDelete}
      )
    `);
  } catch {
    // Best effort cleanup
  }
}

// ─── Stats ──────────────────────────────────────────────

export interface GatewayAppStats {
  appSlug: string;
  requestCount1h: number;
  requestCount24h: number;
  errorRate: number;
  avgResponseMs: number;
  rateLimitViolations: number;
  topEndpoints: Array<{ endpoint: string; count: number }>;
}

/**
 * Get per-app gateway stats for the monitoring dashboard.
 * Returns aggregated stats for each app over the last 1h and 24h.
 */
export async function getGatewayStats(): Promise<GatewayAppStats[]> {
  await ensureSchema();

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Get all requests from the last 24h
  const rows = await db
    .select()
    .from(gatewayRequests)
    .where(gte(gatewayRequests.createdAt, twentyFourHoursAgo))
    .orderBy(desc(gatewayRequests.createdAt));

  // Group by app slug
  const byApp = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = byApp.get(row.appSlug) ?? [];
    existing.push(row);
    byApp.set(row.appSlug, existing);
  }

  const stats: GatewayAppStats[] = [];

  for (const [appSlug, appRows] of byApp) {
    const last1h = appRows.filter(
      (r) => r.createdAt && r.createdAt >= oneHourAgo
    );

    const errors = appRows.filter(
      (r) => r.statusCode >= 400
    );
    const rateLimited = appRows.filter((r) => r.rateLimited);

    const totalDuration = appRows.reduce(
      (sum, r) => sum + (r.durationMs ?? 0),
      0
    );

    // Top endpoints
    const endpointCounts = new Map<string, number>();
    for (const r of appRows) {
      endpointCounts.set(
        r.endpoint,
        (endpointCounts.get(r.endpoint) ?? 0) + 1
      );
    }
    const topEndpoints = [...endpointCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([endpoint, count]) => ({ endpoint, count }));

    stats.push({
      appSlug,
      requestCount1h: last1h.length,
      requestCount24h: appRows.length,
      errorRate:
        appRows.length > 0 ? errors.length / appRows.length : 0,
      avgResponseMs:
        appRows.length > 0
          ? Math.round(totalDuration / appRows.length)
          : 0,
      rateLimitViolations: rateLimited.length,
      topEndpoints,
    });
  }

  return stats;
}
