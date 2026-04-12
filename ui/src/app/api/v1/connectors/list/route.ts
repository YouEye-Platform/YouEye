/**
 * GET /api/v1/connectors/list — List available connectors
 * Proxies to CP /api/connectors with optional capability filter
 */

import { NextResponse } from "next/server";

const CP_API_URL = process.env.CP_API_URL ?? "http://youeye-control.incus:3000/api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const capability = url.searchParams.get("capability");

  try {
    const cpUrl = capability
      ? `${CP_API_URL}/connectors?capability=${encodeURIComponent(capability)}`
      : `${CP_API_URL}/connectors`;

    const res = await fetch(cpUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return NextResponse.json({ error: "CP unavailable" }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "CP unreachable" }, { status: 502 });
  }
}
