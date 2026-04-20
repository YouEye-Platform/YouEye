/**
 * next-intl request configuration for YE-UI
 *
 * Resolves the active locale for each request:
 *   1. User's personal language setting (from userSettings.language)
 *   2. System language from local DB (site_language in systemSettings)
 *   3. Fallback: "en"
 *
 * One-Way Bridge: Language is now stored locally in UI's database.
 * CP pushes changes via PUT /api/ui-bridge/language (CP → UI direction).
 * UI never fetches from CP.
 */

import { getRequestConfig } from "next-intl/server";
import { resolveLocale, defaultLocale } from "./config";

/** Cached system language with TTL */
let cachedSystemLang: { value: string; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Get system language from local database.
 * Cached in memory with 60s TTL for performance.
 */
async function fetchSystemLanguage(): Promise<string> {
  const now = Date.now();
  if (cachedSystemLang && now < cachedSystemLang.expiresAt) {
    return cachedSystemLang.value;
  }

  try {
    // Dynamic import to avoid circular deps and build-time issues
    const { getSystemLanguage } = await import("@/lib/db/queries/settings");
    const lang = await getSystemLanguage();
    cachedSystemLang = { value: lang, expiresAt: now + CACHE_TTL_MS };
    return lang;
  } catch {
    // Database not available during build — use default
    return defaultLocale;
  }
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
  const systemLang = await fetchSystemLanguage();

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
