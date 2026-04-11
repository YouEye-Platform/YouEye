/**
 * Themes API
 *
 * GET  /api/themes — List all themes (presets + user-created)
 * POST /api/themes — Create a custom theme (admin only)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listThemes, createTheme } from "@/lib/db/queries/themes";
import type { ThemeColors } from "@/db/schema";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const allThemes = await listThemes();
    return NextResponse.json(allThemes);
  } catch (error) {
    console.error("[themes] Failed to list themes:", error);
    return NextResponse.json(
      { error: "Failed to load themes" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { name, colors } = body as { name: string; colors: ThemeColors };

    if (!name || !colors) {
      return NextResponse.json(
        { error: "Name and colors are required" },
        { status: 400 }
      );
    }

    const theme = await createTheme({
      name,
      colors,
      createdBy: session.userId,
    });

    return NextResponse.json(theme, { status: 201 });
  } catch (error) {
    console.error("[themes] Failed to create theme:", error);
    return NextResponse.json(
      { error: "Failed to create theme" },
      { status: 500 }
    );
  }
}
