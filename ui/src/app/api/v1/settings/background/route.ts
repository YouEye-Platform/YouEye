/**
 * Background Settings API
 *
 * GET  /api/settings/background — Get current user's background preferences
 * PUT  /api/settings/background — Save background preferences
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getUserBackground,
  saveUserBackground,
} from "@/lib/db/queries/settings";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bg = await getUserBackground(session.userId);
  return NextResponse.json(bg);
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { type, settings } = body;

    if (!type || typeof type !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'type'" },
        { status: 400 }
      );
    }

    const saved = await saveUserBackground(
      session.userId,
      type,
      settings ?? {}
    );
    return NextResponse.json(saved);
  } catch (error) {
    console.error("Background settings save error:", error);
    return NextResponse.json(
      { error: "Invalid background data" },
      { status: 400 }
    );
  }
}
