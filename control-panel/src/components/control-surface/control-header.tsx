"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Home,
  Info,
  LogOut,
  Settings,
  Shield,
  Sun,
  Moon,
  Monitor,
  AlertTriangle,
  X,
  XCircle,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SiteName } from "@/components/control-surface/site-name";
import { applyThemeMode, THEME_MODE_EVENT, type ThemeMode } from "@/lib/theme";
import type { SiteNameStyle } from "@/lib/wordart-presets";

interface ControlHeaderProps {
  username: string;
  isAdmin: boolean;
  hasUserContext?: boolean;
}

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

interface HeaderConfig {
  branding?: {
    site_name?: string;
    site_name_style?: SiteNameStyle | null;
    logo_url?: string | null;
  };
  user?: {
    name?: string | null;
    username?: string | null;
    email?: string | null;
    is_admin?: boolean;
    avatar_url?: string | null;
  };
  notifications?: {
    unread_count?: number;
    items?: Notification[];
  };
  theme?: {
    mode?: string;
  };
  ui_base_url?: string | null;
}

const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation";
const DEFAULT_DRAWER_HEIGHT = 420;
const MIN_DRAWER_HEIGHT = 140;
const MAX_DRAWER_HEIGHT = 620;

function bridgeApi(path: string) {
  const prefix = typeof window !== "undefined" && window.location.pathname.startsWith("/market")
    ? "/market/api/ui-settings"
    : "/settings/api/ui-settings";
  return `${prefix}/${path.replace(/^\/+/, "")}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "YE";
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      {[4, 12, 20].map((cy) =>
        [4, 12, 20].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />
        ))
      )}
    </svg>
  );
}

function timeAgo(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function NotificationIcon({ type }: { type: string }) {
  switch (type) {
    case "success": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "warning": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "error": return <XCircle className="w-4 h-4 text-red-500" />;
    default: return <Info className="w-4 h-4 text-blue-500" />;
  }
}

export function ControlHeader({ username, isAdmin, hasUserContext = true }: ControlHeaderProps) {
  const [config, setConfig] = useState<HeaderConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [embedMode, setEmbedMode] = useState<"light" | "dark">("light");
  const [drawerHeight, setDrawerHeight] = useState(DEFAULT_DRAWER_HEIGHT);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [systemPref, setSystemPref] = useState<"light" | "dark">("light");
  const saveThemeTimeout = useRef<NodeJS.Timeout | null>(null);

  const loadConfig = useCallback(async () => {
    if (!hasUserContext) {
      const res = await fetch("/api/setup/config", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      setConfig({
        branding: {
          site_name: data.site_name || "YouEye",
          site_name_style: null,
          logo_url: null,
        },
        user: {
          name: username,
          username,
          email: username,
          is_admin: isAdmin,
          avatar_url: null,
        },
        notifications: { unread_count: 0, items: [] },
        theme: { mode: "system" },
        ui_base_url: null,
      });
      return;
    }

    const res = await fetch(bridgeApi("header/config"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setConfig(data);
  }, [hasUserContext, isAdmin, username]);

  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPref(mq.matches ? "dark" : "light");
    const handler = (event: MediaQueryListEvent) => setSystemPref(event.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const uiBaseUrl = config?.ui_base_url?.replace(/\/$/, "") ?? "";
  const uiBaseOrigin = (() => {
    if (!uiBaseUrl) return "";
    try {
      return new URL(uiBaseUrl).origin;
    } catch {
      return uiBaseUrl;
    }
  })();

  const resolveEmbedMode = useCallback((): "light" | "dark" => (
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  ), []);

  const openDrawer = useCallback((open: boolean) => {
    if (open) setEmbedMode(resolveEmbedMode());
    setDrawerOpen(open);
  }, [resolveEmbedMode]);

  useEffect(() => {
    if (!uiBaseOrigin) return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== uiBaseOrigin) return;
      if (event.data?.type === "youeye:action" && event.data?.action === "open-launcher") {
        setDrawerOpen(false);
        setEmbedMode(resolveEmbedMode());
        setLauncherOpen(true);
        return;
      }
      if (event.data?.type === "youeye:resize" && typeof event.data.height === "number") {
        setDrawerHeight(Math.max(MIN_DRAWER_HEIGHT, Math.min(MAX_DRAWER_HEIGHT, Math.ceil(event.data.height))));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [resolveEmbedMode, uiBaseOrigin]);

  useEffect(() => {
    if (!launcherOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLauncherOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [launcherOpen]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { url?: string | null } | undefined;
      setConfig((current) => ({
        ...(current ?? {}),
        user: {
          ...(current?.user ?? {}),
          avatar_url: detail?.url ?? null,
        },
      }));
    };
    window.addEventListener("avatar-updated", handler);
    return () => window.removeEventListener("avatar-updated", handler);
  }, []);

  const displayName = config?.user?.name || username;
  const firstName = displayName.split(" ")[0] || displayName;
  const email = config?.user?.email || username;
  const avatarUrl = config?.user?.avatar_url || null;
  const headerIsAdmin = config?.user?.is_admin ?? isAdmin;
  const siteName = config?.branding?.site_name || "YouEye";
  const siteNameStyle = config?.branding?.site_name_style ?? null;
  const logoUrl = config?.branding?.logo_url ?? null;
  const unreadCount = config?.notifications?.unread_count ?? 0;
  const notifications = config?.notifications?.items ?? [];
  const themeMode = config?.theme?.mode ?? "system";
  const drawerUrl = uiBaseUrl ? `${uiBaseUrl}/embed/drawer?mode=${embedMode}` : null;
  const launcherUrl = uiBaseUrl ? `${uiBaseUrl}/embed/launcher?mode=${embedMode}` : null;

  // Apply the user's saved light/dark/system mode to <html> on load and whenever
  // it changes. Source of truth is config.theme.mode (bridge → UI DB); the inline
  // boot script in app/layout.tsx handles the very first paint from the shared
  // localStorage("theme") key the dashboard's next-themes already writes.
  useEffect(() => {
    applyThemeMode(themeMode as ThemeMode);
  }, [themeMode, systemPref]);

  // Stay in sync when the Appearance page changes the mode (it broadcasts an event).
  useEffect(() => {
    const handler = (event: Event) => {
      const mode = (event as CustomEvent).detail?.mode as ThemeMode | undefined;
      if (!mode) return;
      setConfig((current) => ({ ...(current ?? {}), theme: { ...(current?.theme ?? {}), mode } }));
    };
    window.addEventListener(THEME_MODE_EVENT, handler);
    return () => window.removeEventListener(THEME_MODE_EVENT, handler);
  }, []);

  async function logout() {
    await fetch("/settings/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/";
  }

  async function refreshNotifications() {
    if (!hasUserContext) return;
    const res = await fetch(bridgeApi("notifications"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setConfig((current) => ({
      ...(current ?? {}),
      notifications: {
        unread_count: data.unread_count ?? 0,
        items: data.notifications ?? [],
      },
    }));
  }

  async function markRead(id: string) {
    if (!hasUserContext) return;
    await fetch(bridgeApi(`notifications/${id}`), { method: "PUT" });
    setConfig((current) => {
      const items = current?.notifications?.items ?? [];
      const wasUnread = items.find((item) => item.id === id && !item.read);
      return {
        ...(current ?? {}),
        notifications: {
          unread_count: Math.max(0, (current?.notifications?.unread_count ?? 0) - (wasUnread ? 1 : 0)),
          items: items.map((item) => item.id === id ? { ...item, read: true } : item),
        },
      };
    });
  }

  async function markAllRead() {
    if (!hasUserContext) return;
    await fetch(bridgeApi("notifications"), { method: "PUT" });
    setConfig((current) => ({
      ...(current ?? {}),
      notifications: {
        unread_count: 0,
        items: (current?.notifications?.items ?? []).map((item) => ({ ...item, read: true })),
      },
    }));
  }

  async function dismiss(id: string) {
    if (!hasUserContext) return;
    await fetch(bridgeApi(`notifications/${id}`), { method: "DELETE" });
    setConfig((current) => {
      const items = current?.notifications?.items ?? [];
      const removed = items.find((item) => item.id === id);
      return {
        ...(current ?? {}),
        notifications: {
          unread_count: Math.max(0, (current?.notifications?.unread_count ?? 0) - (removed && !removed.read ? 1 : 0)),
          items: items.filter((item) => item.id !== id),
        },
      };
    });
  }

  // E4 (D14-revised): direct Light/Dark/Auto setter for the segmented control.
  function applyTheme(mode: ThemeMode) {
    if (!hasUserContext) return;
    setConfig((current) => ({ ...(current ?? {}), theme: { ...(current?.theme ?? {}), mode } }));
    applyThemeMode(mode);
    if (saveThemeTimeout.current) clearTimeout(saveThemeTimeout.current);
    saveThemeTimeout.current = setTimeout(() => {
      fetch(bridgeApi("themes/active"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }).catch(() => {});
    }, 300);
  }

  const THEME_MODES: { mode: ThemeMode; Icon: typeof Sun; label: string }[] = [
    { mode: "light", Icon: Sun, label: "Light" },
    { mode: "dark", Icon: Moon, label: "Dark" },
    { mode: "system", Icon: Monitor, label: "Auto" },
  ];

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/95 px-4 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
          {logoUrl && <img src={logoUrl} alt="" className="h-6 w-6 object-contain" />}
          <SiteName name={siteName} style={siteNameStyle} />
        </Link>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
          <Link href="/" title="Home">
            <Home className="h-4 w-4" />
          </Link>
        </Button>

        {hasUserContext && (
          <Popover open={drawerOpen} onOpenChange={openDrawer}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Apps">
                <DotsIcon className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-[min(380px,92vw)] overflow-hidden rounded-2xl border-border/60 bg-popover/80 p-0 shadow-xl backdrop-blur-xl transition-[height] duration-150"
              style={{ height: drawerUrl ? drawerHeight : undefined }}
            >
              {drawerUrl ? (
                <iframe
                  src={drawerUrl}
                  className="h-full w-full border-0 bg-transparent"
                  title="App drawer"
                  sandbox={EMBED_SANDBOX}
                />
              ) : (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  Open apps from the dashboard once the UI origin is available.
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}

        {hasUserContext && launcherOpen && launcherUrl && typeof document !== "undefined" && createPortal(
          <div className="pointer-events-none fixed inset-0 z-[60]">
            <div className="pointer-events-auto absolute inset-x-0 bottom-0 top-14" onClick={() => setLauncherOpen(false)} />
            <div className="pointer-events-auto absolute inset-x-4 bottom-4 top-[68px] overflow-hidden rounded-3xl border border-border/40 bg-popover/70 shadow-2xl backdrop-blur-2xl sm:inset-x-7 sm:bottom-5">
              <iframe
                src={launcherUrl}
                className="h-full w-full border-0 bg-transparent"
                title="App launcher"
                sandbox={EMBED_SANDBOX}
              />
            </div>
          </div>,
          document.body
        )}

        {hasUserContext && (
        <Popover
          open={notificationsOpen}
          onOpenChange={(open) => {
            setNotificationsOpen(open);
            if (open) refreshNotifications().catch(() => {});
          }}
        >
          <PopoverTrigger asChild>
            <button className="relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-accent" aria-label="Notifications">
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="max-h-96 w-80 overflow-y-auto rounded-lg p-0">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Notifications</h3>
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <Check className="h-3 w-3" />
                  Mark all read
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications</div>
            ) : (
              <div className="divide-y">
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50 ${!notification.read ? "bg-accent/20" : ""}`}
                    onClick={() => {
                      if (notification.action?.url) window.location.href = notification.action.url;
                      if (!notification.read) markRead(notification.id).catch(() => {});
                    }}
                  >
                    <div className="mt-0.5"><NotificationIcon type={notification.type} /></div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${!notification.read ? "font-semibold" : ""}`}>{notification.title}</p>
                      {notification.message && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{notification.message}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">{timeAgo(notification.createdAt)}</p>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        dismiss(notification.id).catch(() => {});
                      }}
                      className="rounded p-1 transition-colors hover:bg-accent"
                      aria-label="Dismiss"
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t px-4 py-2">
              <a href="/notifications" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                View all
              </a>
            </div>
          </PopoverContent>
        </Popover>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="inline-flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent">
              <Avatar className="size-7">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="text-xs">{initials(displayName)}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          {/* E4 (D14-revised) — the same toned-down account panel mirrored from the UI:
              email, big avatar (no pencil-edit), greeting, grouped Timeline/Settings/Theme, Sign out.
              No "Manage your account" pill and no Privacy · About footer. */}
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-[340px] rounded-3xl p-0 overflow-hidden border bg-muted"
          >
            {/* Email, centered */}
            <p className="pt-4 pb-3 text-center text-xs text-muted-foreground truncate px-6">{email}</p>

            {/* Big avatar + greeting — display only */}
            <div className="flex flex-col items-center gap-2 px-5">
              <Avatar className="size-[76px]">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="text-xl">{initials(displayName)}</AvatarFallback>
              </Avatar>
              <div className="flex items-center gap-1.5 text-base font-medium">
                <span>Hi, {firstName}!</span>
                {headerIsAdmin && <Shield className="size-3.5 text-primary" />}
              </div>
            </div>

            {/* Grouped card */}
            <div className="m-3 rounded-2xl bg-card border overflow-hidden">
              {hasUserContext && (
                <>
                  <button
                    type="button"
                    onClick={() => { window.location.href = "/timeline"; }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
                  >
                    <Clock className="size-4 text-muted-foreground" />
                    Timeline
                  </button>
                  <div className="border-t" />
                </>
              )}
              <button
                type="button"
                onClick={() => { window.location.href = hasUserContext ? "/settings" : "/settings/system"; }}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-accent transition-colors"
              >
                <Settings className="size-4 text-muted-foreground" />
                Settings
              </button>
              {hasUserContext && (
                <>
                  <div className="border-t" />
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="flex items-center gap-3 text-sm">
                      <Sun className="size-4 text-muted-foreground" />
                      Theme
                    </span>
                    <div className="inline-flex rounded-lg border bg-background p-0.5">
                      {THEME_MODES.map(({ mode, Icon, label }) => {
                        const active = themeMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => applyTheme(mode)}
                            aria-pressed={active}
                            title={label}
                            className={`grid place-items-center size-7 rounded-md transition-colors ${
                              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <Icon className="size-3.5" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Sign out */}
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
