/**
 * Drawer Sections API
 *
 * PUT /api/apps/drawer/sections — Update user's drawer sections
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateDrawerSections } from "@/lib/db/queries/apps";

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (!Array.isArray(body.sections)) {
      return NextResponse.json(
        { error: "Missing sections array" },
        { status: 400 }
      );
    }

    const sections = await updateDrawerSections(
      session.userId,
      body.sections.map((s: { id: string; name: string; order: number; collapsed?: boolean }) => ({
        id: s.id,
        name: s.name,
        order: s.order ?? 0,
        collapsed: s.collapsed ?? false,
      }))
    );

    return NextResponse.json({ sections });
  } catch {
    return NextResponse.json(
      { error: "Invalid section data" },
      { status: 400 }
    );
  }
}
