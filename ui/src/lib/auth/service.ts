/**
 * Service-to-Service Authentication
 *
 * Resolves user identity from X-YouEye-App + X-YouEye-User headers.
 * Trust boundary: Incus container network (not externally exposed).
 *
 * When a native app (like Wiki) makes server-side calls to YE-UI,
 * it forwards user identity via these headers. YE-UI validates
 * that the calling app is registered and the user exists.
 */

import type { NextRequest } from "next/server";
import { db, ensureSchema } from "@/db";
import { users, apps } from "@/db/schema";
import { eq } from "drizzle-orm";

interface ServiceUser {
  id: string;
  username: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

/**
 * Resolve a user from service-to-service auth headers.
 * Returns the user if both app and user are valid, null otherwise.
 *
 * Headers:
 * - X-YouEye-App: The app's ID (must be registered in apps table)
 * - X-YouEye-User: The user's ID (must exist in users table)
 */
export async function resolveServiceAuth(
  request: NextRequest
): Promise<ServiceUser | null> {
  const rawAppId = request.headers.get("x-youeye-app");
  const userId = request.headers.get("x-youeye-user");

  if (!rawAppId || !userId) return null;

  // Native apps may send "ye-wiki" but the apps table stores "wiki".
  // Accept both forms: try as-is first, then strip the "ye-" prefix.
  const appId = rawAppId.replace(/^ye-/, "");

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  try {
    await ensureSchema();

    // Verify the app is registered in the apps table (dynamic — no hardcoded list)
    let appRows = await db
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);

    // If stripped ID didn't match, try the raw ID (in case an app is registered with "ye-" prefix)
    if (appRows.length === 0 && appId !== rawAppId) {
      appRows = await db
        .select({ id: apps.id })
        .from(apps)
        .where(eq(apps.id, rawAppId))
        .limit(1);
    }

    if (appRows.length === 0) return null;

    const selectUser = {
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
    };

    // Always try authentikId first (TEXT column — no type casting issues),
    // then fall back to id (UUID column) only if userId looks like a UUID.
    let row = null;

    const byAuth = await db
      .select(selectUser)
      .from(users)
      .where(eq(users.authentikId, userId))
      .limit(1);
    if (byAuth.length > 0) row = byAuth[0];

    if (!row && UUID_RE.test(userId)) {
      const byId = await db
        .select(selectUser)
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (byId.length > 0) row = byId[0];
    }

    if (!row) return null;

    return {
      id: row.id,
      username: row.username ?? "",
      name: row.name ?? row.username ?? "",
      email: row.email ?? "",
      isAdmin: row.isAdmin ?? false,
    };
  } catch (err) {
    console.error("[Service Auth] Error resolving user:", err);
    return null;
  }
}
