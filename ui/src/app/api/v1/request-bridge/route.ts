/**
 * Bridge Request API — POST /api/v1/request-bridge
 *
 * Apps call this to request a bridge connection.
 * Admin requests are fulfilled immediately; non-admin creates pending request.
 *
 * Body: { targetAppId: string }
 * Auth: X-YouEye-App header identifies the calling app.
 */

import { NextResponse } from "next/server";

const CP_URL =
  process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

export async function POST(request: Request) {
  const appSlug = request.headers.get("X-YouEye-App") ??
    request.headers.get("x-youeye-app");

  if (!appSlug) {
    return NextResponse.json(
      { error: "X-YouEye-App header required" },
      { status: 401 },
    );
  }

  const body = await request.json();
  const { targetAppId } = body;

  if (!targetAppId) {
    return NextResponse.json(
      { error: "targetAppId is required" },
      { status: 400 },
    );
  }

  try {
    // Create bridge via CP API
    const res = await fetch(`${CP_URL}/api/bridges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: appSlug,
        to: targetAppId,
        direction: "one-way",
        approvedBy: "app-request",
        activate: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: "Bridge creation failed", details: err },
        { status: res.status },
      );
    }

    return NextResponse.json({ pending: false });
  } catch (err) {
    console.error("[request-bridge] Error:", err);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 },
    );
  }
}
