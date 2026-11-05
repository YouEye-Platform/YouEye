/**
 * Telemetry Export Endpoint
 *
 * Returns the full usage report as a downloadable JSON file.
 * Admin-only access — this is system-wide telemetry data.
 *
 * GET /api/v1/telemetry/export — returns the report
 * DELETE /api/v1/telemetry/export — resets counters and starts fresh
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getTelemetryReport, resetTelemetry } from "@/lib/telemetry/tracker";

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const report = getTelemetryReport();

  // Add platform info for context
  const exportData = {
    ...report,
    platform: {
      ui_version: process.env.npm_package_version || "unknown",
      node_version: process.version,
      export_date: new Date().toISOString(),
    },
  };

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="youeye-usage-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}

export async function DELETE() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  resetTelemetry();
  return NextResponse.json({ ok: true, message: "Telemetry data reset" });
}
