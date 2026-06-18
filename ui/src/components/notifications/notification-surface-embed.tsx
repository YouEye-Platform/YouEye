/**
 * NotificationSurfaceEmbed — Plan 1 Workstream E3.
 *
 * A notification's app-rendered card via the ONE <UnifiedEmbed kind="notification">
 * (lazy mount, origin-validated `youeye:ready/resize/action`, 3s timeout → fallback).
 * Only rendered when the app actually declares a notification surface; otherwise the
 * parent renders the standard row directly. On timeout/error the `fallback` (the
 * standard row) is shown — never silent.
 */

"use client";

import { type ReactNode } from "react";
import { UnifiedEmbed } from "@/components/embeds/unified-embed";

interface NotificationSurface {
  surface_id: string;
  embed_path: string;
  name: string | null;
  description: string | null;
}

interface NotificationSurfaceEmbedProps {
  notificationId: string;
  appId: string | null;
  surface?: NotificationSurface | null;
  /** Standard row shown on embed timeout/error (and when there is no surface). */
  fallback: ReactNode;
  mode?: "light" | "dark";
}

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 220;

export function NotificationSurfaceEmbed({
  notificationId,
  appId,
  surface,
  fallback,
  mode,
}: NotificationSurfaceEmbedProps) {
  // No app / no surface / no DOM (SSR) → the standard row carries the notification.
  if (!appId || !surface?.embed_path || typeof window === "undefined") {
    return <>{fallback}</>;
  }

  const appSlug = appId.replace(/^ye-/, "");
  const host = window.location.hostname.replace(/^[^.]+\./, "");
  const url = new URL(`https://${appSlug}.${host}${surface.embed_path}`);
  url.searchParams.set("notification_id", notificationId);
  url.searchParams.set("surface_id", surface.surface_id);

  return (
    <UnifiedEmbed
      url={url.toString()}
      kind="notification"
      size={{ default: MIN_HEIGHT, min: MIN_HEIGHT, max: MAX_HEIGHT }}
      timeout={3000}
      mode={mode}
      title={surface.name ?? "Notification"}
      fallback={fallback}
      className="overflow-hidden rounded-xl border"
    />
  );
}
