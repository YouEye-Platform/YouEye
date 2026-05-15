/**
 * Branding API
 *
 * GET  /api/v1/branding — Get instance branding (public)
 * PUT  /api/v1/branding — Update branding (admin only)
 *
 * When wordart (site_name_style) changes and the icon is in letter mode,
 * the icon PNGs are automatically re-rendered.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBranding, updateBranding } from "@/lib/db/queries/branding";
import { renderIconPNGs } from "@/lib/icon-renderer";
import type { IconConfig } from "@/lib/icon-config";

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
      icon_config: body.icon_config,
    });

    // Auto-regenerate icon PNGs if the effective icon is in letter mode.
    // This handles two cases:
    // 1. Icon config was explicitly set to letter mode in this request
    // 2. Wordart changed and the existing icon config is in letter mode
    const effectiveIcon = (body.icon_config ?? updated.icon_config) as
      | IconConfig
      | null
      | undefined;

    if (effectiveIcon?.mode === "letter" && updated.site_name_style) {
      try {
        await renderIconPNGs(
          effectiveIcon,
          updated.site_name,
          updated.site_name_style
        );
      } catch (err) {
        console.warn("[branding] Non-fatal: icon render failed:", err);
      }
    }

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Invalid branding data" },
      { status: 400 }
    );
  }
}
