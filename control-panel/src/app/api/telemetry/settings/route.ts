/**
 * CP Telemetry Settings
 *
 * GET   — current local-usage-collection state ({ enabled }). Any session.
 * PATCH — turn local usage collection on/off ({ enabled }). Admin + CSRF.
 *
 * Backs the Privacy page's "Local usage statistics" switch with a real,
 * persisted flag (no fake control — pitfall #28). When disabled, the tracker
 * stops recording (see lib/telemetry/tracker.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, verifyCSRFToken } from "@/lib/auth";
import { isTelemetryEnabled, setTelemetryEnabled } from "@/lib/telemetry/tracker";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ enabled: isTelemetryEnabled() });
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const csrf = request.headers.get("X-CSRF-Token");
  if (!csrf || !(await verifyCSRFToken(csrf))) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }
  setTelemetryEnabled(body.enabled);
  return NextResponse.json({ enabled: body.enabled });
}
