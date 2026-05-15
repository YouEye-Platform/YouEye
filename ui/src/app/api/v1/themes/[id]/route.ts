/**
 * Single Theme API
 *
 * PUT    /api/themes/[id] — Update a custom theme (admin only)
 * DELETE /api/themes/[id] — Delete a custom theme (admin only)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateTheme, deleteTheme } from "@/lib/db/queries/themes";
import type { ThemeColors } from "@/db/schema";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const { name, colors } = body as {
      name?: string;
      colors?: ThemeColors;
    };

    const updated = await updateTheme(id, { name, colors });
    if (!updated) {
      return NextResponse.json(
        { error: "Theme not found or is a preset" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("[themes] Failed to update theme:", error);
    return NextResponse.json(
      { error: "Failed to update theme" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const deleted = await deleteTheme(id);
    if (!deleted) {
      return NextResponse.json(
        { error: "Theme not found or is a preset" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[themes] Failed to delete theme:", error);
    return NextResponse.json(
      { error: "Failed to delete theme" },
      { status: 500 }
    );
  }
}
