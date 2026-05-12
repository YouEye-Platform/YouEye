/**
 * UI Bridge: User Avatar Sync
 *
 * POST   /api/ui-bridge/user-avatar — CP pushes avatar data after Authentik save
 * DELETE /api/ui-bridge/user-avatar — CP notifies avatar removal
 *
 * Auth: X-UI-Bridge-Token (shared service token).
 *
 * This is the server-to-server path for avatar persistence. When a user
 * changes their avatar via the CP embed, CP saves to Authentik and then
 * pushes the image data here so UI can persist it locally (disk + DB).
 * This ensures the avatar survives page navigation and browser refresh.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { saveAvatar, deleteAvatar } from "@/lib/avatar/storage";
import { db } from "@/db";
import { users, userAssets } from "@/db/schema";
import { eq, and } from "drizzle-orm";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

/** Resolve a username to UI's internal user ID */
async function resolveUserId(username: string): Promise<string | null> {
  const result = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return result[0]?.id ?? null;
}

export async function POST(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { username, dataUrl } = body;

    if (!username || !dataUrl) {
      return NextResponse.json(
        { error: "username and dataUrl are required" },
        { status: 400 }
      );
    }

    const userId = await resolveUserId(username);
    if (!userId) {
      return NextResponse.json(
        { error: `User '${username}' not found in UI database` },
        { status: 404 }
      );
    }

    // Convert data URL to buffer
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return NextResponse.json(
        { error: "Invalid data URL format" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(match[2], "base64");
    const { storagePath, sizeBytes } = await saveAvatar(userId, buffer);
    const servingUrl = `/api/v1/user/avatar/${userId}`;

    // Update DB: remove old asset record, insert new, update user image
    await db
      .delete(userAssets)
      .where(
        and(
          eq(userAssets.userId, userId),
          eq(userAssets.assetType, "avatar")
        )
      );

    await db.insert(userAssets).values({
      userId,
      assetType: "avatar",
      filename: `${userId}.webp`,
      mimeType: "image/webp",
      sizeBytes,
      storagePath,
    });

    await db
      .update(users)
      .set({ image: servingUrl, updatedAt: new Date() })
      .where(eq(users.id, userId));

    return NextResponse.json({ success: true, url: servingUrl });
  } catch (error) {
    console.error("[Bridge Avatar] Save failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { username } = body;

    if (!username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }

    const userId = await resolveUserId(username);
    if (!userId) {
      return NextResponse.json(
        { error: `User '${username}' not found in UI database` },
        { status: 404 }
      );
    }

    await deleteAvatar(userId);

    await db
      .delete(userAssets)
      .where(
        and(
          eq(userAssets.userId, userId),
          eq(userAssets.assetType, "avatar")
        )
      );

    await db
      .update(users)
      .set({ image: null, updatedAt: new Date() })
      .where(eq(users.id, userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Bridge Avatar] Delete failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500 }
    );
  }
}
