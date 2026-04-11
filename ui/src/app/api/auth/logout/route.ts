/**
 * Logout Route
 *
 * POST /api/auth/logout
 * Clears session cookies and returns success.
 */

import { NextResponse } from "next/server";
import { clearSessionCookies, getSession } from "@/lib/auth";

export async function POST() {
  try {
    const session = await getSession();
    if (session) {
      console.log(`User "${session.username}" logged out`);
    }

    await clearSessionCookies();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
