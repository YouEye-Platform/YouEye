/**
 * Notification Bell
 *
 * Shows bell icon with unread count badge.
 * Dropdown (Radix Popover) displays recent notifications with mark-read and dismiss.
 * Also listens for app install postMessage events and creates proper
 * notifications via the notifications API instead of ephemeral toasts.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, Check, Info, AlertTriangle, XCircle, CheckCircle2, X, Download } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  appId: string | null;
  read: boolean;
  createdAt: string;
  action: { type?: string; url?: string } | null;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const t = useTranslations('notifications');

  // Track in-flight installs so we can update the loading notification on completion
  const activeInstalls = useRef<Map<string, string>>(new Map()); // appId -> notificationId

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications?limit=20");
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
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

  const handleAction = (notif: Notification) => {
    if (notif.action?.url) {
      window.location.href = notif.action.url;
    }
    if (!notif.read) markRead(notif.id);
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case "success": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      case "error": return <XCircle className="w-4 h-4 text-red-500" />;
      default: return <Info className="w-4 h-4 text-blue-500" />;
    }
  };

  const timeAgo = (dateStr: string) => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return t('justNow');
    if (seconds < 3600) return t('minutesAgo', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return t('hoursAgo', { count: Math.floor(seconds / 3600) });
    return t('daysAgo', { count: Math.floor(seconds / 86400) });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent transition-colors"
          aria-label={t('title')}
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
        className="w-80 max-h-96 overflow-y-auto rounded-lg p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">{t('title')}</h3>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Check className="w-3 h-3" />
              {t('markAllRead')}
            </button>
          )}
        </div>

        {/* List */}
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('noNotifications')}
          </div>
        ) : (
          <div className="divide-y">
            {notifications.map((notif) => (
              <div
                key={notif.id}
                className={`flex items-start gap-3 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer ${
                  !notif.read ? "bg-accent/20" : ""
                }`}
                onClick={() => handleAction(notif)}
              >
                <div className="mt-0.5">{typeIcon(notif.type)}</div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${!notif.read ? "font-semibold" : ""}`}>
                    {notif.title}
                  </p>
                  {notif.message && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {notif.message}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {timeAgo(notif.createdAt)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dismiss(notif.id);
                  }}
                  className="p-1 rounded hover:bg-accent transition-colors"
                  aria-label={t('dismiss')}
                >
                  <X className="w-3 h-3 text-muted-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* View all link */}
        <div className="border-t px-4 py-2">
          <a
            href="/notifications"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setOpen(false)}
          >
            {t('viewAll')}
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
