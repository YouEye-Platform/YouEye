/**
 * App Drawer — Plan 5 (two cooperating surfaces).
 *
 * The QUICK drawer: the user's PINNED apps (`pinned` === the old `visible`),
 * for fast access. A search box finds ANY app — including unpinned ones — and
 * opens it. Edit mode manages pins: "Add app" → search → add, and an × to
 * remove. There is NO hidden tray (unpinning just drops the app from the drawer;
 * it still lives in the launcher). An "All apps" button opens the launcher
 * (everything + folders).
 *
 * Renders two ways from one implementation:
 *   • default  — the UI header popover (9-dot trigger + Radix popover).
 *   • embedded — content-only, for the UI-served /embed/drawer iframe that
 *     native apps host (host provides the panel chrome). `onOpenLauncher` then
 *     posts a youeye:action so the host swaps in the launcher.
 */

"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Pencil, Check, GripVertical, Search, Plus, X, LayoutGrid } from "lucide-react";
import * as LucideIcons from "lucide-react";
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
  pinned?: boolean;
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

function kebabToPascal(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string; style?: React.CSSProperties }> | undefined {
  const pascal = kebabToPascal(name);
  const icon = (LucideIcons as Record<string, unknown>)[pascal];
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in (icon as Record<string, unknown>))) {
    return icon as ComponentType<{ className?: string; style?: React.CSSProperties }>;
  }
  return undefined;
}

