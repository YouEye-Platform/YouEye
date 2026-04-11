/**
 * Generic App User-Settings API
 *
 * GET  /api/apps/:appId/user-settings — Read app-specific settings for a user
 * PUT  /api/apps/:appId/user-settings — Write app-specific settings for a user
 *
 * Settings are stored in the user_settings table JSONB column,
 * namespaced by app ID. Apps can only read/write their own namespace.
 *
 * Example storage:
 * {
 *   "background": { "type": "solid", "settings": {} },
 *   "ye-wiki": { "language": "de" },
 *   "ye-search": {}
 * }
 *
 * Authentication:
 * - Session cookie for browser requests
 * - X-YouEye-App + X-YouEye-User headers for service-to-service
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getUserSettings } from "@/lib/db/queries/settings";
import { db, ensureSchema } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ appId: string }>;
}

/**
 * Resolve the user from session or service-to-service headers.
 * Also validates the calling app matches the requested appId for service auth.
 */
async function resolveUser(
  request: NextRequest,
  appId: string
): Promise<{ userId: string } | null> {
  // Try session auth first
  const session = await getSession();
  if (session) {
    return { userId: session.userId };
  }

  // Try service-to-service auth
  const callingApp = request.headers.get("x-youeye-app");
  // Apps can only access their own namespace
  if (callingApp && callingApp !== appId) {
    return null;
  }

  const serviceUser = await resolveServiceAuth(request);
  if (serviceUser) {
    return { userId: serviceUser.id };
  }

  return null;
}

/** GET — Read app-specific settings */
export async function GET(request: NextRequest, context: RouteContext) {
  const { appId } = await context.params;

  const user = await resolveUser(request, appId);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allSettings = await getUserSettings(user.userId);
  const appSettings =
    (allSettings[appId] as Record<string, unknown>) ?? {};

  return NextResponse.json({ settings: appSettings });
}

/** PUT — Write app-specific settings */
export async function PUT(request: NextRequest, context: RouteContext) {
  const { appId } = await context.params;

  const user = await resolveUser(request, appId);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const newAppSettings = body.settings ?? body;

  if (typeof newAppSettings !== "object" || newAppSettings === null) {
    return NextResponse.json(
      { error: "Settings must be an object" },
      { status: 400 }
    );
  }

  await ensureSchema();

  // Read existing settings, merge the app namespace
  const existing = await getUserSettings(user.userId);
  const merged = { ...existing, [appId]: newAppSettings };

  // Upsert
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, user.userId))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(userSettings).values({
      userId: user.userId,
      settings: merged,
    });
  } else {
    await db
      .update(userSettings)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(userSettings.userId, user.userId));
  }

  return NextResponse.json({ ok: true, settings: newAppSettings });
}
