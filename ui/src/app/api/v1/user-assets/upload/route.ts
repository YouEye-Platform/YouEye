/**
 * User Assets Upload API
 *
 * POST /api/user-assets/upload — Upload a user asset (icon, avatar)
 *
 * Form data:
 *   file: image binary
 *   type: "app-icon" | "avatar"
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createUserAsset } from "@/lib/db/queries/user-assets";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const ASSET_DIR = join(process.cwd(), "public", "user-assets");
const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
];

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const type = formData.get("type") as string | null;

    if (!file || !type) {
      return NextResponse.json(
        { error: "Missing file or type" },
        { status: 400 }
      );
    }

    if (!["app-icon", "avatar"].includes(type)) {
      return NextResponse.json(
        { error: "Invalid type (app-icon|avatar)" },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type" },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "File too large. Max 2MB" },
        { status: 400 }
      );
    }

    const userDir = join(ASSET_DIR, session.userId);
    await mkdir(userDir, { recursive: true });

    const ext = file.name.split(".").pop() ?? "png";
    const filename = `${type}-${randomUUID()}.${ext}`;
    const filepath = join(userDir, filename);
    const bytes = await file.arrayBuffer();
    await writeFile(filepath, Buffer.from(bytes));

    const storagePath = `/user-assets/${session.userId}/${filename}`;
    const asset = await createUserAsset({
      userId: session.userId,
      assetType: type,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      storagePath,
    });

    return NextResponse.json(
      { id: asset.id, url: storagePath },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
