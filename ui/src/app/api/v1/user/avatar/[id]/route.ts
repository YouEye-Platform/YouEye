/**
 * Avatar Serving Endpoint
 *
 * GET /api/v1/user/avatar/[id] — serves a user's avatar image
 *
 * Public (no auth required). Profile pictures are inherently public —
 * native apps on different subdomains need to load them in <img> tags
 * without cross-domain cookies. Same pattern as Gravatar/GitHub avatars.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const AVATAR_DIR = "/var/lib/youeye/ui-data/avatars";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Sanitize: only allow UUID-like IDs (prevent path traversal)
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const filePath = `${AVATAR_DIR}/${id}.webp`;

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "Avatar not found" }, { status: 404 });
  }

  try {
    const fileBuffer = await readFile(filePath);
    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read avatar" }, { status: 500 });
  }
}
