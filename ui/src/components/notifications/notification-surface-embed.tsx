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
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { type ReactNode } from "react";
import { UnifiedEmbed } from "@/components/embeds/unified-embed";
import { surfaceEmbedUrl } from "@/lib/surfaces/embed-url";

interface NotificationSurface {
  surface_id: string;
  embed_path: string;
  name: string | null;
  description: string | null;
  /** The app's public address, built by the server (`GET /api/v1/notifications`, YE-151). */
  app_url?: string | null;
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
  const translateInterface = useInterfaceTranslations("interface");

  // The app's page on the address the server gave (never one guessed from the page's host, YE-151).
  const url = surface
    ? surfaceEmbedUrl(surface.app_url, surface.embed_path, { notification_id: notificationId, surface_id: surface.surface_id })
    : null;
  // No app / no surface or address / no DOM (SSR) → the standard row carries the notification.
  if (!appId || !surface || !url || typeof window === "undefined") {
    return <>{fallback}</>;
  }

  return (
    <UnifiedEmbed
      url={url}
      kind="notification"
      size={{ default: MIN_HEIGHT, min: MIN_HEIGHT, max: MAX_HEIGHT }}
      timeout={3000}
      mode={mode}
      title={surface.name ?? translateInterface("m7d31b8331399")}
      fallback={fallback}
      className="overflow-hidden rounded-xl border"
    />
  );
}
