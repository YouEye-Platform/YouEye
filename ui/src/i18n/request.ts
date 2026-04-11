/**
 * next-intl request configuration for YE-UI
 *
 * Resolves the active locale for each request:
 *   1. User's personal language setting (from userSettings.language)
 *   2. System language from bridge (cached)
 *   3. Fallback: "en"
 */

import { getRequestConfig } from "next-intl/server";
import { resolveLocale, defaultLocale } from "./config";
import { cookies } from "next/headers";

/** Cached system language with TTL */
let cachedSystemLang: { value: string; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Fetch system language from CP bridge endpoint.
 * Falls back to "en" on any error.
 */
async function getSystemLanguage(): Promise<string> {
  const now = Date.now();
  if (cachedSystemLang && now < cachedSystemLang.expiresAt) {
    return cachedSystemLang.value;
  }

  try {
    // Read bridge token and CP URL from environment
    const bridgeToken = process.env.UI_BRIDGE_TOKEN || "";
    const cpUrl = process.env.CP_INTERNAL_URL || "http://youeye-control.incus:3000";

    if (!bridgeToken) {
      return defaultLocale;
    }

    const res = await fetch(`${cpUrl}/api/ui-bridge/language`, {
      headers: {
        "X-UI-Bridge-Token": bridgeToken,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      const lang = data.language || defaultLocale;
      cachedSystemLang = { value: lang, expiresAt: now + CACHE_TTL_MS };
      return lang;
    }
  } catch {
    // Bridge unavailable — use default
  }

  return defaultLocale;
}

/**
 * Get the user's language preference from the database.
 * This is called on every request to check the user's override.
 */
async function getUserLanguage(): Promise<string | null> {
  try {
    // Dynamic import to avoid circular deps during build
    const { getSession } = await import("@/lib/auth");
    const session = await getSession();
    if (!session?.userId) return null;

    const { getUserSettings } = await import("@/lib/db/queries/settings");
    const settings = await getUserSettings(session.userId);
    const lang = settings.language;
    if (typeof lang === "string" && lang.length > 0) {
      return lang;
    }
  } catch {
    // Database not available during build or SSG
  }
  return null;
}

export default getRequestConfig(async () => {
  // Resolution order: user override > system language > "en"
  const userLang = await getUserLanguage();
  const systemLang = await getSystemLanguage();

  const locale = resolveLocale(userLang || systemLang);

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    messages = (await import("../../messages/en.json")).default;
  }

  return {
    locale,
    messages,
  };
});
