import { NextRequest, NextResponse } from "next/server";
import { getBranding, updateBranding, setBrandingAsset } from "@/lib/db/queries/branding";
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
  return NextResponse.json(branding);
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
    });

    // Auto-render icon if in letter mode
    if (body.icon_config?.mode === "letter" && updated.site_name_style) {
      try {
        const { renderIconPNGs } = await import("@/lib/icon-renderer");
        await renderIconPNGs(body.icon_config, updated.site_name, updated.site_name_style);
      } catch (err) {
        console.warn("[bridge-branding] Non-fatal: icon render failed:", err);
      }
    }

    if (body.logo_url !== undefined) {
      await setBrandingAsset("logo", body.logo_url);
    }
    if (body.favicon_url !== undefined) {
      await setBrandingAsset("favicon", body.favicon_url);
    }

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Invalid branding data" }, { status: 400 });
  }
}
