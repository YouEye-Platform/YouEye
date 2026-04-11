/**
 * User Language API
 *
 * GET  /api/user/language — Get user's language preference (called by CP bridge)
 * POST /api/user/language — Set user's language preference (called by UI settings)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserSettings } from "@/lib/db/queries/settings";
import { eq } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { userSettings } from "@/db/schema";

const SUPPORTED_LOCALES = ["en", "ru", "es", "de", "fr"];

/**
 * GET — Returns the authenticated user's language preference.
 * Called by CP's /api/ui-bridge/language to resolve per-user overrides.
 * Returns { language: "ru" } or { language: null } if no override.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.userId) {
      return NextResponse.json({ language: null });
    }

    const settings = await getUserSettings(session.userId);
    const lang = settings.language;

    if (typeof lang === "string" && SUPPORTED_LOCALES.includes(lang)) {
      return NextResponse.json({ language: lang });
    }

    return NextResponse.json({ language: null });
  } catch {
    return NextResponse.json({ language: null });
  }
}

/**
 * POST — Set or clear the user's language preference.
 * Body: { language: "ru" } to set, or { language: null } to reset to system default.
 * Saves into the userSettings JSONB column.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const newLang = body.language;

    // Validate: must be null (reset) or a supported locale
    if (newLang !== null && !SUPPORTED_LOCALES.includes(newLang)) {
      return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
    }

    await ensureSchema();

    // Get existing settings to merge
    const existing = await getUserSettings(session.userId);
    const merged = { ...existing };

    if (newLang === null) {
      // Remove the language override
      delete merged.language;
    } else {
      merged.language = newLang;
    }

    // Upsert user settings
    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, session.userId))
      .limit(1);

    if (rows.length === 0) {
      await db.insert(userSettings).values({
        userId: session.userId,
        settings: merged,
      });
    } else {
      await db
        .update(userSettings)
        .set({ settings: merged, updatedAt: new Date() })
        .where(eq(userSettings.userId, session.userId));
    }

    return NextResponse.json({ language: newLang, status: "saved" });
  } catch (err) {
    console.error("[User Language] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
