/**
 * DrawerAndLauncher — Plan 5.
 *
 * The dashboard header's app affordance. The trigger stays local, but the
 * drawer and launcher surfaces are the same UI-owned /embed/* overlays that
 * Control Panel and native apps host.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import { DotsIcon } from "./app-drawer";
import {
  getCurrentThemeMode,
  PlatformOverlayFrame,
  type PlatformOverlayKind,
} from "./platform-overlay-frame";

export function DrawerAndLauncher({ isAdmin = false }: { isAdmin?: boolean }) {
  const [overlay, setOverlay] = useState<PlatformOverlayKind | null>(null);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [prewarm, setPrewarm] = useState(false);
  const t = useTranslations("appDrawer");

  const warmOverlays = useCallback(() => {
    setMode(getCurrentThemeMode());
    setPrewarm(true);
  }, []);

  useEffect(() => {
    setMode(getCurrentThemeMode());
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const id = idleWindow.requestIdleCallback(warmOverlays, { timeout: 2000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(warmOverlays, 1000);
    return () => window.clearTimeout(id);
  }, [warmOverlays]);

  const openOverlay = useCallback((nextOverlay: PlatformOverlayKind) => {
    warmOverlays();
    setOverlay(nextOverlay);
  }, [warmOverlays]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label={t("title")}
        onPointerEnter={warmOverlays}
        onFocus={warmOverlays}
        onClick={() => openOverlay("drawer")}
      >
        <DotsIcon className="h-4 w-4" />
      </Button>

      <PlatformOverlayFrame
        kind="drawer"
        active={overlay === "drawer"}
        preload={prewarm}
        mode={mode}
        isAdmin={isAdmin}
        onClose={() => setOverlay(null)}
        onOpenLauncher={() => setOverlay("launcher")}
      />
      <PlatformOverlayFrame
        kind="launcher"
        active={overlay === "launcher"}
        preload={prewarm}
        mode={mode}
        isAdmin={isAdmin}
        onClose={() => setOverlay(null)}
      />
    </>
  );
}
