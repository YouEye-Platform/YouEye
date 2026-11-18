/**
 * Internal telemetry tracking endpoint (Node.js runtime).
 *
 * Receives route hits from the proxy (src/proxy.ts) via fire-and-forget fetch, so counting never adds latency to
 * the request being proxied.
 */

import { NextResponse } from "next/server";
import { isTelemetryEnabled, trackRoute } from "@/lib/telemetry/tracker";

export async function POST(request: Request) {
  if (!isTelemetryEnabled()) {
    return NextResponse.json({ ok: true, recorded: false });
  }
  try {
    const body = await request.json();
    if (body.route && typeof body.route === "string") {
      trackRoute(body.route);
    }
  } catch { /* best-effort */ }
  return NextResponse.json({ ok: true });
}
