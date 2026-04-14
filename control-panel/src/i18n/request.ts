/**
 * next-intl request configuration
 *
 * Resolves the active locale for each request:
 *   1. Per-user language override (from YE-UI via bridge)
 *   2. System language (from youeye.yaml via Spine)
 *   3. Fallback: "en"
 *
 * CP sessions use PAM auth (username-based JWT, no Authentik sub).
 * Per-user resolution only works for SSO-authenticated sessions.
 * PAM sessions fall back to system default.
 */

import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { resolveLocale, defaultLocale } from "./config";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";

/** Cached system language with TTL */
let cachedSystemLang: { locale: string; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Per-user language cache (keyed by Authentik sub) */
const userLangCache = new Map<
  string,
  { locale: string | null; expiresAt: number }
>();

/**
 * Fetch system language from Spine API (via local socket).
 */
async function getSystemLanguage(): Promise<string> {
  const now = Date.now();
  if (cachedSystemLang && now < cachedSystemLang.expiresAt) {
    return cachedSystemLang.locale;
  }

  try {
    const http = await import("http");
    const locale = await new Promise<string>((resolve) => {
      const req = http.request(
        {
          socketPath: "/var/run/spine/spine.sock",
          path: "/api/config",
          method: "GET",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => {
            try {
              const config = JSON.parse(data);
              resolve(config.language || "en");
            } catch {
              resolve("en");
            }
          });
        }
      );
      req.on("error", () => resolve("en"));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve("en");
      });
      req.end();
    });

    cachedSystemLang = { locale, expiresAt: now + CACHE_TTL_MS };
    return locale;
  } catch {
    return "en";
  }
}

/**
 * Fetch a user's language preference from YE-UI via bridge.
 * Returns null if no override is set or bridge is unreachable.
 */
async function getUserLanguage(authentikSub: string): Promise<string | null> {
  const now = Date.now();
  const cached = userLangCache.get(authentikSub);
  if (cached && now < cached.expiresAt) {
    return cached.locale;
  }

  try {
    const fs = await import("fs");
    let token: string;
    try {
      token = fs.readFileSync("/etc/youeye/ui-bridge-token", "utf-8").trim();
    } catch {
      return null;
    }
    if (!token) return null;

    const uiUrl = process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
    const res = await fetch(
      `${uiUrl}/api/ui-bridge/user-language?userId=${encodeURIComponent(authentikSub)}`,
      {
        headers: { "X-UI-Bridge-Token": token },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const lang = data.language || null;
      userLangCache.set(authentikSub, { locale: lang, expiresAt: now + CACHE_TTL_MS });
      return lang;
    }
  } catch {
    // Bridge unavailable — fall back to system language
  }

  return null;
}

/**
 * Try to extract user identity from the CP session JWT.
 * CP PAM sessions have `username` but no Authentik sub.
 * Returns null for PAM sessions (no per-user language available).
 */
async function getSessionUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get("ye-session");
    if (!sessionCookie?.value) return null;

    // Decode the JWT payload without verification (middleware already verified it)
    const parts = sessionCookie.value.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );

    // CP PAM sessions don't have an Authentik sub — they have username only.
    return payload.sub || payload.authentikId || null;
  } catch {
    return null;
  }
}

export default getRequestConfig(async () => {
  // Check setup-language cookie (set during wizard Step 0, before setup completes)
  let setupLang: string | null = null;
  try {
    const cookieStore = await cookies();
    const setupCookie = cookieStore.get("ye-setup-language");
    if (setupCookie?.value) {
      setupLang = setupCookie.value;
    }
  } catch {
    // cookies() may fail outside request context
  }

  // Try per-user resolution
  const userId = await getSessionUserId();
  let userLang: string | null = null;
  if (userId) {
    userLang = await getUserLanguage(userId);
  }

  // System language fallback
  const systemLang = await getSystemLanguage();

  // Resolution: setup cookie > user override > system default > "en"
  const locale = resolveLocale(setupLang || userLang || systemLang);

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
