"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  active = true,
  preload = false,
  mode,
  isAdmin,
  onClose,
  onOpenLauncher,
  onUnreadCountChange,
}: {
  kind: PlatformOverlayKind;
  active?: boolean;
  preload?: boolean;
  mode?: "light" | "dark";
  isAdmin?: boolean;
  onClose: () => void;
  onOpenLauncher?: () => void;
  onUnreadCountChange?: (count: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [mounted, setMounted] = useState(active || preload);
  const [loaded, setLoaded] = useState(false);
  const src = useMemo(() => {
    const params = new URLSearchParams();
    if (mode) params.set("mode", mode);
    if (isAdmin) params.set("admin", "true");
    const query = params.toString();
    return `/embed/${kind}${query ? `?${query}` : ""}`;
  }, [isAdmin, kind, mode]);

  const postVisibility = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "youeye:overlay-visibility", kind, open: active },
      window.location.origin
    );
  }, [active, kind]);

  useEffect(() => {
    if (active || preload) setMounted(true);
  }, [active, preload]);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  useEffect(() => {
    if (mounted && loaded) postVisibility();
  }, [loaded, mounted, postVisibility]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "youeye:close") {
        onClose();
      }
      if (event.data?.type === "youeye:overlay-command" && event.data?.command === "open-launcher") {
        onOpenLauncher?.();
      }
      if (event.data?.type === "youeye:notifications" && typeof event.data.unread_count === "number") {
        onUnreadCountChange?.(event.data.unread_count);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onClose, onOpenLauncher, onUnreadCountChange]);

  if (typeof document === "undefined" || !mounted) return null;

  return createPortal(
    <iframe
      ref={iframeRef}
      key={src}
      title={`YouEye ${kind}`}
      src={src}
      sandbox={OVERLAY_SANDBOX}
      className={`fixed inset-0 z-[90] h-screen w-screen border-0 bg-transparent transition-opacity duration-100 ${active && loaded ? "pointer-events-auto" : "pointer-events-none"}`}
      style={{ colorScheme: mode ?? "normal", opacity: active && loaded ? 1 : 0 }}
      onLoad={() => requestAnimationFrame(() => {
        setLoaded(true);
        postVisibility();
      })}
      allow="clipboard-read; clipboard-write"
    />,
    document.body
  );
}
