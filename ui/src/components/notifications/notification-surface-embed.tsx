"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  compact?: boolean;
}

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 220;

export function NotificationSurfaceEmbed({
  notificationId,
  appId,
  surface,
  compact = false,
}: NotificationSurfaceEmbedProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(compact ? MIN_HEIGHT : 96);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const embedUrl = useMemo(() => {
    if (!appId || !surface?.embed_path || typeof window === "undefined") return null;
    const appSlug = appId.replace(/^ye-/, "");
    const host = window.location.hostname.replace(/^[^.]+\./, "");
    const url = new URL(`https://${appSlug}.${host}${surface.embed_path}`);
    url.searchParams.set("notification_id", notificationId);
    url.searchParams.set("surface_id", surface.surface_id);
    return url.toString();
  }, [appId, notificationId, surface]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (!embedUrl || !embedUrl.startsWith(event.origin)) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "youeye-embed-ready") {
        setReady(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      }
      if (msg.type === "youeye-embed-resize" && typeof msg.height === "number") {
        setHeight(Math.min(Math.max(msg.height, MIN_HEIGHT), MAX_HEIGHT));
      }
    },
    [embedUrl]
  );

  useEffect(() => {
    if (!embedUrl) return;
    window.addEventListener("message", handleMessage);
    timeoutRef.current = setTimeout(() => setFailed(true), 3000);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [embedUrl, handleMessage]);

  if (!embedUrl || failed) return null;

  return (
    <iframe
      src={embedUrl}
      sandbox="allow-scripts allow-same-origin"
      loading="lazy"
      title={surface?.name ?? "Notification"}
      className={`mt-2 w-full rounded-md border-0 bg-transparent transition-opacity ${ready ? "opacity-100" : "h-0 opacity-0"}`}
      style={{ height: ready ? height : 0 }}
      onError={() => setFailed(true)}
    />
  );
}
