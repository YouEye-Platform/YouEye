/**
 * Internal telemetry tracking endpoint (Node.js runtime).
 *
 * Receives route hits from the Edge middleware via fire-and-forget fetch.
 * This works around the Edge/Node.js globalThis split — middleware can't
 * use fs directly, so it POSTs here instead.
 */

import { NextResponse } from "next/server";
import { trackRoute } from "@/lib/telemetry/tracker";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.route && typeof body.route === "string") {
      trackRoute(body.route);
    }
  } catch { /* best-effort */ }
  return NextResponse.json({ ok: true });
}
