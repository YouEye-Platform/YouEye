/**
 * NotificationsList — Client Component
 *
 * Full-page notification list with filtering, search, pagination, and bulk actions.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Bell,
  Check,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  X,
  Search,
  Trash2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

type FilterType = "all" | "info" | "success" | "warning" | "error";
type FilterRead = "all" | "unread" | "read";

const PAGE_SIZE = 50;

export function NotificationsList() {
  const t = useTranslations("notifications");

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [readFilter, setReadFilter] = useState<FilterRead>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchNotifications = useCallback(
    async (offset = 0, append = false) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);

      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (readFilter === "unread") params.set("read", "false");
      if (readFilter === "read") params.set("read", "true");
      if (debouncedSearch) params.set("search", debouncedSearch);

      try {
        const res = await fetch(`/api/v1/notifications?${params}`);
        if (!res.ok) return;
        const data = await res.json();

        if (append) {
          setNotifications((prev) => [...prev, ...data.notifications]);
        } else {
          setNotifications(data.notifications);
        }
        setTotal(data.total);
      } catch {
        // Network error — leave existing state
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [typeFilter, readFilter, debouncedSearch]
  );

  useEffect(() => {
    fetchNotifications(0, false);
  }, [fetchNotifications]);

  const markRead = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "PUT" });
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const markAllRead = async () => {
    await fetch("/api/v1/notifications", { method: "PUT" });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const dismiss = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, { method: "DELETE" });
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  };

  const deleteRead = async () => {
    await fetch("/api/v1/notifications", { method: "DELETE" });
    setNotifications((prev) => prev.filter((n) => !n.read));
    setTotal((t) => Math.max(0, t - notifications.filter((n) => n.read).length));
  };

  const handleAction = (notif: Notification) => {
    if (notif.action?.url) {
      window.location.href = notif.action.url;
    }
    if (!notif.read) markRead(notif.id);
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case "success":
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case "warning":
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      case "error":
        return <XCircle className="w-5 h-5 text-red-500" />;
      default:
        return <Info className="w-5 h-5 text-blue-500" />;
    }
  };

  const timeAgo = (dateStr: string) => {
    if (!dateStr) return t("justNow");
    const ms = new Date(dateStr).getTime();
    if (isNaN(ms)) return t("justNow");
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return t("justNow");
    if (seconds < 3600)
      return t("minutesAgo", { count: Math.floor(seconds / 60) });
    if (seconds < 86400)
      return t("hoursAgo", { count: Math.floor(seconds / 3600) });
    return t("daysAgo", { count: Math.floor(seconds / 86400) });
  };

  const hasMore = notifications.length < total;
  const hasUnread = notifications.some((n) => !n.read);
  const hasRead = notifications.some((n) => n.read);

  const typeButtons: { value: FilterType; label: string }[] = [
    { value: "all", label: t("filterAll") },
    { value: "info", label: "Info" },
    { value: "success", label: "Success" },
    { value: "warning", label: "Warning" },
    { value: "error", label: "Error" },
  ];

  const readButtons: { value: FilterRead; label: string }[] = [
    { value: "all", label: t("filterAll") },
    { value: "unread", label: t("filterUnread") },
    { value: "read", label: t("filterRead") },
  ];

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Type filter */}
        <div className="flex gap-1 flex-wrap">
          {typeButtons.map((btn) => (
            <button
              key={btn.value}
              onClick={() => setTypeFilter(btn.value)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md transition-colors",
                typeFilter === btn.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* Read filter */}
        <div className="flex gap-1">
          {readButtons.map((btn) => (
            <button
              key={btn.value}
              onClick={() => setReadFilter(btn.value)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md transition-colors",
                readFilter === btn.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Search + bulk actions */}
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {hasUnread && (
          <button
            onClick={markAllRead}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-md bg-muted hover:bg-accent transition-colors whitespace-nowrap"
          >
            <Check className="w-3.5 h-3.5" />
            {t("markAllRead")}
          </button>
        )}

        {hasRead && (
          <button
            onClick={deleteRead}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-md bg-muted hover:bg-accent text-destructive transition-colors whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t("deleteRead")}
          </button>
        )}
      </div>

      {/* Notification list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Bell className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">{t("noResults")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((notif) => (
            <div
              key={notif.id}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-4 transition-colors cursor-pointer hover:bg-accent/50",
                !notif.read && "bg-accent/20 border-primary/20"
              )}
              onClick={() => handleAction(notif)}
            >
              <div className="mt-0.5 flex-shrink-0">{typeIcon(notif.type)}</div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-sm",
                    !notif.read && "font-semibold"
                  )}
                >
                  {notif.title}
                </p>
                {notif.message && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {notif.message}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <span>{timeAgo(notif.createdAt)}</span>
                  {notif.appId && (
                    <>
                      <span>·</span>
                      <span>{notif.appId}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(notif.id);
                }}
                className="p-1.5 rounded-md hover:bg-accent transition-colors flex-shrink-0"
                aria-label={t("dismiss")}
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          ))}

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() =>
                  fetchNotifications(notifications.length, true)
                }
                disabled={loadingMore}
                className="px-4 py-2 text-sm rounded-md bg-muted hover:bg-accent transition-colors disabled:opacity-50"
              >
                {loadingMore ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t("loadMore")
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
