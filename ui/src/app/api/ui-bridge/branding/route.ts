import { NextRequest, NextResponse } from "next/server";
import { getBranding, updateBranding, setBrandingAsset, BrandingConflictError } from "@/lib/db/queries/branding";
import { getBridgeToken } from "@/lib/admin/bridge-client";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function GET(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const branding = await getBranding();
  return NextResponse.json(branding, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const updated = await updateBranding({
      site_name: body.site_name,
      site_name_style: body.site_name_style,
      accent_color: body.accent_color,
      icon_config: body.icon_config,
      expected_revision: body.expected_revision,
    });

    // Auto-render icon if in letter mode
    if (body.icon_config?.mode === "letter" && updated.site_name_style && !updated.site_name_style.mytitle) {
      try {
        const { renderIconPNGs } = await import("@/lib/icon-renderer");
        await renderIconPNGs(body.icon_config, updated.site_name, updated.site_name_style);
      } catch (err) {
        console.warn("[bridge-branding] Non-fatal: icon render failed:", err);
      }
    }

    if (body.logo_url !== undefined && !updated.site_name_style?.mytitle) {
      await setBrandingAsset("logo", body.logo_url);
    }
    if (body.favicon_url !== undefined && !updated.site_name_style?.mytitle) {
      await setBrandingAsset("favicon", body.favicon_url);
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof BrandingConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "Invalid branding data" }, { status: 400 });
  }
}
