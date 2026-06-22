/**
 * /embed/launcher — Plan 1 Workstream E1.
 *
 * The UI-served app launcher (UI origin). Platform hosts mount this as a
 * fullscreen transparent iframe; this route owns the panel chrome, sizing,
 * scroll, animation, and outside-click close behavior.
 */

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Launcher } from "@/components/layout/launcher";
import { EmbedOverlayShell, postOverlayClose } from "@/components/layout/embed-overlay-shell";

function LauncherEmbedInner() {
  const params = useSearchParams();
  const mode = params?.get("mode");

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  return (
    <EmbedOverlayShell panelClassName="absolute inset-x-3 bottom-3 top-[60px] overflow-hidden rounded-3xl border border-border/40 bg-popover/80 shadow-2xl backdrop-blur-2xl animate-in fade-in-0 zoom-in-95 duration-150 sm:inset-x-7 sm:bottom-5 sm:top-[68px]">
      <Launcher embedded onClose={postOverlayClose} />
    </EmbedOverlayShell>
  );
}

export default function LauncherEmbedPage() {
  return (
    <Suspense fallback={null}>
      <LauncherEmbedInner />
    </Suspense>
  );
}
