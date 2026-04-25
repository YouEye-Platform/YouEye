/**
 * Icon Upload Bridge Endpoint (UI side)
 *
 * POST /api/ui-bridge/branding/icon
 *
 * Receives multipart (icon_config + icon_blob) from CP bridge and
 * processes them identically to the public icon endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { getBranding, updateBranding } from "@/lib/db/queries/branding";
import { renderIconPNGs } from "@/lib/icon-renderer";
import type { IconConfig } from "@/lib/icon-config";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function POST(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    await updateBranding({ icon_config: iconConfig });

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
    console.error("[bridge-icon] Render error:", err);
    return NextResponse.json(
      { error: "Icon render failed" },
      { status: 500 }
    );
  }
}
