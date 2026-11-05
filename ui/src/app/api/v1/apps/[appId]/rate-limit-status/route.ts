/**
 * Rate Limit Status API (admin only)
 *
 * GET /api/v1/apps/[appId]/rate-limit-status
 *
 * Returns current rate limit counts per endpoint for an app.
 * Used by the health dashboard and monitoring.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getRateLimitStatus, RATE_LIMITS } from "@/lib/rate-limit";

interface Params {
  params: Promise<{ appId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admin only
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { appId } = await params;
  const statuses = getRateLimitStatus(appId);

  // Enrich with actual limits from config
  const enriched = statuses.map((s) => {
    const configKey = s.endpoint as keyof typeof RATE_LIMITS;
    const config = RATE_LIMITS[configKey];
    return {
      ...s,
      limit: config?.limit ?? 0,
      windowMs: config?.windowMs ?? 60_000,
    };
  });

  return NextResponse.json({
    appId,
    endpoints: enriched,
    availableLimits: Object.entries(RATE_LIMITS).map(([name, cfg]) => ({
      name,
      limit: cfg.limit,
      windowMs: cfg.windowMs,
    })),
  });
}
