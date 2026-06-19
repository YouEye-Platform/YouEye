/**
 * /embed/drawer — Plan 5 (Workstream E1 drawer).
 *
 * The UI-served quick drawer (UI origin): pinned apps + search + edit mode.
 * Native apps host this as an iframe in their header popover instead of
 * receiving the installed-app list (the E1 security model). Content only — the
 * host provides the popover chrome. The drawer's "All apps" button posts
 * `youeye:action open-launcher` so the host can swap in the launcher. Theme via
 * `?mode=light|dark`. Transparent background so the host panel shows through.
 */

"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { AppDrawer } from "@/components/layout/app-drawer";
import { useEmbedAutoResize } from "@/lib/hooks/use-embed-auto-resize";

function DrawerEmbedInner() {
  const params = useSearchParams();
  const mode = params?.get("mode");
  const contentRef = useRef<HTMLDivElement>(null);
  useEmbedAutoResize(contentRef);

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  const openLauncher = () => {
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({ type: "youeye:action", action: "open-launcher" }, "*");
    }
  };

  return (
    <div ref={contentRef} className="w-full">
      <AppDrawer embedded onOpenLauncher={openLauncher} />
    </div>
  );
}

export default function DrawerEmbedPage() {
  return (
    <Suspense fallback={null}>
      <DrawerEmbedInner />
    </Suspense>
  );
}
