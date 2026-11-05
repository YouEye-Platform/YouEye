/**
 * PIN Create API
 *
 * POST — Set up encryption PIN for the first time
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createPIN, validTimelineSecret } from "@/lib/crypto/pin-session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { pin } = body;

  if (!validTimelineSecret(pin)) {
    return NextResponse.json(
      { error: "Use an exact secret of 4–1024 UTF-16 units" },
      { status: 400 }
    );
  }

  try {
    const result = await createPIN(session.userId, pin);
    return NextResponse.json({
      success: true,
      session_id: result.sessionId,
    });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to create PIN";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
