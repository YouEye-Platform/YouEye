/**
 * /embed/drawer — Plan 5 (Workstream E1 drawer).
 *
 * The UI-served quick drawer (UI origin): pinned apps + search + edit mode.
 * Platform hosts mount this as a fullscreen transparent iframe; this route owns
 * the panel chrome, sizing, scroll, animation, and outside-click close behavior.
 */

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { AppDrawer } from "@/components/layout/app-drawer";
import { EmbedOverlayShell, postOpenLauncher } from "@/components/layout/embed-overlay-shell";

function DrawerEmbedInner() {
  const params = useSearchParams();
  const mode = params?.get("mode");
  const isAdmin = params?.get("admin") === "true";
  const surface = params?.get("surface");

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  if (surface === "sheet") {
    return (
      <div className="h-full w-full bg-transparent text-foreground">
        <AppDrawer embedded isAdmin={isAdmin} onOpenLauncher={postOpenLauncher} />
      </div>
    );
  }

  return (
    <EmbedOverlayShell panelClassName="absolute right-3 top-[60px] max-h-[calc(100vh-72px)] w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-border/60 bg-popover/85 p-0 shadow-xl backdrop-blur-xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 sm:right-4">
      <AppDrawer embedded isAdmin={isAdmin} onOpenLauncher={postOpenLauncher} />
    </EmbedOverlayShell>
  );
}

export default function DrawerEmbedPage() {
  return (
    <Suspense fallback={null}>
      <DrawerEmbedInner />
    </Suspense>
  );
}
