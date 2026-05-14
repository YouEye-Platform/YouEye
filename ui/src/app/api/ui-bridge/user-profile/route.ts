/**
 * UI Bridge: User Profile Sync
 *
 * POST /api/ui-bridge/user-profile — Control Panel pushes name changes after Authentik save
 *
 * Auth: X-UI-Bridge-Token (shared service token).
 *
 * Server-to-server fallback for name persistence. The primary path is
 * postMessage → client-side PATCH, but this bridge ensures the name
 * persists even if the client-side path fails.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { updateUserProfile } from "@/lib/db/queries/users";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

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
    const { username, firstName, lastName } = body;

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

    const name = [firstName, lastName].filter(Boolean).join(" ") || undefined;

    await updateUserProfile(userId, {
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      name,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Bridge Profile] Save failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed" },
      { status: 500 }
    );
  }
}
