/**
 * Admin Authentik Branding API
 *
 * POST /api/admin/authentik/branding
 *
 * Pushes theme CSS to the Authentik login page via the CP bridge.
 * Callable with:
 *   - { colors } — uses provided colors + fetches branding from DB
 *   - {} (empty body) — fetches both active theme and branding from DB ("sync now")
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { bridgeRequest, BridgeError } from "@/lib/admin/bridge-client";
import { generateAuthentikCSS } from "@/lib/themes/css-generator";
import { getBranding } from "@/lib/db/queries/branding";
import { getUserActiveTheme, getDefaultTheme } from "@/lib/db/queries/themes";
import type { ThemeColors } from "@/db/schema";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Colors can be passed explicitly (from theme change) or fetched from DB
    const body = await request.json().catch(() => ({}));
    let colors: ThemeColors;

    if (body.colors) {
      colors = body.colors;
    } else {
      // Fetch the current user's active theme, or fall back to default
      const active = await getUserActiveTheme(session.userId);
      if (active) {
        colors = active.theme.colors;
      } else {
        const defaultTheme = await getDefaultTheme();
        if (!defaultTheme) {
          return NextResponse.json(
            { error: "No theme available" },
            { status: 404 }
          );
        }
        colors = defaultTheme.colors;
      }
    }

    // Fetch branding config for WordArt / site name
    const branding = await getBranding();
    const siteNameStyle = branding.site_name_style ?? undefined;
    const fontSlug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

    // Detect font files and format from the public/fonts directory
    let fontFileFormat: 'woff2' | 'truetype' = 'truetype';
    let fontSlugStr: string | undefined;
    let fontFiles: string[] | undefined;
    if (siteNameStyle?.fontFamily && siteNameStyle.fontFamily !== "Inter") {
      fontSlugStr = fontSlug(siteNameStyle.fontFamily);
      const fontDir = join(process.cwd(), 'public', 'fonts', fontSlugStr);
      if (existsSync(fontDir)) {
        try {
          const allFiles = await readdir(fontDir);
          fontFiles = allFiles.filter(f => /\.(ttf|woff2?|otf)$/.test(f));
          const hasWoff2 = fontFiles.some(f => f.endsWith('.woff2'));
          fontFileFormat = hasWoff2 ? 'woff2' : 'truetype';
        } catch { /* fallback to truetype */ }
      }
    }

    // Generate Authentik CSS with correct Shadow DOM selectors.
    // siteName is passed so ::part(branding)::after can render it via CSS content.
    const css = generateAuthentikCSS(colors, {
      siteNameStyle,
      fontFileFormat,
      fontFiles,
      siteName: branding.site_name,
    });

    // Push to CP bridge — include WordArt style for SVG logo generation
    // Also pass fontSlug so the bridge can copy font files into Authentik
    const bridgeRes = await bridgeRequest("authentik/branding", {
      method: "POST",
      body: JSON.stringify({
        css,
        siteName: `${branding.site_name} ID`,
        siteNameStyle: siteNameStyle ?? null,
        fontSlug: fontSlugStr ?? null,
      }),
    });

    if (!bridgeRes.ok) {
      const text = await bridgeRes.text().catch(() => "");
      console.error("[authentik-branding] Bridge error:", text);
      return NextResponse.json(
        { error: "Failed to update Authentik branding" },
        { status: bridgeRes.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof BridgeError) {
      console.warn("[authentik-branding] Bridge unavailable:", error.code);
      return NextResponse.json(
        { error: "Control Panel bridge unavailable", code: error.code },
        { status: 503 }
      );
    }
    console.error("[authentik-branding] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
