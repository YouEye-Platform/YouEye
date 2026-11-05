/**
 * /embed/notifications — Plan 5 Item 2 (Plan A).
 *
 * The UI-served notification panel (UI origin). Platform hosts mount this as a
 * fullscreen transparent iframe instead of fetching notifications themselves.
 * This route owns the panel chrome, sizing, scroll, animation, and outside-click
 * close behavior.
 */

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { NotificationBell } from "@/components/layout/notification-bell";
import { EmbedOverlayShell, postUnreadCount } from "@/components/layout/embed-overlay-shell";

function NotificationsEmbedInner() {
  const params = useSearchParams();
  const mode = params?.get("mode");
  const surface = params?.get("surface");

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  if (surface === "sheet") {
    return (
      <div className="h-full w-full bg-transparent text-foreground">
        <NotificationBell
          embedded
          mode={mode === "dark" ? "dark" : mode === "light" ? "light" : undefined}
          onUnreadCountChange={postUnreadCount}
        />
      </div>
    );
  }

  return (
    <EmbedOverlayShell panelClassName="absolute right-3 top-[60px] max-h-[calc(100vh-72px)] w-[min(400px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-border/60 bg-popover/85 p-0 shadow-xl backdrop-blur-xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 sm:right-4">
      <NotificationBell
        embedded
        mode={mode === "dark" ? "dark" : mode === "light" ? "light" : undefined}
        onUnreadCountChange={postUnreadCount}
      />
    </EmbedOverlayShell>
  );
}

export default function NotificationsEmbedPage() {
  return (
    <Suspense fallback={null}>
      <NotificationsEmbedInner />
    </Suspense>
  );
}
