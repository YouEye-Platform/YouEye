/**
 * /embed/notifications — Plan 5 Item 2 (Plan A).
 *
 * The UI-served notification panel (UI origin). Native apps host this as an
 * iframe in their header bell popover instead of fetching the notification list
 * themselves — so the user's cross-app notifications stay out of the app's
 * origin (the E1 security model applied to notifications). Content only; the
 * host provides the popover chrome. Per-notification app embeds inside become
 * nested iframes (Plan A). Theme via `?mode=light|dark`; transparent background.
 */

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { NotificationBell } from "@/components/layout/notification-bell";

function NotificationsEmbedInner() {
  const params = useSearchParams();
  const mode = params.get("mode");

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  return (
    <div className="h-screen w-screen">
      <NotificationBell embedded mode={mode === "dark" ? "dark" : mode === "light" ? "light" : undefined} />
    </div>
  );
}

export default function NotificationsEmbedPage() {
  return (
    <Suspense fallback={null}>
      <NotificationsEmbedInner />
    </Suspense>
  );
}
