/**
 * App Drawer — Google-style Popover with floating edit-mode panels
 *
 * Normal mode: compact dropdown from the 9-dot grid button.
 * Edit mode:   the drawer itself stays visually the same — icons just shake
 *              and become draggable.  Two SEPARATE floating panels appear
 *              rendered via React createPortal at document.body:
 *                – Hidden-apps panel to the LEFT (grid tiles, not a list)
 *                – Layout controls BELOW
 *              These are completely independent DOM elements positioned with
 *              position:fixed based on the popover's bounding rect.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  BookOpen,
  StickyNote,
  Film,
  CloudSun,
  Languages,
  Package,
  Camera,
  MessageCircle,
  Pencil,
  Check,
  EyeOff,
  GripVertical,
  Globe,
  Music,
  Star,
  Heart,
  Gamepad2,
  Headphones,
  ShoppingCart,
  Utensils,
  Newspaper,
  Tv,
  Radio,
  Palette,
  Code,
  Terminal,
  Mail,
  Bookmark,
  Calendar,
  MapPin,
  Video,
  Image,
  Database,
  FileText,
} from "lucide-react";
import type { ComponentType } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import Link from "next/link";

// ────────────────────────────────────────
// Types
// ────────────────────────────────────────

interface DrawerApp {
  id: string;
  name: string;
  original_name: string;
  icon: string | null;
  custom_icon_url: string | null;
  visible: boolean;
  order: number;
  section_id: string | null;
  status: string | null;
  url: string | null;
}

interface DrawerPrefs {
  columns: number;
  iconScale: number;
  maxHeight: number;
}

const DEFAULT_PREFS: DrawerPrefs = {
  columns: 4,
  iconScale: 1,
  maxHeight: 400,
};

// ────────────────────────────────────────
// Shake animation (injected once in edit mode)
// ────────────────────────────────────────

const SHAKE_CSS = `
@keyframes app-shake {
  0%, 100% { transform: rotate(0deg); }
  25%      { transform: rotate(-1.5deg); }
  75%      { transform: rotate(1.5deg); }
}
`;

// ────────────────────────────────────────
// Icon rendering
// ────────────────────────────────────────

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

const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  search: Search,
  "book-open": BookOpen,
  "sticky-note": StickyNote,
  film: Film,
  "cloud-sun": CloudSun,
  languages: Languages,
  camera: Camera,
  "message-circle": MessageCircle,
  package: Package,
  globe: Globe,
  music: Music,
  star: Star,
  heart: Heart,
  gamepad2: Gamepad2,
  headphones: Headphones,
  "shopping-cart": ShoppingCart,
  utensils: Utensils,
  newspaper: Newspaper,
  tv: Tv,
  radio: Radio,
  palette: Palette,
  code: Code,
  terminal: Terminal,
  mail: Mail,
  bookmark: Bookmark,
  calendar: Calendar,
  "map-pin": MapPin,
  video: Video,
  image: Image,
  database: Database,
  "file-text": FileText,
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function AppIcon({
  icon,
  customIconUrl,
  name,
  className = "w-10 h-10",
  size,
}: {
  icon: string | null;
  customIconUrl: string | null;
  name: string;
  className?: string;
  size?: number;
}) {
  const sizeStyle = size ? { width: size, height: size } : undefined;
  if (customIconUrl) {
    return (
      <img
        src={customIconUrl}
        alt={name}
        className={`${size ? "" : className} rounded-xl object-cover`}
        style={sizeStyle}
      />
    );
  }
  if (icon && icon.startsWith("emoji:")) {
    return <span className="text-xl leading-none" style={size ? { fontSize: size * 0.5 } : undefined}>{icon.slice(6)}</span>;
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return (
      <img
        src={icon}
        alt={name}
        className={`${size ? "" : className} rounded-xl object-cover`}
        style={sizeStyle}
      />
    );
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
    if (IconComponent) {
      return <IconComponent className="text-foreground/80" style={size ? { width: size * 0.5, height: size * 0.5 } : { width: 20, height: 20 }} />;
    }
  }
  return (
    <span className="text-foreground/80">{name.charAt(0).toUpperCase()}</span>
  );
}

function isAppUp(status: string | null): boolean {
  return status !== "unhealthy";
}

// ────────────────────────────────────────
// Rect tracker hook
// ────────────────────────────────────────

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function useElementRect(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
): Rect | null {
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

    // Initial read (small delay for Radix positioning)
    const timer = setTimeout(update, 30);

    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);

    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, enabled]);

  return rect;
}

// ────────────────────────────────────────
// Main Component
// ────────────────────────────────────────

export function AppDrawer({ isAdmin = false }: { isAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [allApps, setAllApps] = useState<DrawerApp[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [prefs, setPrefs] = useState<DrawerPrefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [draggedAppId, setDraggedAppId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [insertSide, setInsertSide] = useState<"before" | "after">("before");
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslations("appDrawer");

  // Ref on the inner wrapper of PopoverContent to track its position
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerRect = useElementRect(drawerRef, editMode && open);

  // ── Data fetching ──

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (!res.ok) return;
      const data = await res.json();
      setAllApps(data.apps ?? []);
    } catch {
      // Silently fail
    }
  }, []);

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer/prefs");
      if (!res.ok) return;
      const data = await res.json();
      setPrefs({
        columns: data.columns ?? DEFAULT_PREFS.columns,
        iconScale: data.iconScale ?? DEFAULT_PREFS.iconScale,
        maxHeight: data.maxHeight ?? DEFAULT_PREFS.maxHeight,
      });
    } catch {
      // Use defaults
    } finally {
      setPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchApps();
      if (!prefsLoaded) fetchPrefs();
    }
  }, [open, fetchApps, fetchPrefs, prefsLoaded]);

  // ── Prefs persistence ──

  const persistPrefs = useCallback((newPrefs: DrawerPrefs) => {
    setPrefs(newPrefs);
    if (savePrefsTimeout.current) clearTimeout(savePrefsTimeout.current);
    savePrefsTimeout.current = setTimeout(() => {
      fetch("/api/v1/apps/drawer/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newPrefs),
      }).catch(() => {});
    }, 500);
  }, []);

  // ── Visibility toggle ──

  const toggleVisibility = useCallback(
    async (appId: string, visible: boolean) => {
      setAllApps((prev) =>
        prev.map((a) => (a.id === appId ? { ...a, visible } : a))
      );
      try {
        await fetch(`/api/v1/apps/drawer/${appId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visible }),
        });
      } catch {
        setAllApps((prev) =>
          prev.map((a) => (a.id === appId ? { ...a, visible: !visible } : a))
        );
      }
    },
    []
  );

  // ── Reorder ──

  const reorderApp = useCallback(
    async (draggedId: string, targetId: string) => {
      if (draggedId === targetId) return;
      setAllApps((prev) => {
        const visible = [...prev]
          .filter((a) => a.visible)
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
        const dragIdx = visible.findIndex((a) => a.id === draggedId);
        const targetIdx = visible.findIndex((a) => a.id === targetId);
        if (dragIdx < 0 || targetIdx < 0) return prev;
        const [dragged] = visible.splice(dragIdx, 1);
        visible.splice(targetIdx, 0, dragged);
        const orderMap = new Map<string, number>();
        visible.forEach((a, i) => orderMap.set(a.id, i));
        visible.forEach((a, i) => {
          fetch(`/api/v1/apps/drawer/${a.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: i }),
          }).catch(() => {});
        });
        return prev.map((a) => {
          const newOrder = orderMap.get(a.id);
          return newOrder !== undefined ? { ...a, order: newOrder } : a;
        });
      });
    },
    []
  );

  // ── Click ──

  const handleAppClick = (app: DrawerApp) => {
    if (editMode) return;
    if (app.url) {
      window.location.href = app.url;
      setOpen(false);
    }
  };

  // ── Drag handlers ──

  const handleDragStart = (e: React.DragEvent, appId: string) => {
    setDraggedAppId(appId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", appId);
  };

  const handleDragEnd = () => {
    setDraggedAppId(null);
    setDragOverTarget(null);
  };

  const handleDragOverApp = (e: React.DragEvent, appId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(appId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setInsertSide(e.clientX < rect.left + rect.width / 2 ? "before" : "after");
  };

  const handleDropOnApp = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (draggedAppId && draggedAppId !== targetId) {
      const app = allApps.find((a) => a.id === draggedAppId);
      if (app && !app.visible) {
        toggleVisibility(draggedAppId, true);
      }
      reorderApp(draggedAppId, targetId);
    }
    setDraggedAppId(null);
    setDragOverTarget(null);
  };

  const handleDropOnHidden = (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedAppId) {
      toggleVisibility(draggedAppId, false);
    }
    setDraggedAppId(null);
    setDragOverTarget(null);
  };

  const handleDropOnVisible = (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedAppId) {
      const app = allApps.find((a) => a.id === draggedAppId);
      if (app && !app.visible) {
        toggleVisibility(draggedAppId, true);
      }
    }
    setDraggedAppId(null);
    setDragOverTarget(null);
  };

  // ── Derived lists ──

  const visibleApps = [...allApps]
    .filter((a) => a.visible)
    .sort((a, b) => {
      const ao = a.order ?? 999;
      const bo = b.order ?? 999;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });

  const hiddenApps = [...allApps]
    .filter((a) => !a.visible)
    .sort((a, b) => a.name.localeCompare(b.name));

  const draggingFromVisible =
    draggedAppId != null && visibleApps.some((a) => a.id === draggedAppId);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setEditMode(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label={t("title")}
        >
          <DotsIcon className="h-5 w-5" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[340px] rounded-xl p-0 origin-top-right transition-all duration-200"
        onInteractOutside={(e) => {
          // In edit mode, don't close on outside clicks — user must click Done
          if (editMode) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (editMode) {
            e.preventDefault();
            setEditMode(false);
          }
        }}
      >
        {/* Inject shake keyframes */}
        {editMode && (
          <style dangerouslySetInnerHTML={{ __html: SHAKE_CSS }} />
        )}

        {/* Inner wrapper — ref tracks position for satellite placement */}
        <div ref={drawerRef}>
          {/* ─── HEADER ─── */}
          {editMode ? (
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className="text-sm font-semibold">{t("title")}</span>
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setEditMode(false)}
              >
                <Check className="h-3.5 w-3.5" />
                {t("doneEditing")}
              </Button>
            </div>
          ) : (
            <div className="absolute top-2 left-2 z-10">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
                onClick={() => setEditMode(true)}
                title="Edit drawer"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {/* ─── APP GRID — same look in both modes ─── */}
          <ScrollArea
            style={{
              maxHeight: editMode ? "calc(100vh - 200px)" : prefs.maxHeight,
            }}
          >
            <div
              className="p-3 pt-2"
              onDragOver={
                editMode
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }
                  : undefined
              }
              onDrop={editMode ? handleDropOnVisible : undefined}
            >
              {visibleApps.length === 0 && !editMode ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <p className="text-sm text-muted-foreground mb-3">
                    {t("noAppsInstalled")}
                  </p>
                  {isAdmin && (
                    <Link
                      href="/app-market"
                      className="text-sm text-primary hover:underline"
                      onClick={() => setOpen(false)}
                    >
                      {t("visitMarketplace")}
                    </Link>
                  )}
                </div>
              ) : (
                <div
                  className="grid gap-1"
                  style={{
                    gridTemplateColumns: `repeat(${prefs.columns}, 1fr)`,
                  }}
                >
                  {visibleApps.map((app, i) => {
                    const up = isAppUp(app.status);
                    const isDragging = draggedAppId === app.id;
                    const isDragOver = dragOverTarget === app.id;
                    return (
                      <div
                        key={app.id}
                        className={`relative flex flex-col items-center p-2 rounded-xl transition-all duration-150 ${
                          editMode
                            ? `cursor-grab select-none ${
                                isDragging
                                  ? "opacity-30 scale-90"
                                  : isDragOver
                                    ? `bg-primary/10 scale-105 ${insertSide === "before" ? "border-l-2 border-l-primary" : "border-r-2 border-r-primary"}`
                                    : "hover:bg-accent/60"
                              }`
                            : `cursor-pointer hover:bg-accent/60 hover:scale-105`
                        }${up ? "" : " opacity-40 grayscale"}`}
                        style={
                          editMode && !isDragging
                            ? {
                                animation:
                                  "app-shake 0.4s ease-in-out infinite alternate",
                                animationDelay: `${(i % 5) * 0.08}s`,
                              }
                            : undefined
                        }
                        draggable={editMode}
                        onDragStart={
                          editMode
                            ? (e) => handleDragStart(e, app.id)
                            : undefined
                        }
                        onDragEnd={editMode ? handleDragEnd : undefined}
                        onDragOver={
                          editMode
                            ? (e) => handleDragOverApp(e, app.id)
                            : undefined
                        }
                        onDrop={
                          editMode
                            ? (e) => handleDropOnApp(e, app.id)
                            : undefined
                        }
                        onClick={
                          editMode ? undefined : () => handleAppClick(app)
                        }
                        title={
                          editMode
                            ? app.name
                            : up
                              ? app.name
                              : `${app.name} — offline`
                        }
                      >
                        {editMode && (
                          <GripVertical className="absolute top-0.5 right-0.5 h-3 w-3 text-muted-foreground/30" />
                        )}
                        <div className="rounded-xl flex items-center justify-center text-base font-medium overflow-hidden transition-transform duration-150" style={{ width: 40 * prefs.iconScale, height: 40 * prefs.iconScale }}>
                          <AppIcon
                            icon={app.icon}
                            customIconUrl={app.custom_icon_url}
                            name={app.name}
                            size={40 * prefs.iconScale}
                          />
                        </div>
                        <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                          {app.name}
                        </span>
                      </div>
                    );
                  })}
                  {visibleApps.length === 0 && editMode && (
                    <div className="col-span-full text-xs text-muted-foreground text-center py-8">
                      Drag apps here to show
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>

      {/* ═══════════════════════════════════════════════════════════════
          SATELLITE PANELS — rendered via createPortal at document.body
          These are completely separate DOM elements from the popover.
          ═══════════════════════════════════════════════════════════════ */}
      {editMode &&
        open &&
        drawerRect &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* ── Hidden apps panel — LEFT of drawer ── */}
            <div
              className={`rounded-xl border shadow-lg transition-colors ${
                draggingFromVisible
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-popover"
              }`}
              style={{
                position: "fixed",
                top: drawerRect.top,
                right:
                  document.documentElement.clientWidth -
                  drawerRect.left +
                  12,
                zIndex: 50,
                minWidth: 180,
                maxHeight: drawerRect.height,
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={handleDropOnHidden}
            >
              <div className="px-3 py-2.5 border-b border-border/50">
                <div className="flex items-center gap-1.5">
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Hidden ({hiddenApps.length})
                  </span>
                </div>
              </div>
              <div className="p-3">
                {hiddenApps.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/50 text-center py-8 px-3">
                    Drag apps here to hide
                  </div>
                ) : (
                  <div
                    className="grid gap-1"
                    style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
                  >
                    {hiddenApps.map((app, i) => (
                      <div
                        key={app.id}
                        className={`flex flex-col items-center p-2 rounded-xl cursor-grab select-none transition-all duration-150 opacity-60 hover:opacity-100 hover:bg-accent/40 ${
                          draggedAppId === app.id
                            ? "opacity-20 scale-90"
                            : ""
                        }`}
                        style={{
                          animation:
                            "app-shake 0.4s ease-in-out infinite alternate",
                          animationDelay: `${(i % 5) * 0.08}s`,
                        }}
                        draggable
                        onDragStart={(e) => handleDragStart(e, app.id)}
                        onDragEnd={handleDragEnd}
                      >
                        <div className="rounded-xl flex items-center justify-center text-base font-medium overflow-hidden" style={{ width: 40 * prefs.iconScale, height: 40 * prefs.iconScale }}>
                          <AppIcon
                            icon={app.icon}
                            customIconUrl={app.custom_icon_url}
                            name={app.name}
                            size={40 * prefs.iconScale}
                          />
                        </div>
                        <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                          {app.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Controls panel — BELOW drawer ── */}
            <div
              className="rounded-xl border border-border bg-popover text-popover-foreground shadow-lg px-3 py-2.5 space-y-2"
              style={{
                position: "fixed",
                top: drawerRect.bottom + 8,
                left: drawerRect.left,
                width: drawerRect.width,
                zIndex: 50,
              }}
            >
              {/* Columns */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Columns</span>
                <div className="flex items-center gap-1">
                  {[3, 4, 5].map((n) => (
                    <button
                      key={n}
                      className={`w-6 h-6 rounded text-xs font-medium transition-colors ${
                        prefs.columns === n
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 text-foreground/60 hover:bg-accent"
                      }`}
                      onClick={() => persistPrefs({ ...prefs, columns: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              {/* Icon size */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Icon size
                </span>
                <input
                  type="range"
                  min="0.7"
                  max="1.5"
                  step="0.1"
                  value={prefs.iconScale}
                  onChange={(e) =>
                    persistPrefs({
                      ...prefs,
                      iconScale: parseFloat(e.target.value),
                    })
                  }
                  className="w-24 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
                />
              </div>
              {/* Max height */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Max height
                </span>
                <input
                  type="range"
                  min="200"
                  max="700"
                  step="50"
                  value={prefs.maxHeight}
                  onChange={(e) =>
                    persistPrefs({
                      ...prefs,
                      maxHeight: parseInt(e.target.value, 10),
                    })
                  }
                  className="w-24 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
                />
              </div>
            </div>
          </>,
          document.body
        )}
    </Popover>
  );
}
