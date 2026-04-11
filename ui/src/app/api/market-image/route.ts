/**
 * GET /api/market-image?url=<encoded-url>
 *
 * UI-side image proxy for marketplace app icons and screenshots.
 * Forwards the request to the Control Panel's image proxy via the bridge,
 * which fetches the actual image server-side (bypassing self-signed TLS certs).
 *
 * Auth: Requires valid session (any authenticated user can view app icons).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { bridgeRequest, BridgeError } from "@/lib/admin/bridge-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // No auth required — icons and screenshots are public catalog data.
  // Security is handled by the CP's domain allowlist in the image proxy.
  const imageUrl = request.nextUrl.searchParams.get("url");
  if (!imageUrl) {
    return NextResponse.json({ error: "url parameter required" }, { status: 400 });
  }

  try {
    // Forward to CP's ui-bridge market endpoint with action=image
    const bridgePath = `market?action=image&url=${encodeURIComponent(imageUrl)}`;
    const cpResponse = await bridgeRequest(bridgePath);

    if (!cpResponse.ok) {
      const text = await cpResponse.text();
      return NextResponse.json(
        { error: `CP image proxy error: ${cpResponse.status} ${text}` },
        { status: cpResponse.status }
      );
    }

    const contentType = cpResponse.headers.get("content-type") || "application/octet-stream";
    const buffer = await cpResponse.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    if (error instanceof BridgeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 502 }
      );
    }

    console.error("[market-image] Proxy error:", error);
    return NextResponse.json(
      { error: `Image proxy error: ${error}` },
      { status: 502 }
    );
  }
}
