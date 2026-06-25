/**
 * PIN Session API
 *
 * DELETE — End the current PIN session (lock timeline)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { endPINSession } from "@/lib/crypto/pin-session";

export async function DELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await endPINSession(session.userId);

  return NextResponse.json({ success: true });
}
