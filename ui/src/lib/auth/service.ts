/**
 * Service-to-Service Authentication
 *
 * Resolves user identity from X-YouEye-App + X-YouEye-User headers.
 * Layer 2 security: verifies app identity via Bearer token (YOUEYE_APP_TOKEN).
 *
 * When a native app (like Wiki) makes server-side calls to YE-UI,
 * it sends: Authorization: Bearer <token>, X-YouEye-App, X-YouEye-User.
 * YE-UI validates the token hash matches the stored hash in the apps table,
 * then verifies the app is registered and the user exists.
 *
 * Enforcement (Auth Unification Phase 3): an app registered WITH a token_hash MUST present a
 * valid Bearer token — an invalid or absent token is rejected. Apps that have no token_hash yet
 * (transitional, pre-provisioning) remain in a logged grace period so they are not locked out;
 * once Control Panel registers their hash they fall under enforcement automatically.
 */

import type { NextRequest } from "next/server";
import { db, ensureSchema } from "@/db";
import { users, apps } from "@/db/schema";
import { eq, or } from "drizzle-orm";
import { validateAppToken } from "./app-token";

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

    // === Layer 2: Verify app token (ENFORCED — Auth Unification Phase 3) ===
    // The app token is the trust boundary. A request is honored only if it presents a Bearer
    // token whose SHA-256 hash matches the app's stored token_hash. Apps registered WITH a hash
    // MUST present a valid token (invalid/absent → reject). Apps with no hash yet (transitional,
    // pre-provisioning) are allowed through with a warning so they aren't locked out.
    const authHeader = request.headers.get("authorization");
    const tokenResult = await validateAppToken(request);

    if (tokenResult) {
      // Valid token — verify it matches the claimed app.
      const tokenAppId = tokenResult.appId.replace(/^ye-/, "");
      if (tokenAppId !== appId && tokenResult.appId !== rawAppId) {
        console.warn(`[Service Auth] Token/app mismatch: token=${tokenResult.appId}, header=${rawAppId}`);
        return null;
      }
    } else {
      // No valid token (absent or invalid). Reject if the app is registered WITH a token hash —
      // it is expected to present its token. Grace only for apps that have no hash registered yet.
      const appCheck = await db
        .select({ id: apps.id, tokenHash: apps.tokenHash })
        .from(apps)
        .where(or(eq(apps.id, appId), eq(apps.id, rawAppId)))
        .limit(1);
      const registeredWithHash = appCheck.length > 0 && appCheck[0].tokenHash !== null;
      const reason = authHeader?.startsWith("Bearer ") ? "invalid app token" : "no app token";
      if (registeredWithHash) {
        console.warn(`[Service Auth] Rejecting ${rawAppId}: ${reason} but app has a registered token_hash`);
        return null;
      }
      console.warn(`[Service Auth] ${rawAppId} presented ${reason} and has no token_hash registered — grace period`);
    }
    // === End Layer 2 ===

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

    // Always try identityId first (TEXT column — no type casting issues),
    // then fall back to id (UUID column) only if userId looks like a UUID.
    let row = null;

    const byIdentity = await db
      .select(selectUser)
      .from(users)
      .where(eq(users.identityId, userId))
      .limit(1);
    if (byIdentity.length > 0) row = byIdentity[0];

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
