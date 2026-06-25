/**
 * PIN Verify API
 *
 * POST — Verify PIN and start encryption session
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { verifyPIN } from "@/lib/crypto/pin-session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { pin } = body;

  if (!pin || typeof pin !== "string") {
    return NextResponse.json({ error: "PIN is required" }, { status: 400 });
  }

  const result = await verifyPIN(session.userId, pin);

  if (!result) {
    return NextResponse.json({ error: "Invalid PIN" }, { status: 403 });
  }

  return NextResponse.json({
    success: true,
    session_id: result.sessionId,
  });
}
