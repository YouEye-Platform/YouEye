"use client";

import { useEffect } from "react";

/**
 * EmbedShell — client component that handles embed lifecycle:
 * - Overrides root layout body styles (min-height, background)
 * - Sets data-theme and accent CSS variable from URL params
 * - Reports content height to parent via postMessage (ResizeObserver + interval)
 * - Sends youeye-embed-ready signal
 * - Listens for theme/locale changes from parent
 */
export function EmbedShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme") || "light";
    const accent = params.get("accent");
    const locale = params.get("locale");

    // Override root layout body styles
    document.body.style.minHeight = "0";
    document.body.style.background = "transparent";

    // Apply theme
    document.documentElement.setAttribute("data-theme", theme);
    if (accent) document.documentElement.style.setProperty("--embed-accent", accent);

    // Apply locale
    if (locale) {
      document.cookie = `ye-embed-locale=${locale};path=/;max-age=86400;samesite=lax`;
      document.documentElement.setAttribute("lang", locale);
    }

    // Height reporting
    let lastHeight = 0;
    function reportHeight() {
      const h = document.body.scrollHeight;
      if (h !== lastHeight) {
        lastHeight = h;
        window.parent.postMessage({ type: "youeye-embed-resize", height: h }, "*");
      }
    }

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(reportHeight);
      observer.observe(document.body);
    }
    const interval = setInterval(reportHeight, 500);

    // Signal ready
    window.parent.postMessage({ type: "youeye-embed-ready" }, "*");

    // Listen for theme and locale changes from parent
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "youeye-embed-theme") {
        document.documentElement.setAttribute("data-theme", e.data.theme || "light");
        if (e.data.accent)
          document.documentElement.style.setProperty("--embed-accent", e.data.accent);
      }
      if (e.data?.type === "youeye-embed-locale" && e.data.locale) {
        document.cookie = `ye-embed-locale=${e.data.locale};path=/;max-age=86400;samesite=lax`;
        document.documentElement.setAttribute("lang", e.data.locale);
      }
    }
    window.addEventListener("message", handleMessage);

    return () => {
      observer?.disconnect();
      clearInterval(interval);
      window.removeEventListener("message", handleMessage);
      document.body.style.minHeight = "";
      document.body.style.background = "";
    };
  }, []);

  return <>{children}</>;
}
