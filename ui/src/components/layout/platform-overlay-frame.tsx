"use client";

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";

export type PlatformOverlayKind = "drawer" | "launcher" | "notifications";

const OVERLAY_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation";

export function getCurrentThemeMode(): "light" | "dark" {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "light";
}

export function PlatformOverlayFrame({
  kind,
  mode,
  isAdmin,
  onClose,
  onOpenLauncher,
  onUnreadCountChange,
}: {
  kind: PlatformOverlayKind;
  mode?: "light" | "dark";
  isAdmin?: boolean;
  onClose: () => void;
  onOpenLauncher?: () => void;
  onUnreadCountChange?: (count: number) => void;
}) {
  const src = useMemo(() => {
    const params = new URLSearchParams();
    if (mode) params.set("mode", mode);
    if (isAdmin) params.set("admin", "true");
    const query = params.toString();
    return `/embed/${kind}${query ? `?${query}` : ""}`;
  }, [isAdmin, kind, mode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "youeye:close") {
        onClose();
      }
      if (event.data?.type === "youeye:action" && event.data?.action === "open-launcher") {
        onOpenLauncher?.();
      }
      if (event.data?.type === "youeye:notifications" && typeof event.data.unread_count === "number") {
        onUnreadCountChange?.(event.data.unread_count);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onClose, onOpenLauncher, onUnreadCountChange]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <iframe
      title={`YouEye ${kind}`}
      src={src}
      sandbox={OVERLAY_SANDBOX}
      className="fixed inset-0 z-[90] h-screen w-screen border-0 bg-transparent"
      style={{ colorScheme: mode ?? "normal" }}
      allow="clipboard-read; clipboard-write"
    />,
    document.body
  );
}
