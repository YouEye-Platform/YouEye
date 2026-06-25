/**
 * Widgets API
 *
 * GET  /api/widgets — Get current user's widget layout
 * PUT  /api/widgets — Save (replace) current user's widget layout
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserWidgets, saveUserWidgets } from "@/lib/db/queries/widgets";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const widgetList = await getUserWidgets(session.userId);
  return NextResponse.json({ widgets: widgetList });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const widgetList = Array.isArray(body.widgets) ? body.widgets : body;

    const saved = await saveUserWidgets(session.userId, widgetList);
    return NextResponse.json({ widgets: saved });
  } catch (error) {
    console.error("Widget save error:", error);
    return NextResponse.json(
      { error: "Invalid widget data" },
      { status: 400 }
    );
  }
}
