/**
 * GET /api/v1/admin/install-progress
 *
 * Proxies to CP's install-progress endpoint so the UI client
 * can poll for active app installs without CORS issues.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const CP_INTERNAL_URL =
  process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await fetch(
      `${CP_INTERNAL_URL}/api/ui-bridge/market?action=install-progress`,
      {
        headers: { cookie: request.headers.get("cookie") || "" },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) {
      return NextResponse.json({ installs: [] });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ installs: [] });
  }
}
