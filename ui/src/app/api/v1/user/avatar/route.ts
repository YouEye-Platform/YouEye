/**
 * User Avatar Upload/Delete API
 *
 * POST   /api/v1/user/avatar — upload/save avatar locally
 * DELETE /api/v1/user/avatar — remove current avatar
 *
 * Local storage only. Authentik sync is handled by the CP embed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { saveAvatar, deleteAvatar } from "@/lib/avatar/storage";
import { db } from "@/db";
import { users, userAssets } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const MAX_INPUT_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Accepted: JPEG, PNG, WebP, GIF" },
        { status: 400 }
      );
    }

    if (file.size > MAX_INPUT_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum 5MB" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { storagePath, sizeBytes } = await saveAvatar(session.userId, buffer);
    // Cache-busting: append timestamp so browsers fetch the new image
    const servingUrl = `/api/v1/user/avatar/${session.userId}?v=${Date.now()}`;

    // Delete existing avatar asset record
    await db
      .delete(userAssets)
      .where(
        and(
          eq(userAssets.userId, session.userId),
          eq(userAssets.assetType, "avatar")
        )
      );

    // Insert new asset record
    await db.insert(userAssets).values({
      userId: session.userId,
      assetType: "avatar",
      filename: `${session.userId}.webp`,
      mimeType: "image/webp",
      sizeBytes,
      storagePath,
    });

    // Update user's image column with serving URL
    await db
      .update(users)
      .set({ image: servingUrl, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    return NextResponse.json({
      url: servingUrl,
      success: true,
    });
  } catch (error) {
    console.error("[Avatar] Upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await deleteAvatar(session.userId);

    // Remove asset record
    await db
      .delete(userAssets)
      .where(
        and(
          eq(userAssets.userId, session.userId),
          eq(userAssets.assetType, "avatar")
        )
      );

    // Clear user's image column
    await db
      .update(users)
      .set({ image: null, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500 }
    );
  }
}
