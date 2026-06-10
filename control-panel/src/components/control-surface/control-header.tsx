"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { ComponentType, CSSProperties, DragEvent, RefObject } from "react";
import {
  Bell,
  Check,
  CheckCircle2,
  Clock,
  EyeOff,
  GripVertical,
  Home,
  Info,
  LogOut,
  Pencil,
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SiteName } from "@/components/control-surface/site-name";
import type { SiteNameStyle } from "@/lib/wordart-presets";

interface ControlHeaderProps {
  username: string;
  isAdmin: boolean;
  hasUserContext?: boolean;
}

interface DrawerApp {
  id: string;
  name: string;
  original_name?: string;
  icon?: string | null;
  custom_icon_url?: string | null;
  url?: string | null;
  visible?: boolean;
  order?: number | null;
  status?: string | null;
}

interface DrawerPrefs {
  columns?: number;
  iconScale?: number;
  maxHeight?: number;
}

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
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
  navigation?: {
    apps?: DrawerApp[];
  };
  drawer_prefs?: DrawerPrefs;
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
}

const DEFAULT_PREFS: Required<DrawerPrefs> = {
  columns: 4,
  iconScale: 1,
  maxHeight: 400,
};

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

function kebabToPascal(value: string) {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string; style?: CSSProperties }> | null {
  const icon = (LucideIcons as Record<string, unknown>)[kebabToPascal(name)];
  if (
    typeof icon === "function" ||
    (typeof icon === "object" && icon !== null && "$$typeof" in (icon as Record<string, unknown>))
  ) {
    return icon as ComponentType<{ className?: string; style?: CSSProperties }>;
  }
  return null;
}

function AppIcon({ app, size }: { app: DrawerApp; size: number }) {
  const [imgError, setImgError] = useState(false);
  const displayIcon = app.custom_icon_url ?? app.icon ?? null;

  if (displayIcon?.startsWith("emoji:")) {
    return <span className="leading-none" style={{ fontSize: size * 0.5 }}>{displayIcon.slice(6)}</span>;
  }

  if (displayIcon && !imgError && (displayIcon.startsWith("http") || displayIcon.startsWith("/") || displayIcon.startsWith("data:"))) {
    return (
      <img
        src={displayIcon}
        alt={app.name}
        className="rounded-xl object-cover"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }

  if (displayIcon && !imgError) {
    const Icon = getLucideIcon(displayIcon);
    if (Icon) return <Icon className="text-foreground/80" style={{ width: size * 0.5, height: size * 0.5 }} />;
  }

  return <span className="text-foreground/80">{app.name.charAt(0).toUpperCase()}</span>;
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

const SHAKE_CSS = `
@keyframes app-shake {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-1.5deg); }
  75% { transform: rotate(1.5deg); }
}
`;

function useElementRect(ref: RefObject<HTMLDivElement | null>, enabled: boolean): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRect(null);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const r = el.getBoundingClientRect();
      setRect({
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    };

    const timer = window.setTimeout(update, 30);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);

    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [enabled, ref]);

  return rect;
}

