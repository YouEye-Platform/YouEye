/**
 * PIN Change API
 *
 * POST — Change encryption PIN (re-encrypts all timeline entries)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { changePIN, validTimelineSecret } from "@/lib/crypto/pin-session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { current_pin, new_pin } = body;

  if (!validTimelineSecret(current_pin) || !validTimelineSecret(new_pin)) {
    return NextResponse.json(
      { error: "Both current_pin and new_pin are required" },
      { status: 400 }
    );
  }

  try {
    const success = await changePIN(session.userId, current_pin, new_pin);

    if (!success) {
      return NextResponse.json(
        { error: "Current PIN is incorrect" },
        { status: 403 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to change PIN";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
