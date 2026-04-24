/**
 * Dynamic Favicon Route
 *
 * Serves the rendered 32px favicon PNG.
 * Auto-regenerates from DB config if files are missing (e.g., after deploy).
 */

import { ImageResponse } from "next/og";
import { getRenderedIcon, renderIconPNGs } from "@/lib/icon-renderer";
import { getBranding } from "@/lib/db/queries/branding";
import type { IconConfig } from "@/lib/icon-config";

export const dynamic = "force-dynamic";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  // Try cached file first
  let buf = await getRenderedIcon(32);

  // Auto-regenerate from DB config if missing (self-heals after deploy)
  if (!buf) {
    try {
      const branding = await getBranding();
      const config = branding.icon_config as IconConfig | null;
      if (config?.mode === "letter" && branding.site_name_style) {
        await renderIconPNGs(config, branding.site_name, branding.site_name_style);
        buf = await getRenderedIcon(32);
      }
    } catch {
      // Fall through to fallback
    }
  }

  if (buf) {
    return new Response(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // Fallback: generate a simple "Y" icon
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#8B5CF6",
          borderRadius: "6px",
          color: "#fff",
          fontSize: "20px",
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        Y
      </div>
    ),
    { ...size }
  );
}
