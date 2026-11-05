"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { uiSettingsApi } from "./settings-shell/api-base";

/** Events only trigger an authenticated read; their payload never selects a locale. */
export function LocaleRefresh({ locale }: { locale: string }) {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    let checking = false;
    async function reconcile() {
      if (document.visibilityState === "hidden" || checking) return;
      checking = true;
      try {
        const endpoint = pathname.startsWith("/market")
          ? "/market/api/ui-settings/language" : uiSettingsApi("language");
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) return;
        const current = await response.json();
        if (!cancelled && typeof current.locale === "string" && current.locale !== locale) router.refresh();
      } catch { /* Keep the current view and drafts while offline. */ }
      finally { checking = false; }
    }
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("youeye-language");
    channel?.addEventListener("message", reconcile);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      cancelled = true;
      channel?.close();
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [locale, pathname, router]);
  return null;
}
