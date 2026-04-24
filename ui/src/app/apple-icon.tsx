/**
 * Apple Touch Icon Route (180x180)
 */

import { ImageResponse } from "next/og";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const iconPath = join(process.cwd(), "public", "branding", "icon-180.png");

  if (existsSync(iconPath)) {
    const buf = await readFile(iconPath);
    return new Response(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

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
          borderRadius: "36px",
          color: "#fff",
          fontSize: "110px",
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
