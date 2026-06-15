/**
 * Notification Bell — Plan 1 Workstream E3.
 *
 * Bell icon + unread badge, opening the `notifications.html` popover: a 400px
 * panel ("Notifications" / "Mark all read"), then a feed where each entry is a
 * <NotificationItem> — a `.via` attribution row + the app's own
 * <UnifiedEmbed kind="notification"> (with a standard-row fallback) or the
 * standard row directly. Also listens for app-install postMessage events and
 * creates real notifications instead of ephemeral toasts.
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

export function NotificationBell() {
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
  useEffect(() => {
    const handleMessage = async (e: MessageEvent) => {
      if (e.data?.type === "youeye-app-install-started") {
        const { appId, appName } = e.data;
        try {
          const res = await fetch("/api/v1/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "info",
              title: `Installing ${appName}...`,
              message: "Installation in progress",
              app_id: appId,
            }),
          });
          if (res.ok) {
            const notif = await res.json();
            activeInstalls.current.set(appId, notif.id);
            fetchNotifications();
          }
        } catch {
          // Best effort
        }
      }

      if (e.data?.type === "youeye-app-install-complete") {
        const { appId, appName, error } = e.data;
        const existingNotifId = activeInstalls.current.get(appId);

        // Delete the "installing..." notification if we tracked it
        if (existingNotifId) {
          try {
            await fetch(`/api/v1/notifications/${existingNotifId}`, { method: "DELETE" });
          } catch {
            // Best effort
          }
          activeInstalls.current.delete(appId);
        }

        // Create the completion notification
        try {
          await fetch("/api/v1/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: error ? "error" : "success",
              title: error ? `${appName} install failed` : `${appName} installed`,
              message: error || null,
              app_id: appId,
            }),
          });
          fetchNotifications();
        } catch {
          // Best effort
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchNotifications]);

  const markRead = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "PUT" });
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
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
    if (removed && !removed.read) {
      setUnreadCount((c) => Math.max(0, c - 1));
    }
  };

  const handleAction = (notif: NotificationData) => {
    if (notif.action?.url) {
      window.location.href = notif.action.url;
    }
    if (!notif.read) markRead(notif.id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors"
          aria-label={t("title")}
        >
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
        className="w-[400px] max-h-[calc(100vh-90px)] overflow-hidden rounded-2xl p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-[18px] py-3.5">
          <h2 className="text-[15px] font-semibold">{t("title")}</h2>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Check className="h-3 w-3" />
              {t("markAllRead")}
            </button>
          )}
        </div>

        {/* Feed */}
        {notifications.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t("noNotifications")}
          </div>
        ) : (
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto px-3.5 py-3.5">
            {notifications.map((notif) => (
              <NotificationItem
                key={notif.id}
                notif={notif}
                appMeta={appMeta}
                onAction={handleAction}
                onDismiss={dismiss}
              />
            ))}
          </div>
        )}

        {/* View all link */}
        <div className="border-t px-4 py-2.5">
          <a
            href="/notifications"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            {t("viewAll")}
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
