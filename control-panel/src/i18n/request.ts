import { mergeMessages } from "../../../shared/message-catalog";
import english from "../../messages/en.json";
/**
 * next-intl request configuration
 *
 * Resolves the active locale for each request:
 *   1. Per-user language override (from YE-UI via bridge)
 *   2. System language (from youeye.yaml via Spine)
 *   3. Fallback: "en"
 *
 * Both local and SSO sessions resolve through the verified identity mapping.
 */

import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { resolvePreferredLocale } from "./config";
import { getSession } from "@/lib/auth/session";
import { getUserByUsername } from "@/lib/identity/store";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";

/**
 * Fetch system language from Spine API (via local socket).
 */
async function getSystemLanguage(): Promise<string> {

  try {
    const http = await import("http");
    const locale = await new Promise<string>((resolve) => {
      const req = http.request(
        {
          socketPath: "/var/run/youeye/youeye.sock",
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

    return locale;
  } catch {
    return "en";
  }
}

/**
 * Fetch a user's language preference from YE-UI via bridge.
 * Returns null if no override is set or bridge is unreachable.
 */
async function getUserLanguage(userId: string): Promise<string | null> {

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
      `${uiUrl}/api/ui-bridge/user-language?userId=${encodeURIComponent(userId)}`,
      {
        headers: { "X-UI-Bridge-Token": token },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const lang = data.language || null;
      return lang;
    }
  } catch {
    // Bridge unavailable — fall back to system language
  }

  return null;
}

/**
 * Resolve the identity from the authenticated session, including local accounts.
 */
async function getSessionUserId(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  return session.identityId || (await getUserByUsername(session.username))?.id || null;
}

export default getRequestConfig(async () => {
  // Signed-in users always use their authenticated preference. Setup language
  // cookies must never override it or leak a previous user's locale after sign-out.
  const userId = await getSessionUserId();
  const userLang = userId ? await getUserLanguage(userId) : null;
  const systemLang = await getSystemLanguage();
  let setupLang: string | null = null;
  if (!userId) {
    const cookieStore = await cookies();
    setupLang = cookieStore.get("ye-setup-language")?.value || null;
  }
  const locale = userId ? resolvePreferredLocale(userLang, systemLang)
    : resolvePreferredLocale(setupLang, systemLang);

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    messages = (await import("../../messages/en.json")).default;
  }

  return {
    locale,
    messages: mergeMessages(english, messages),
  };
});
