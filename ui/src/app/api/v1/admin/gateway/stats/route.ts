/**
 * Gateway Monitoring Stats API (admin only)
 *
 * GET /api/v1/admin/gateway/stats
 *
 * Returns per-app request stats: counts, error rates, avg response times.
 * Used by the health dashboard to display gateway activity.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getGatewayStats } from "@/lib/db/queries/gateway";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const stats = await getGatewayStats();
    return NextResponse.json({
      stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch gateway stats", detail: String(err) },
      { status: 500 }
    );
  }
}
