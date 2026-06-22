/**
 * DrawerAndLauncher — Plan 5.
 *
 * The dashboard header's app affordance. The trigger stays local, but the
 * drawer and launcher surfaces are the same UI-owned /embed/* overlays that
 * Control Panel and native apps host.
 */

"use client";

import { useCallback, useState } from "react";
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
  const t = useTranslations("appDrawer");

  const openOverlay = useCallback((nextOverlay: PlatformOverlayKind) => {
    setMode(getCurrentThemeMode());
    setOverlay(nextOverlay);
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label={t("title")}
        onClick={() => openOverlay("drawer")}
      >
        <DotsIcon className="h-5 w-5" />
      </Button>

      {overlay && (
        <PlatformOverlayFrame
          kind={overlay}
          mode={mode}
          isAdmin={isAdmin}
          onClose={() => setOverlay(null)}
          onOpenLauncher={() => setOverlay("launcher")}
        />
      )}
    </>
  );
}
