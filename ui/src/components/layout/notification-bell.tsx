/**
 * Notification Bell — Plan 1 Workstream E3 (+ Plan 5 Item 2: notification tab embed).
 *
 * Bell icon + unread badge, opening the `notifications.html` popover: a 400px
 * panel ("Notifications" / "Mark all read"), then a feed where each entry is a
 * <NotificationItem> — a `.via` attribution row + the app's own
 * <UnifiedEmbed kind="notification"> (with a standard-row fallback) or the
 * standard row directly.
 *
 * Renders two ways (like AppDrawer / Launcher):
 *   • default  — the UI header popover (glassy, translucent).
 *   • embedded — content-only, for the UI-served /embed/notifications iframe that
 *     native apps host. The host gives it a fixed-size scrollable box, so the
 *     OUTER tab needs no resize relay; the per-notification embeds inside become
 *     nested iframes (Plan A — accepted) and theme via `mode`. Keeps the
 *     installed-app/notification list out of the native app's origin (the E1
 *     security model applied to notifications). Links open at `window.top`.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  NotificationItem,
  type NotificationData,
  type NotificationAppMeta,
} from "@/components/notifications/notification-item";

export function NotificationBell({
  embedded = false,
  mode,
}: {
  embedded?: boolean;
  mode?: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const [appMeta, setAppMeta] = useState<Record<string, NotificationAppMeta>>({});
  const [unreadCount, setUnreadCount] = useState(0);
  const t = useTranslations("notifications");

  // Track in-flight installs so we can update the loading notification on completion
  const activeInstalls = useRef<Map<string, string>>(new Map()); // appId -> notificationId

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications?limit=20");
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
      if (data.app_meta) setAppMeta(data.app_meta);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

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
    setUnreadCount((c) => Math.max(0, c - 1));
  };

  const markAllRead = async () => {
    await fetch("/api/v1/notifications", { method: "PUT" });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const dismiss = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "DELETE" });
    const removed = notifications.find((n) => n.id === id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (removed && !removed.read) setUnreadCount((c) => Math.max(0, c - 1));
  };

  const handleAction = (notif: NotificationData) => {
    if (notif.action?.url) go(notif.action.url);
    if (!notif.read) markRead(notif.id);
  };

  const content = (
    <div className={`flex flex-col ${embedded ? "h-full w-full" : ""}`}>
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
      {notifications.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t("noNotifications")}</div>
      ) : (
        <div className={`grid gap-3 overflow-y-auto px-3.5 py-3.5 ${embedded ? "min-h-0 flex-1" : "max-h-[60vh]"}`}>
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
    return <div className="h-full w-full bg-transparent">{content}</div>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors" aria-label={t("title")}>
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0.5 flex items-center justify-center min-w-[16px] h-[16px] px-0.5 text-[9px] font-bold text-white bg-red-500 rounded-full">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[400px] max-h-[calc(100vh-90px)] overflow-hidden rounded-2xl border-border/60 bg-popover/80 p-0 backdrop-blur-xl"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
