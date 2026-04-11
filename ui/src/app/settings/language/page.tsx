/**
 * Settings Page — Language Section
 *
 * Allows users to choose their preferred language.
 * Admin users can also change the system-wide default language.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LanguageSettings } from "@/components/settings/language-settings";
import { getUserSettings } from "@/lib/db/queries/settings";
import { getBridgeToken } from "@/lib/admin/bridge-client";

async function getSystemLanguage(): Promise<string | null> {
  try {
    const token = getBridgeToken();
    if (!token) return null;

    const cpUrl = process.env.CP_INTERNAL_URL || "http://youeye-control.incus:3000";
    const res = await fetch(`${cpUrl}/api/ui-bridge/language`, {
      headers: { "X-UI-Bridge-Token": token },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      return data.language || null;
    }
  } catch {
    // Bridge unavailable
  }
  return null;
}

export default async function LanguagePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const settings = await getUserSettings(session.userId);
  const currentUserLang = (settings.language as string) || null;

  const currentSystemLang = session.isAdmin
    ? await getSystemLanguage()
    : null;

  return (
    <LanguageSettings
      isAdmin={session.isAdmin ?? false}
      currentUserLanguage={currentUserLang}
      currentSystemLanguage={currentSystemLang}
    />
  );
}
