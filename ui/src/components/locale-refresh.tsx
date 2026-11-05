"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Reconcile open views after a preference change; never trust an event's locale. */
export function LocaleRefresh({ locale, endpoint }: { locale: string; endpoint: string }) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let checking = false;
    async function reconcile() {
      if (document.visibilityState === "hidden" || checking) return;
      checking = true;
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) return;
        const current = await response.json();
        if (!cancelled && typeof current.locale === "string" && current.locale !== locale) router.refresh();
      } catch { /* Preserve the current interface while offline. */ }
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
  }, [endpoint, locale, router]);
  return null;
}
