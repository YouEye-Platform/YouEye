/**
 * Health Check Route
 *
 * GET /api/health
 * Configured runtimes return 200 only after database initialization succeeds.
 * An unconfigured runtime can boot for the setup wizard.
 */

import { NextResponse } from "next/server";
import { ensureSchema } from "@/db";
import { uiRuntimeHealth } from '@/lib/runtime-health';

export async function GET() {
  const health = await uiRuntimeHealth(
    Boolean(process.env.DATABASE_URL || process.env.IDENTITY_CLIENT_ID), ensureSchema,
  );

  return NextResponse.json({
    status: health.status,
    timestamp: new Date().toISOString(),
  }, { status: health.httpStatus });
}
