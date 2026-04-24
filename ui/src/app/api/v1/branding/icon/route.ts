/**
 * Icon Render API
 *
 * POST /api/v1/branding/icon — Upload client-rendered icon PNG + save config
 * GET  /api/v1/branding/icon — Get rendered icon at requested size
 *
 * POST accepts multipart form data:
 *   - icon_config: JSON string of IconConfig
 *   - icon_blob: PNG file (client-rendered, required for emoji/lucide/upload modes)
 *
 * GET accepts query param: ?size=32 (default 32)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBranding, updateBranding } from "@/lib/db/queries/branding";
import { renderIconPNGs, getRenderedIcon } from "@/lib/icon-renderer";
import type { IconConfig } from "@/lib/icon-config";
import { ICON_SIZES, type IconSize } from "@/lib/icon-config";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const configStr = formData.get("icon_config") as string | null;
    const blob = formData.get("icon_blob") as File | null;

    if (!configStr) {
      return NextResponse.json(
        { error: "icon_config is required" },
        { status: 400 }
      );
    }

    const iconConfig: IconConfig = JSON.parse(configStr);
    const branding = await getBranding();

    // Save config to DB
    await updateBranding({ icon_config: iconConfig });

    // Render PNGs
    let sourceBlob: Buffer | undefined;
    if (blob) {
      sourceBlob = Buffer.from(await blob.arrayBuffer());
    }

    const urls = await renderIconPNGs(
      iconConfig,
      branding.site_name,
      branding.site_name_style,
      sourceBlob
    );

    return NextResponse.json({ icon_config: iconConfig, urls });
  } catch (err) {
    console.error("[icon] Render error:", err);
    return NextResponse.json(
      { error: "Icon render failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const sizeParam = request.nextUrl.searchParams.get("size") || "32";
  const size = parseInt(sizeParam, 10) as IconSize;

  if (!ICON_SIZES.includes(size)) {
    return NextResponse.json(
      { error: `Invalid size. Allowed: ${ICON_SIZES.join(", ")}` },
      { status: 400 }
    );
  }

  const buf = await getRenderedIcon(size);
  if (!buf) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
