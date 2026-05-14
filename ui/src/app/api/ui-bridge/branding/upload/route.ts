/**
 * Branding Upload Bridge Endpoint (UI side)
 *
 * POST /api/ui-bridge/branding/upload
 *
 * Receives file uploads from the Control Panel bridge and saves them like the public upload endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { setBrandingAsset } from "@/lib/db/queries/branding";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const ASSET_DIR = join(process.cwd(), "public", "branding");
const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const MAX_FAVICON_SIZE = 100 * 1024;
const ALLOWED_TYPES = [
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/jpeg",
  "image/webp",
];

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
    const file = formData.get("file") as File | null;
    const type = formData.get("type") as string | null;

    if (!file || !type || !["logo", "favicon"].includes(type)) {
      return NextResponse.json(
        { error: "Missing file or invalid type (logo|favicon)" },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Allowed: PNG, SVG, ICO, JPEG, WebP" },
        { status: 400 }
      );
    }

    const maxSize = type === "logo" ? MAX_LOGO_SIZE : MAX_FAVICON_SIZE;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File too large. Max: ${maxSize / 1024}KB` },
        { status: 400 }
      );
    }

    await mkdir(ASSET_DIR, { recursive: true });

    const ext = file.name.split(".").pop() ?? "png";
    const filename = `${type}-${randomUUID()}.${ext}`;
    const filepath = join(ASSET_DIR, filename);
    const bytes = await file.arrayBuffer();
    await writeFile(filepath, Buffer.from(bytes));

    const url = `/branding/${filename}`;
    await setBrandingAsset(type as "logo" | "favicon", url);

    return NextResponse.json({ url }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
