/**
 * UI Bridge: Language
 *
 * GET /api/ui-bridge/language
 * GET /api/ui-bridge/language?userId=<authentik-sub>
 *
 * Returns the resolved language for a request.
 * Resolution order:
 *   1. Per-user override from YE-UI (if userId provided)
 *   2. System language from youeye.yaml
 *   3. Fallback: "en"
 *
 * Native apps call this endpoint to determine which locale to render.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateBridgeToken } from "@/lib/ui-bridge/auth";
import { settingsService } from "@/lib/settings";
import { readFileSync } from "fs";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";

const SUPPORTED_LOCALES = ["en", "ru", "es", "de", "fr"];

/** Cached system language */
let cachedSystemLang: { value: string; expiresAt: number } | null = null;
const SYSTEM_CACHE_TTL = 60_000;

/** Per-user language cache */
const userLangCache = new Map<
  string,
  { value: string | null; expiresAt: number }
>();
const USER_CACHE_TTL = 60_000;

async function getSystemLanguage(): Promise<string> {
  const now = Date.now();
  if (cachedSystemLang && now < cachedSystemLang.expiresAt) {
    return cachedSystemLang.value;
  }

  try {
    const config = await settingsService.getRaw();
    const lang = config.language || "en";
    cachedSystemLang = { value: lang, expiresAt: now + SYSTEM_CACHE_TTL };
    return lang;
  } catch {
    return "en";
  }
}

/** Read bridge token for calling YE-UI */
let cachedToken: string | null = null;

function getBridgeToken(): string {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync("/etc/youeye/ui-bridge-token", "utf-8").trim();
    return cachedToken;
  } catch {
    return "";
  }
}

async function getUserLanguage(userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = userLangCache.get(userId);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  try {
    const token = getBridgeToken();
    if (!token) return null;

    const uiUrl = process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
    const res = await fetch(
      `${uiUrl}/api/ui-bridge/user-language?userId=${encodeURIComponent(userId)}`,
      {
        headers: { "X-UI-Bridge-Token": token },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const lang = data.language || null;
      userLangCache.set(userId, { value: lang, expiresAt: now + USER_CACHE_TTL });
      return lang;
    }
  } catch {
    // YE-UI unreachable — fall through to system language
  }

  return null;
}

function validateLocale(lang: string | null | undefined): string {
  if (lang && SUPPORTED_LOCALES.includes(lang)) {
    return lang;
  }
  return "en";
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    // Check for per-user language via userId param
    const userId = request.nextUrl.searchParams.get("userId");
    let userLanguage: string | null = null;

    if (userId) {
      userLanguage = await getUserLanguage(userId);
    }

    // System language fallback
    const systemLang = await getSystemLanguage();

    // Resolution: user override (if set) > system language > "en"
    const resolved = userLanguage
      ? validateLocale(userLanguage)
      : validateLocale(systemLang);

    return NextResponse.json(
      { language: resolved },
      {
        headers: {
          "Cache-Control": "private, max-age=60",
        },
      }
    );
  } catch (err) {
    console.error("[UI Bridge] Language error:", err);
    return NextResponse.json({ language: "en" });
  }
}