function AppIcon({
  icon,
  customIconUrl,
  name,
  size = 40,
}: {
  icon: string | null;
  customIconUrl: string | null;
  name: string;
  size?: number;
}) {
  const [imgError, setImgError] = useState(false);
  const displayIcon = customIconUrl ?? icon;
  if (displayIcon && displayIcon.startsWith("emoji:")) {
    return <span className="leading-none" style={{ fontSize: size * 0.5 }}>{displayIcon.slice(6)}</span>;
  }
  if (displayIcon && !imgError && (displayIcon.startsWith("http") || displayIcon.startsWith("/") || displayIcon.startsWith("data:"))) {
    return (
      <img
        src={displayIcon}
        alt={name}
        className="rounded-xl object-cover"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }
  if (displayIcon && !imgError) {
    const IconComponent = getLucideIcon(displayIcon);
    if (IconComponent) {
      return <IconComponent className="text-foreground/80" style={{ width: size * 0.5, height: size * 0.5 }} />;
    }
  }
  return <span className="text-foreground/80">{name.charAt(0).toUpperCase()}</span>;
}

function isAppUp(status: string | null): boolean {
  return status !== "unhealthy";
}

// ────────────────────────────────────────
// Main Component
// ────────────────────────────────────────

export function AppDrawer({
  isAdmin = false,
  embedded = false,
  onOpenLauncher,
}: {
  isAdmin?: boolean;
  embedded?: boolean;
  onOpenLauncher?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [allApps, setAllApps] = useState<DrawerApp[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [query, setQuery] = useState("");
  const [addQuery, setAddQuery] = useState("");
  const [prefs, setPrefs] = useState<DrawerPrefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [draggedAppId, setDraggedAppId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [insertSide, setInsertSide] = useState<"before" | "after">("before");
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslations("appDrawer");

  const active = embedded || open;

  // ── Data fetching ──

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (!res.ok) return;
      const data = await res.json();
      setAllApps(data.apps ?? []);
    } catch {
      /* silently fail */
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
      /* defaults */
    } finally {
      setPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (active) {
      fetchApps();
      if (!prefsLoaded) fetchPrefs();
    }
  }, [active, fetchApps, fetchPrefs, prefsLoaded]);

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

  // ── Pin / unpin (the only pin gesture — Plan 5 L5) ──

  const setPinned = useCallback(async (appId: string, pinned: boolean) => {
    setAllApps((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, visible: pinned, pinned } : a))
    );
    try {
      await fetch(`/api/v1/apps/drawer/${appId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: pinned }),
      });
    } catch {
      setAllApps((prev) =>
        prev.map((a) => (a.id === appId ? { ...a, visible: !pinned, pinned: !pinned } : a))
      );
    }
  }, []);

  // ── Reorder (pinned apps share one displayOrder with the launcher) ──

  const reorderApp = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setAllApps((prev) => {
      const pinned = [...prev]
        .filter((a) => a.visible)
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      const dragIdx = pinned.findIndex((a) => a.id === draggedId);
      const targetIdx = pinned.findIndex((a) => a.id === targetId);
      if (dragIdx < 0 || targetIdx < 0) return prev;
      const [dragged] = pinned.splice(dragIdx, 1);
      pinned.splice(targetIdx, 0, dragged);
      const orderMap = new Map<string, number>();
      pinned.forEach((a, i) => orderMap.set(a.id, i));
      pinned.forEach((a, i) => {
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
  }, []);

  // ── Click ──

  const handleAppClick = (app: DrawerApp) => {
    if (editMode || !app.url) return;
    try {
      navigator.sendBeacon(
        "/api/v1/telemetry/record",
        JSON.stringify({ events: [{ type: "app_launch", key: app.id || app.name }] })
      );
    } catch {
      /* best-effort */
    }
    window.location.href = app.url;
    setOpen(false);
  };

  // ── Drag (reorder pinned apps in edit mode) ──

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
    if (draggedAppId && draggedAppId !== targetId) reorderApp(draggedAppId, targetId);
    setDraggedAppId(null);
    setDragOverTarget(null);
  };

  // ── Derived lists ──

  const pinnedApps = useMemo(
    () =>
      [...allApps]
        .filter((a) => a.visible)
        .sort((a, b) => {
          const ao = a.order ?? 999;
          const bo = b.order ?? 999;
          return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
        }),
    [allApps]
  );

  const unpinnedApps = useMemo(
    () => [...allApps].filter((a) => !a.visible).sort((a, b) => a.name.localeCompare(b.name)),
    [allApps]
  );

  // Normal-mode search spans ALL apps (incl. unpinned) and opens them (L4).
  const q = query.trim().toLowerCase();
  const gridApps = useMemo(
    () =>
      q
        ? [...allApps]
            .filter((a) => a.url && a.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
        : pinnedApps,
    [q, allApps, pinnedApps]
  );

  const aq = addQuery.trim().toLowerCase();
  const addCandidates = useMemo(
    () => (aq ? unpinnedApps.filter((a) => a.name.toLowerCase().includes(aq)) : unpinnedApps),
    [aq, unpinnedApps]
  );

  const cols = prefs.columns;
  const iconPx = 40 * prefs.iconScale;

  // ── Reusable app tile ──

  const Tile = ({ app, mode }: { app: DrawerApp; mode: "open" | "edit" | "add" }) => {
    const up = isAppUp(app.status);
    const isDragging = draggedAppId === app.id;
    const isDragOver = dragOverTarget === app.id;
    return (
      <div
        key={app.id}
        className={`relative flex flex-col items-center rounded-xl p-2 transition-all duration-150 ${
          mode === "edit"
            ? `cursor-grab select-none ${
                isDragging
                  ? "scale-90 opacity-30"
                  : isDragOver
                    ? `scale-105 bg-primary/10 ${insertSide === "before" ? "border-l-2 border-l-primary" : "border-r-2 border-r-primary"}`
                    : "hover:bg-accent/60"
              }`
            : "cursor-pointer hover:scale-105 hover:bg-accent/60"
        }${up ? "" : " opacity-40 grayscale"}`}
        style={
          mode === "edit" && !isDragging
            ? { animation: "app-shake 0.4s ease-in-out infinite alternate" }
            : undefined
        }
        draggable={mode === "edit"}
        onDragStart={mode === "edit" ? (e) => handleDragStart(e, app.id) : undefined}
        onDragEnd={mode === "edit" ? handleDragEnd : undefined}
        onDragOver={mode === "edit" ? (e) => handleDragOverApp(e, app.id) : undefined}
        onDrop={mode === "edit" ? (e) => handleDropOnApp(e, app.id) : undefined}
        onClick={mode === "open" ? () => handleAppClick(app) : mode === "add" ? () => { setPinned(app.id, true); } : undefined}
        title={app.name}
      >
        {mode === "edit" && (
          <button
            type="button"
            aria-label={t("removeApp")}
            title={t("removeApp")}
            onClick={(e) => { e.stopPropagation(); setPinned(app.id, false); }}
            className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-danger"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {mode === "add" && (
          <span className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Plus className="h-3 w-3" />
          </span>
        )}
        <div className="flex items-center justify-center overflow-hidden rounded-xl" style={{ width: iconPx, height: iconPx }}>
          <AppIcon icon={app.icon} customIconUrl={app.custom_icon_url} name={app.name} size={iconPx} />
        </div>
        <span className="mt-1.5 line-clamp-1 w-full text-center text-[11px] leading-tight text-foreground/80">
          {app.name}
        </span>
      </div>
    );
  };

  // ── Content (shared by popover + embed) ──

  const content = (
    <div className={`flex flex-col ${embedded ? "h-full w-full" : ""}`}>
      {editMode && <style dangerouslySetInnerHTML={{ __html: SHAKE_CSS }} />}

      {/* Top bar: search + edit toggle */}
      <div className="flex items-center gap-2 p-3 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchApps")}
            className="h-9 w-full rounded-full border bg-card/80 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button
          variant={editMode ? "default" : "ghost"}
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => { setEditMode((v) => !v); setAddMode(false); setQuery(""); }}
          title={editMode ? t("doneEditing") : t("manageApps")}
          aria-label={editMode ? t("doneEditing") : t("manageApps")}
        >
          {editMode ? <Check className="h-4 w-4" /> : <Pencil className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Grid */}
      <ScrollArea
        className={embedded ? "min-h-0 flex-1" : ""}
        style={{ maxHeight: embedded ? undefined : editMode ? "calc(100vh - 260px)" : prefs.maxHeight }}
      >
        <div className="px-3 pb-2">
          {gridApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="mb-3 text-sm text-muted-foreground">
                {q ? t("noMatchingApps") : t("noAppsInstalled")}
              </p>
              {!q && isAdmin && (
                <Link href="/market" className="text-sm text-primary hover:underline" onClick={() => setOpen(false)}>
                  {t("visitMarketplace")}
                </Link>
              )}
            </div>
          ) : (
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
              {gridApps.map((app) => (
                <Tile key={app.id} app={app} mode={editMode ? "edit" : "open"} />
              ))}
            </div>
          )}

          {/* Edit mode: Add app (→ search → pin) */}
          {editMode && (
            <div className="mt-2 rounded-xl border border-dashed border-border/70">
              {!addMode ? (
                <button
                  type="button"
                  onClick={() => setAddMode(true)}
                  className="flex w-full items-center justify-center gap-2 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Plus className="h-4 w-4" /> {t("addApp")}
                </button>
              ) : (
                <div className="p-2">
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input
                      autoFocus
                      value={addQuery}
                      onChange={(e) => setAddQuery(e.target.value)}
                      placeholder={t("searchApps")}
                      className="h-8 w-full rounded-full border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  {addCandidates.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">{t("noAppsToAdd")}</p>
                  ) : (
                    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                      {addCandidates.map((app) => (
                        <Tile key={app.id} app={app} mode="add" />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Edit controls (popover only) */}
      {editMode && !embedded && (
        <div className="space-y-2 border-t px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Columns</span>
            <div className="flex items-center gap-1">
              {[3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`h-6 w-6 rounded text-xs font-medium transition-colors ${
                    prefs.columns === n ? "bg-primary text-primary-foreground" : "bg-accent/60 text-foreground/60 hover:bg-accent"
                  }`}
                  onClick={() => persistPrefs({ ...prefs, columns: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Icon size</span>
            <input
              type="range" min="0.7" max="1.5" step="0.1" value={prefs.iconScale}
              onChange={(e) => persistPrefs({ ...prefs, iconScale: parseFloat(e.target.value) })}
              className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
            />
          </div>
        </div>
      )}

      {/* All apps → launcher */}
      {onOpenLauncher && (
        <div className="border-t p-2">
          <button
            type="button"
            onClick={() => { onOpenLauncher(); setOpen(false); }}
            className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LayoutGrid className="h-4 w-4" /> {t("allApps")}
          </button>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className="h-full w-full bg-transparent">{content}</div>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) { setEditMode(false); setAddMode(false); setQuery(""); }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("title")}>
          <DotsIcon className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] rounded-2xl p-0"
        onInteractOutside={(e) => { if (editMode) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (editMode) { e.preventDefault(); setEditMode(false); } }}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