export function ControlHeader({ username, isAdmin, hasUserContext = true }: ControlHeaderProps) {
  const [config, setConfig] = useState<HeaderConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editDrawer, setEditDrawer] = useState(false);
  const [allApps, setAllApps] = useState<DrawerApp[]>([]);
  const [drawerPrefs, setDrawerPrefs] = useState<Required<DrawerPrefs>>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [draggedAppId, setDraggedAppId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [insertSide, setInsertSide] = useState<"before" | "after">("before");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [systemPref, setSystemPref] = useState<"light" | "dark">("light");
  const saveThemeTimeout = useRef<NodeJS.Timeout | null>(null);
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerRect = useElementRect(drawerRef, editDrawer && drawerOpen);

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
        navigation: { apps: [] },
        drawer_prefs: DEFAULT_PREFS,
        user: {
          name: username,
          username,
          email: username,
          is_admin: isAdmin,
          avatar_url: null,
        },
        notifications: { unread_count: 0, items: [] },
        theme: { mode: "system" },
      });
      setAllApps([]);
      setDrawerPrefs(DEFAULT_PREFS);
      setPrefsLoaded(true);
      return;
    }

    const res = await fetch(bridgeApi("header/config"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setConfig(data);
    setAllApps(data.navigation?.apps ?? []);
    setDrawerPrefs({ ...DEFAULT_PREFS, ...(data.drawer_prefs ?? {}) });
    setPrefsLoaded(true);
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

  useEffect(() => {
    if (!drawerOpen) setEditDrawer(false);
  }, [drawerOpen]);

  const fetchDrawerApps = useCallback(async () => {
    if (!hasUserContext) return;
    const res = await fetch(bridgeApi("apps/drawer"), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setAllApps(data.apps ?? []);
  }, [hasUserContext]);

  const fetchDrawerPrefs = useCallback(async () => {
    if (!hasUserContext) {
      setPrefsLoaded(true);
      return;
    }
    try {
      const res = await fetch(bridgeApi("apps/drawer/prefs"), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setDrawerPrefs({ ...DEFAULT_PREFS, ...data });
    } finally {
      setPrefsLoaded(true);
    }
  }, [hasUserContext]);

  useEffect(() => {
    if (!drawerOpen) return;
    fetchDrawerApps().catch(() => {});
    if (!prefsLoaded) fetchDrawerPrefs().catch(() => {});
  }, [drawerOpen, fetchDrawerApps, fetchDrawerPrefs, prefsLoaded]);

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
  const email = config?.user?.email || username;
  const avatarUrl = config?.user?.avatar_url || null;
  const headerIsAdmin = config?.user?.is_admin ?? isAdmin;
  const siteName = config?.branding?.site_name || "YouEye";
  const siteNameStyle = config?.branding?.site_name_style ?? null;
  const logoUrl = config?.branding?.logo_url ?? null;
  const unreadCount = config?.notifications?.unread_count ?? 0;
  const notifications = config?.notifications?.items ?? [];
  const prefs = drawerPrefs;
  const themeMode = config?.theme?.mode ?? "system";

  const visibleApps = useMemo(() => {
    return [...allApps]
      .filter((app) => app.visible !== false)
      .sort((a, b) => {
        const ao = a.order ?? 999;
        const bo = b.order ?? 999;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      });
  }, [allApps]);

  const hiddenApps = useMemo(() => [...allApps]
    .filter((app) => app.visible === false)
    .sort((a, b) => a.name.localeCompare(b.name)), [allApps]);

  const draggingFromVisible = draggedAppId != null && visibleApps.some((app) => app.id === draggedAppId);

  const persistDrawerPrefs = useCallback((next: Required<DrawerPrefs>) => {
    if (!hasUserContext) return;
    setDrawerPrefs(next);
    setConfig((current) => ({ ...(current ?? {}), drawer_prefs: next }));
    if (savePrefsTimeout.current) clearTimeout(savePrefsTimeout.current);
    savePrefsTimeout.current = setTimeout(() => {
      fetch(bridgeApi("apps/drawer/prefs"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
    }, 500);
  }, [hasUserContext]);

  const toggleVisibility = useCallback(async (appId: string, visible: boolean) => {
    if (!hasUserContext) return;
    setAllApps((current) => current.map((app) => app.id === appId ? { ...app, visible } : app));
    try {
      await fetch(bridgeApi(`apps/drawer/${encodeURIComponent(appId)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible }),
      });
    } catch {
      setAllApps((current) => current.map((app) => app.id === appId ? { ...app, visible: !visible } : app));
    }
  }, [hasUserContext]);

  const reorderApp = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setAllApps((current) => {
      const visible = [...current]
        .filter((app) => app.visible !== false)
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      const dragIdx = visible.findIndex((app) => app.id === draggedId);
      const targetIdx = visible.findIndex((app) => app.id === targetId);
      if (dragIdx < 0 || targetIdx < 0) return current;
      const [dragged] = visible.splice(dragIdx, 1);
      visible.splice(targetIdx, 0, dragged);
      const orderMap = new Map<string, number>();
      visible.forEach((app, index) => {
        orderMap.set(app.id, index);
        fetch(bridgeApi(`apps/drawer/${encodeURIComponent(app.id)}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: index }),
        }).catch(() => {});
      });
      return current.map((app) => {
        const order = orderMap.get(app.id);
        return order === undefined ? app : { ...app, order };
      });
    });
  }, []);

  function handleDragStart(event: DragEvent, appId: string) {
    setDraggedAppId(appId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", appId);
  }

  function handleDragEnd() {
    setDraggedAppId(null);
    setDragOverTarget(null);
  }

  function handleDragOverApp(event: DragEvent, appId: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverTarget(appId);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setInsertSide(event.clientX < rect.left + rect.width / 2 ? "before" : "after");
  }

  function handleDropOnApp(event: DragEvent, targetId: string) {
    event.preventDefault();
    if (draggedAppId && draggedAppId !== targetId) {
      const app = allApps.find((item) => item.id === draggedAppId);
      if (app && app.visible === false) toggleVisibility(draggedAppId, true).catch(() => {});
      reorderApp(draggedAppId, targetId);
    }
    handleDragEnd();
  }

  function handleDropOnHidden(event: DragEvent) {
    event.preventDefault();
    if (draggedAppId) toggleVisibility(draggedAppId, false).catch(() => {});
    handleDragEnd();
  }

  function handleDropOnVisible(event: DragEvent) {
    event.preventDefault();
    if (draggedAppId) {
      const app = allApps.find((item) => item.id === draggedAppId);
      if (app && app.visible === false) toggleVisibility(draggedAppId, true).catch(() => {});
    }
    handleDragEnd();
  }

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

  async function cycleTheme() {
    if (!hasUserContext) return;
    const next = themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light";
    setConfig((current) => ({ ...(current ?? {}), theme: { ...(current?.theme ?? {}), mode: next } }));
    document.documentElement.classList.toggle("dark", next === "dark" || (next === "system" && systemPref === "dark"));
    if (saveThemeTimeout.current) clearTimeout(saveThemeTimeout.current);
    saveThemeTimeout.current = setTimeout(() => {
      fetch(bridgeApi("themes/active"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      }).catch(() => {});
    }, 300);
  }

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
        <Popover open={drawerOpen} onOpenChange={setDrawerOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Apps">
              <DotsIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-[340px] origin-top-right rounded-xl p-0 transition-all duration-200"
            onInteractOutside={(event) => {
              if (editDrawer) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (editDrawer) {
                event.preventDefault();
                setEditDrawer(false);
              }
            }}
          >
            {editDrawer && <style dangerouslySetInnerHTML={{ __html: SHAKE_CSS }} />}
            <div ref={drawerRef}>
              {editDrawer ? (
                <div className="flex items-center justify-between px-3 pb-1 pt-3">
                  <span className="text-sm font-semibold">Apps</span>
                  <Button variant="default" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setEditDrawer(false)}>
                    <Check className="h-3.5 w-3.5" />
                    Done
                  </Button>
                </div>
              ) : (
                <div className="absolute left-2 top-2 z-10">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
                    onClick={() => setEditDrawer(true)}
                    title="Edit drawer"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              <ScrollArea style={{ maxHeight: editDrawer ? "calc(100vh - 200px)" : prefs.maxHeight }}>
                <div
                  className="p-3 pt-2"
                  onDragOver={editDrawer ? (event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  } : undefined}
                  onDrop={editDrawer ? handleDropOnVisible : undefined}
                >
                {visibleApps.length === 0 && !editDrawer ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <p className="mb-3 text-sm text-muted-foreground">No apps installed</p>
                    {headerIsAdmin && (
                      <Link href="/market" className="text-sm text-primary hover:underline" onClick={() => setDrawerOpen(false)}>
                        Visit marketplace
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${prefs.columns}, 1fr)` }}>
                    {visibleApps.map((app, index) => {
                      const up = app.status !== "unhealthy";
                      const size = 40 * prefs.iconScale;
                      return (
                        <div
                          key={app.id}
                          className={`relative flex flex-col items-center rounded-xl p-2 transition-all duration-150 ${
                            editDrawer
                              ? `cursor-grab select-none ${
                                  draggedAppId === app.id
                                    ? "scale-90 opacity-30"
                                    : dragOverTarget === app.id
                                      ? `scale-105 bg-primary/10 ${insertSide === "before" ? "border-l-2 border-l-primary" : "border-r-2 border-r-primary"}`
                                      : "hover:bg-accent/60"
                                }`
                              : "cursor-pointer hover:scale-105 hover:bg-accent/60"
                          } ${up ? "" : "opacity-40 grayscale"}`}
                          style={editDrawer && draggedAppId !== app.id ? {
                            animation: "app-shake 0.4s ease-in-out infinite alternate",
                            animationDelay: `${(index % 5) * 0.08}s`,
                          } : undefined}
                          draggable={editDrawer}
                          title={up ? app.name : `${app.name} - offline`}
                          onDragStart={editDrawer ? (event) => handleDragStart(event, app.id) : undefined}
                          onDragEnd={editDrawer ? handleDragEnd : undefined}
                          onDragOver={editDrawer ? (event) => handleDragOverApp(event, app.id) : undefined}
                          onDrop={editDrawer ? (event) => handleDropOnApp(event, app.id) : undefined}
                          onClick={() => {
                            if (editDrawer) return;
                            if (app.url) window.location.href = app.url;
                            setDrawerOpen(false);
                          }}
                        >
                          {editDrawer && (
                            <>
                              <GripVertical className="absolute right-0.5 top-0.5 h-3 w-3 text-muted-foreground/30" />
                              <button
                                type="button"
                                className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border transition-colors hover:bg-accent"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleVisibility(app.id, false).catch(() => {});
                                }}
                                title="Hide app"
                              >
                                <EyeOff className="h-3 w-3" />
                              </button>
                            </>
                          )}
                          <div className="flex items-center justify-center overflow-hidden rounded-xl text-base font-medium" style={{ width: size, height: size }}>
                            <AppIcon app={app} size={size} />
                          </div>
                          <span className="mt-1.5 w-full line-clamp-1 text-center text-[11px] leading-tight text-foreground/80">
                            {app.name}
                          </span>
                        </div>
                      );
                    })}
                    {visibleApps.length === 0 && editDrawer && (
                      <div className="col-span-full py-8 text-center text-xs text-muted-foreground">Drag apps here to show</div>
                    )}
                  </div>
                )}
                </div>
              </ScrollArea>
            </div>
          </PopoverContent>
        </Popover>
        )}

        {hasUserContext && editDrawer && drawerRect && typeof document !== "undefined" && createPortal(
          <>
            <div
              className="fixed z-[60] w-64 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
              style={{
                top: drawerRect.top,
                left: Math.max(12, drawerRect.left - 276),
                maxHeight: Math.min(360, window.innerHeight - drawerRect.top - 16),
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = draggingFromVisible ? "move" : "none";
              }}
              onDrop={handleDropOnHidden}
            >
              <div className="mb-2 flex items-center gap-2">
                <EyeOff className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Hidden apps</span>
              </div>
              {hiddenApps.length === 0 ? (
                <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Drag apps here to hide</div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {hiddenApps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      draggable
                      className="flex flex-col items-center rounded-lg p-2 text-center transition-colors hover:bg-accent/60"
                      onDragStart={(event) => handleDragStart(event, app.id)}
                      onDragEnd={handleDragEnd}
                      onClick={() => toggleVisibility(app.id, true).catch(() => {})}
                    >
                      <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl">
                        <AppIcon app={app} size={36} />
                      </div>
                      <span className="mt-1 w-full truncate text-[10px] text-muted-foreground">{app.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div
              className="fixed z-[60] w-[340px] rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
              style={{
                top: Math.min(window.innerHeight - 150, drawerRect.bottom + 8),
                left: drawerRect.left,
              }}
            >
              <div className="grid gap-3 text-xs">
                <label className="grid gap-1.5">
                  <span className="font-medium">Columns</span>
                  <input
                    type="range"
                    min={2}
                    max={6}
                    value={prefs.columns}
                    onChange={(event) => persistDrawerPrefs({ ...prefs, columns: Number(event.target.value) })}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="font-medium">Icon size</span>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={prefs.iconScale}
                    onChange={(event) => persistDrawerPrefs({ ...prefs, iconScale: Number(event.target.value) })}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="font-medium">Height</span>
                  <input
                    type="range"
                    min={200}
                    max={800}
                    step={20}
                    value={prefs.maxHeight}
                    onChange={(event) => persistDrawerPrefs({ ...prefs, maxHeight: Number(event.target.value) })}
                  />
                </label>
              </div>
            </div>
          </>,
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
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                {displayName}
                {headerIsAdmin && <Shield className="size-3 text-primary" />}
              </span>
              <span className="text-xs font-normal text-muted-foreground">{email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {hasUserContext && (
              <DropdownMenuItem onClick={() => { window.location.href = "/timeline"; }}>
                <Clock className="size-4" />
                Timeline
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => { window.location.href = hasUserContext ? "/settings" : "/settings/system"; }}>
              <Settings className="size-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {hasUserContext && (
              <>
                <DropdownMenuItem onClick={cycleTheme}>
                  {themeMode === "light" ? <Sun className="size-4" /> : themeMode === "dark" ? <Moon className="size-4" /> : <Monitor className="size-4" />}
                  {themeMode === "light" ? "Light theme" : themeMode === "dark" ? "Dark theme" : "System theme"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={logout} className="text-destructive">
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
