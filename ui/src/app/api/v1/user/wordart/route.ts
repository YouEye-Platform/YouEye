import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getUserWordartOverride,
  saveUserWordartOverride,
  deleteUserWordartOverride,
} from "@/lib/db/queries/settings";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const override = await getUserWordartOverride(session.userId);
  return NextResponse.json({ wordart: override });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    if (!body.wordart || typeof body.wordart !== "object") {
      return NextResponse.json({ error: "Invalid wordart data" }, { status: 400 });
    }
    await saveUserWordartOverride(session.userId, body.wordart);
    return NextResponse.json({ wordart: body.wordart });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await deleteUserWordartOverride(session.userId);
  return NextResponse.json({ wordart: null });
}
