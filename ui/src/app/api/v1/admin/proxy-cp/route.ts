/**
 * Admin CP Proxy — /api/v1/admin/proxy-cp
 *
 * Proxies requests from the UI client to the Control Panel internal API.
 * Admin-only. Used by the Permissions settings page.
 *
 * GET  ?path=/api/bridges         → forwards GET to CP
 * POST { path, method, body? }    → forwards method+body to CP
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const CP_URL =
  process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path query param required" }, { status: 400 });
  }

  try {
    const res = await fetch(`${CP_URL}${path}`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "CP unreachable" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { path, method, body } = await request.json();
  if (!path || !method) {
    return NextResponse.json({ error: "path and method required" }, { status: 400 });
  }

  try {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body && method !== "GET" && method !== "DELETE") {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${CP_URL}${path}`, opts);

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return new NextResponse(null, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "CP unreachable" }, { status: 502 });
  }
}
