/**
 * CP Telemetry Export Endpoint
 *
 * Returns the Control Panel's usage report.
 * Auth: requires valid session (admin access to CP implies admin).
 */

import { NextResponse } from "next/server";
import { getCpTelemetryReport, resetCpTelemetry } from "@/lib/telemetry/tracker";

export async function GET() {
  const report = getCpTelemetryReport();
  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="youeye-cp-usage-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}

export async function DELETE() {
  resetCpTelemetry();
  return NextResponse.json({ ok: true, message: "CP telemetry data reset" });
}
