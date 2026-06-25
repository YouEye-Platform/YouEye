/**
 * Notification Bell — Plan 1 Workstream E3 (+ Plan 5 Item 2: notification tab embed).
 *
 * Bell icon + unread badge, opening the `notifications.html` popover: a 400px
 * panel ("Notifications" / "Mark all read"), then a feed where each entry is a
 * <NotificationItem> — a `.via` attribution row + the app's own
 * <UnifiedEmbed kind="notification"> (with a standard-row fallback) or the
 * standard row directly.
 *
 * The trigger stays in the host header, but the panel itself is rendered by the
 * UI-owned /embed/notifications route. Embedded mode is the panel content used
 * inside that route; default mode opens the same route in a fullscreen
 * transparent iframe so every host shares one surface.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  NotificationItem,
  type NotificationData,
  type NotificationAppMeta,
} from "@/components/notifications/notification-item";
import {
  getCurrentThemeMode,
  PlatformOverlayFrame,
} from "./platform-overlay-frame";

export function NotificationBell({
  embedded = false,
  mode,
  onUnreadCountChange,
}: {
  embedded?: boolean;
  mode?: "light" | "dark";
  onUnreadCountChange?: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [overlayMode, setOverlayMode] = useState<"light" | "dark">("light");
  const [prewarm, setPrewarm] = useState(false);
  const [panelActive, setPanelActive] = useState(!embedded);
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const [appMeta, setAppMeta] = useState<Record<string, NotificationAppMeta>>({});
  const [unreadCount, setUnreadCount] = useState(0);
  // Gates the empty state: until the FIRST fetch succeeds we show a loading
  // skeleton, not "No notifications" — the API can be slow on a cold request and
  // the embed makes that the first visible thing. A failed/slow fetch retries via
  // the 30s poll rather than masking as empty (no silent failure).
  const [loaded, setLoaded] = useState(false);
  const t = useTranslations("notifications");

  // Track in-flight installs so we can update the loading notification on completion
  const activeInstalls = useRef<Map<string, string>>(new Map()); // appId -> notificationId

  const warmOverlay = useCallback(() => {
    setOverlayMode(getCurrentThemeMode());
    setPrewarm(true);
  }, []);

  useEffect(() => {
    if (embedded) return;
    setOverlayMode(getCurrentThemeMode());
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const id = idleWindow.requestIdleCallback(warmOverlay, { timeout: 2500 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(warmOverlay, 1200);
    return () => window.clearTimeout(id);
  }, [embedded, warmOverlay]);

  const setUnreadAndNotify = useCallback((value: number | ((prev: number) => number)) => {
    setUnreadCount((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      onUnreadCountChange?.(next);
      return next;
    });
  }, [onUnreadCountChange]);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications?limit=20");
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications);
      setUnreadAndNotify(data.unread_count ?? 0);
      if (data.app_meta) setAppMeta(data.app_meta);
      setLoaded(true);
    } catch {
      // Leave loaded=false so the next poll retries instead of showing a false empty.
    }
  }, [setUnreadAndNotify]);

  useEffect(() => {
    if (embedded) fetchNotifications();
  }, [embedded, fetchNotifications]);

  useEffect(() => {
    if (!panelActive) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications, panelActive]);

  useEffect(() => {
    if (!embedded) return;
    const handleVisibility = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "youeye:overlay-visibility" || event.data?.kind !== "notifications") return;
      const nextActive = event.data.open === true;
      setPanelActive(nextActive);
      if (nextActive) fetchNotifications();
    };
    window.addEventListener("message", handleVisibility);
    return () => window.removeEventListener("message", handleVisibility);
  }, [embedded, fetchNotifications]);

  // Listen for app install postMessage events and create proper notifications
  // (dashboard market flow; harmless in the embed — no such messages arrive).
  useEffect(() => {
    const handleMessage = async (e: MessageEvent) => {
      if (e.data?.type === "youeye-app-install-started") {
        const { appId, appName } = e.data;
        try {
          const res = await fetch("/api/v1/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "info", title: `Installing ${appName}...`, message: "Installation in progress", app_id: appId }),
          });
          if (res.ok) {
            const notif = await res.json();
            activeInstalls.current.set(appId, notif.id);
            fetchNotifications();
          }
        } catch { /* best effort */ }
      }
      if (e.data?.type === "youeye-app-install-complete") {
        const { appId, appName, error } = e.data;
        const existingNotifId = activeInstalls.current.get(appId);
        if (existingNotifId) {
          try { await fetch(`/api/v1/notifications/${existingNotifId}`, { method: "DELETE" }); } catch { /* best effort */ }
          activeInstalls.current.delete(appId);
        }
        try {
          await fetch("/api/v1/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: error ? "error" : "success", title: error ? `${appName} install failed` : `${appName} installed`, message: error || null, app_id: appId }),
          });
          fetchNotifications();
        } catch { /* best effort */ }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchNotifications]);

  // In an iframe, navigate the top window so links open at the top level.
  const go = (url: string) => {
    if (embedded && typeof window !== "undefined" && window.top) window.top.location.href = url;
    else window.location.href = url;
  };

  const markRead = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "PUT" });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadAndNotify((c) => Math.max(0, c - 1));
  };

  const markAllRead = async () => {
    await fetch("/api/v1/notifications", { method: "PUT" });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadAndNotify(0);
  };

  const dismiss = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "DELETE" });
    const removed = notifications.find((n) => n.id === id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (removed && !removed.read) setUnreadAndNotify((c) => Math.max(0, c - 1));
  };

  const handleAction = (notif: NotificationData) => {
    if (notif.action?.url) go(notif.action.url);
    if (!notif.read) markRead(notif.id);
  };

  const content = (
    <div className={`flex flex-col ${embedded ? "w-full" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-[18px] py-3.5">
        <h2 className="text-[15px] font-semibold">{t("title")}</h2>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
            <Check className="h-3 w-3" />
            {t("markAllRead")}
          </button>
        )}
      </div>

      {/* Feed */}
      {!loaded ? (
        <div className="grid gap-3 px-3.5 py-3.5" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-border/40 p-3">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-muted" />
              <div className="flex-1 space-y-2 py-0.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
              </div>
            </div>
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t("noNotifications")}</div>
      ) : (
        <div className={`grid gap-3 overflow-y-auto px-3.5 py-3.5 ${embedded ? "max-h-[440px]" : "max-h-[60vh]"}`}>
          {notifications.map((notif) => (
            <NotificationItem key={notif.id} notif={notif} appMeta={appMeta} onAction={handleAction} onDismiss={dismiss} mode={mode} />
          ))}
        </div>
      )}

      {/* View all */}
      <div className="border-t px-4 py-2.5">
        <button
          type="button"
          onClick={() => { go("/notifications"); setOpen(false); }}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("viewAll")}
        </button>
      </div>
    </div>
  );

  if (embedded) {
    return <div className="w-full bg-transparent">{content}</div>;
  }

  return (
    <>
      <button
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-accent"
        aria-label={t("title")}
        onPointerEnter={warmOverlay}
        onFocus={warmOverlay}
        onClick={() => {
          warmOverlay();
          setOpen(true);
        }}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {(open || prewarm) && (
        <PlatformOverlayFrame
          kind="notifications"
          active={open}
          preload={prewarm}
          mode={overlayMode}
          onClose={() => setOpen(false)}
          onUnreadCountChange={setUnreadAndNotify}
        />
      )}
    </>
  );
}
