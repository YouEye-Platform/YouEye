/**
 * CP Telemetry Export Endpoint
 *
 * GET    — download the Control Panel's local usage report (admin only).
 * DELETE — reset (delete) the local usage data (admin + CSRF).
 *
 * Local-only beta usage stats (D18): no PII, never leaves the server unless an
 * admin downloads it here. Admin-gated — these are server-wide statistics.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, verifyCSRFToken } from "@/lib/auth";
import { getCpTelemetryReport, resetCpTelemetry } from "@/lib/telemetry/tracker";

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const report = getCpTelemetryReport();
  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="youeye-cp-usage-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const csrf = request.headers.get("X-CSRF-Token");
  if (!csrf || !(await verifyCSRFToken(csrf))) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }
  resetCpTelemetry();
  return NextResponse.json({ ok: true, message: "CP telemetry data reset" });
}
