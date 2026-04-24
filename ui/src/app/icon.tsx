/**
 * Dynamic Favicon Route
 *
 * Next.js uses this to generate the favicon metadata.
 * Reads from the rendered icon PNGs in /public/branding/.
 */

import { ImageResponse } from "next/og";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const iconPath = join(process.cwd(), "public", "branding", "icon-32.png");

  if (existsSync(iconPath)) {
    const buf = await readFile(iconPath);
    return new Response(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
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
