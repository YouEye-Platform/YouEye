/**
 * PIN Status API
 *
 * GET — Check if user has PIN set up, and if session is active
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasPIN, hasActivePINSession } from "@/lib/crypto/pin-session";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pinExists = await hasPIN(session.userId);
  const sessionActive = pinExists
    ? await hasActivePINSession(session.userId)
    : false;

  return NextResponse.json({
    has_pin: pinExists,
    session_active: sessionActive,
  });
}
