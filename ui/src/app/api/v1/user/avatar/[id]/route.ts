/**
 * Avatar Serving Endpoint
 *
 * GET /api/v1/user/avatar/[id] — serves a user's avatar image
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const AVATAR_DIR = "/var/lib/youeye/ui-data/avatars";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
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
