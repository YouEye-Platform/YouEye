/**
 * Branding API
 *
 * GET  /api/branding — Get instance branding (public)
 * PUT  /api/branding — Update branding (admin only)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBranding, updateBranding } from "@/lib/db/queries/branding";

export async function GET() {
  const branding = await getBranding();
  return NextResponse.json(branding);
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const updated = await updateBranding({
      site_name: body.site_name,
      site_name_style: body.site_name_style,
      accent_color: body.accent_color,
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Invalid branding data" },
      { status: 400 }
    );
  }
}
