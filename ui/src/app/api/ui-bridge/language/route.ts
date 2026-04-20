/**
 * UI Bridge: System Language
 *
 * PUT /api/ui-bridge/language
 * Body: { language: "en" }
 *
 * Receives system language updates pushed from CP.
 * One-Way Bridge: CP pushes to UI, UI never fetches from CP.
 *
 * Auth: X-UI-Bridge-Token (shared service token).
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { setSystemLanguage } from "@/lib/db/queries/settings";
import { locales } from "@/i18n/config";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function PUT(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const language = body.language;

    if (typeof language !== "string") {
      return NextResponse.json(
        { error: "Missing language field" },
        { status: 400 }
      );
    }

    if (!(locales as readonly string[]).includes(language)) {
      return NextResponse.json(
        { error: `Invalid locale: ${language}. Valid: ${locales.join(", ")}` },
        { status: 400 }
      );
    }

    await setSystemLanguage(language);

    return NextResponse.json({ success: true, language });
  } catch (err) {
    console.error("[ui-bridge/language] Error:", err);
    return NextResponse.json(
      { error: "Failed to set system language" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/ui-bridge/language
 *
 * Returns current system language. Used by CP to sync state.
 */
export async function GET(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { getSystemLanguage } = await import("@/lib/db/queries/settings");
    const language = await getSystemLanguage();
    return NextResponse.json({ language });
  } catch {
    return NextResponse.json({ language: "en" });
  }
}
