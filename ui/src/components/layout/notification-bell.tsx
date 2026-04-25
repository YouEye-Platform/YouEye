/**
 * Notification Bell
 *
 * Shows bell icon with unread count badge.
 * Dropdown displays recent notifications with mark-read and dismiss.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, Check, Info, AlertTriangle, XCircle, CheckCircle2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

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

  const prevNotificationIds = useRef<Set<string>>(new Set());
  const isInitialLoad = useRef(true);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications?limit=20");
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);

      // Show toast for new notifications (not on initial load)
      if (!isInitialLoad.current) {
        const newNotifs = (data.notifications as Notification[]).filter(
          (n) => !prevNotificationIds.current.has(n.id) && !n.read
        );
        newNotifs.slice(0, 3).forEach((notif) => {
          toast(notif.title, {
            description: notif.message || undefined,
            action: notif.action?.url
              ? {
                  label: t("view"),
                  onClick: () => {
                    window.location.href = notif.action!.url!;
                  },
                }
              : undefined,
          });
        });
      }
      isInitialLoad.current = false;

      prevNotificationIds.current = new Set(
        (data.notifications as Notification[]).map((n) => n.id)
      );
    } catch {
      // Silently fail
    }
  }, [t]);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

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
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
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

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-y-auto bg-popover border rounded-lg shadow-lg z-50">
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
          </div>
        </>
      )}
    </div>
  );
}
