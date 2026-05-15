/**
 * UI Bridge: User Language
 *
 * GET /api/ui-bridge/user-language?userId=<authentik-sub-id>
 *
 * Returns a specific user's language preference from userSettings.
 * Auth: X-UI-Bridge-Token (shared service token).
 * Called by the Control Panel and native apps to resolve per-user language.
 *
 * Returns { language: "ru" } or { language: null } if no override set.
 */

import { NextRequest, NextResponse } from "next/server";
import { findUserByAuthentikId } from "@/lib/db/queries/users";
import { getUserSettings } from "@/lib/db/queries/settings";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { locales } from "@/i18n/config";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function GET(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ language: null });
  }

  try {
    const user = await findUserByAuthentikId(userId);
    if (!user) {
      return NextResponse.json({ language: null });
    }

    const settings = await getUserSettings(user.id);
    const lang = settings.language;

    if (typeof lang === "string" && (locales as readonly string[]).includes(lang)) {
      return NextResponse.json({ language: lang });
    }

    return NextResponse.json({ language: null });
  } catch {
    return NextResponse.json({ language: null });
  }
}
