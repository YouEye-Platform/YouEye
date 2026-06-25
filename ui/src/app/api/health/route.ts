/**
 * Health Check Route
 *
 * GET /api/health
 * Returns 200 OK if the application is running. Used by monitoring.
 * Also triggers schema initialization on first call.
 */

import { NextResponse } from "next/server";
import { ensureSchema } from "@/db";

export async function GET() {
  // Initialize DB schema on first health check (runs once, no-ops after)
  try {
    await ensureSchema();
  } catch {
    // Don't fail health check if DB isn't ready yet
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
