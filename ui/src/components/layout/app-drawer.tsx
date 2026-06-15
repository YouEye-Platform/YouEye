/**
 * App Drawer — Plan 5 (two cooperating surfaces; Slice 2.5 live reorder).
 *
 * The QUICK drawer: the user's PINNED apps (`pinned` === the old `visible`).
 * A search box finds ANY app and opens it. Edit mode manages pins ("Add app" →
 * search → add, × to remove) and **reorders live** via pointer drag (icons shift
 * into new positions as you drag — see useGridDrag). No hidden tray. "All apps"
 * opens the launcher.
 *
 * Renders as the UI header popover (default) or, with `embedded`, content-only
 * for the UI-served /embed/drawer iframe that native apps host.
 */

"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Pencil, Check, Search, Plus, X, LayoutGrid } from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useGridDrag } from "@/lib/hooks/use-grid-drag";

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

const DEFAULT_PREFS: DrawerPrefs = { columns: 4, iconScale: 1, maxHeight: 400 };

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      {[4, 12, 20].map((cy) => [4, 12, 20].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />))}
    </svg>
  );
}

function kebabToPascal(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function getLucideIcon(name: string): ComponentType<{ className?: string; style?: React.CSSProperties }> | undefined {
  const icon = (LucideIcons as Record<string, unknown>)[kebabToPascal(name)];
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in (icon as Record<string, unknown>))) {
    return icon as ComponentType<{ className?: string; style?: React.CSSProperties }>;
  }
  return undefined;
}

function AppIcon({ icon, customIconUrl, name, size = 40 }: { icon: string | null; customIconUrl: string | null; name: string; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const displayIcon = customIconUrl ?? icon;
  if (displayIcon && displayIcon.startsWith("emoji:")) {
    return <span className="leading-none" style={{ fontSize: size * 0.5 }}>{displayIcon.slice(6)}</span>;
  }
  if (displayIcon && !imgError && (displayIcon.startsWith("http") || displayIcon.startsWith("/") || displayIcon.startsWith("data:"))) {
    return <img src={displayIcon} alt={name} draggable={false} className="rounded-xl object-cover" style={{ width: size, height: size }} onError={() => setImgError(true)} />;
  }
  if (displayIcon && !imgError) {
    const IconComponent = getLucideIcon(displayIcon);
    if (IconComponent) return <IconComponent className="text-foreground/80" style={{ width: size * 0.5, height: size * 0.5 }} />;
  }
  return <span className="text-foreground/80">{name.charAt(0).toUpperCase()}</span>;
}

function isAppUp(status: string | null): boolean {
  return status !== "unhealthy";
}

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
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslations("appDrawer");

  const active = embedded || open;

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (!res.ok) return;
      const data = await res.json();
      setAllApps(data.apps ?? []);
    } catch { /* silent */ }
  }, []);

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer/prefs");
      if (!res.ok) return;
      const data = await res.json();
      setPrefs({ columns: data.columns ?? DEFAULT_PREFS.columns, iconScale: data.iconScale ?? DEFAULT_PREFS.iconScale, maxHeight: data.maxHeight ?? DEFAULT_PREFS.maxHeight });
    } catch { /* defaults */ } finally { setPrefsLoaded(true); }
  }, []);

  useEffect(() => {
    if (active) { fetchApps(); if (!prefsLoaded) fetchPrefs(); }
  }, [active, fetchApps, fetchPrefs, prefsLoaded]);

  const persistPrefs = useCallback((newPrefs: DrawerPrefs) => {
    setPrefs(newPrefs);
    if (savePrefsTimeout.current) clearTimeout(savePrefsTimeout.current);
    savePrefsTimeout.current = setTimeout(() => {
      fetch("/api/v1/apps/drawer/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newPrefs) }).catch(() => {});
    }, 500);
  }, []);

  const setPinned = useCallback(async (appId: string, pinned: boolean) => {
    setAllApps((prev) => prev.map((a) => (a.id === appId ? { ...a, visible: pinned, pinned } : a)));
    try {
      await fetch(`/api/v1/apps/drawer/${appId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible: pinned }) });
    } catch {
      setAllApps((prev) => prev.map((a) => (a.id === appId ? { ...a, visible: !pinned, pinned: !pinned } : a)));
    }
  }, []);

  // In the /embed/drawer iframe (native apps), navigate the TOP window so apps
  // open as the real page — not inside the little drawer popover iframe.
  const go = useCallback((url: string) => {
    if (embedded && typeof window !== "undefined" && window.top) window.top.location.href = url;
    else window.location.href = url;
  }, [embedded]);

  const handleAppClick = (app: DrawerApp) => {
    if (editMode || !app.url) return;
    try { navigator.sendBeacon("/api/v1/telemetry/record", JSON.stringify({ events: [{ type: "app_launch", key: app.id || app.name }] })); } catch { /* best-effort */ }
    go(app.url);
    setOpen(false);
  };

  // ── Derived lists ──
  const pinnedApps = useMemo(
    () => [...allApps].filter((a) => a.visible).sort((a, b) => {
      const ao = a.order ?? 999, bo = b.order ?? 999;
      return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
    }),
    [allApps]
  );
  const unpinnedApps = useMemo(() => [...allApps].filter((a) => !a.visible).sort((a, b) => a.name.localeCompare(b.name)), [allApps]);

  const q = query.trim().toLowerCase();
  const gridApps = useMemo(
    () => (q ? [...allApps].filter((a) => a.url && a.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)) : pinnedApps),
    [q, allApps, pinnedApps]
  );
  const aq = addQuery.trim().toLowerCase();
  const addCandidates = useMemo(() => (aq ? unpinnedApps.filter((a) => a.name.toLowerCase().includes(aq)) : unpinnedApps), [aq, unpinnedApps]);

  // ── Live reorder (pointer drag) ──
  const reorderPinned = useCallback((draggedId: string, toIndex: number) => {
    setAllApps((prev) => {
      const pinned = prev.filter((a) => a.visible).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      const ids = pinned.map((a) => a.id);
      const from = ids.indexOf(draggedId);
      if (from < 0 || from === toIndex) return prev;
      ids.splice(from, 1);
      ids.splice(toIndex, 0, draggedId);
      const orderMap = new Map(ids.map((id, i) => [id, i] as const));
      return prev.map((a) => (orderMap.has(a.id) ? { ...a, order: orderMap.get(a.id)! } : a));
    });
  }, []);

  const persistOrder = useCallback(() => {
    const pinned = [...allApps].filter((a) => a.visible).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    pinned.forEach((a, i) => {
      fetch(`/api/v1/apps/drawer/${a.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: i }) }).catch(() => {});
    });
  }, [allApps]);

  const drag = useGridDrag({
    order: pinnedApps.map((a) => a.id),
    enabled: editMode && !q,
    onReorder: reorderPinned,
    onCommit: persistOrder,
  });

  const cols = prefs.columns;
  const iconPx = 40 * prefs.iconScale;
  const draggedApp = drag.draggingId ? allApps.find((a) => a.id === drag.draggingId) : null;

  const renderTile = (app: DrawerApp, mode: "open" | "edit" | "add") => {
    const up = isAppUp(app.status);
    const dragging = drag.draggingId === app.id;
    return (
      <div
        key={app.id}
        ref={mode === "edit" ? drag.register(app.id) : undefined}
        className={`relative flex flex-col items-center rounded-xl p-2 transition-[transform,opacity] duration-150 ${
          mode === "edit" ? "cursor-grab touch-none select-none active:cursor-grabbing hover:bg-accent/40" : "cursor-pointer hover:scale-105 hover:bg-accent/40"
        }${up ? "" : " opacity-40 grayscale"}${dragging ? " scale-95 opacity-30" : ""}`}
        onPointerDown={mode === "edit" ? (e) => drag.startDrag(e, app.id) : undefined}
        onMouseDown={mode === "edit" ? (e) => drag.startDrag(e, app.id) : undefined}
        onClick={
          mode === "open"
            ? () => { if (!drag.consumeClick()) handleAppClick(app); }
            : mode === "add"
              ? () => setPinned(app.id, true)
              : (e) => { e.stopPropagation(); }
        }
        title={app.name}
      >
        {mode === "edit" && (
          <button
            type="button"
            aria-label={t("removeApp")}
            title={t("removeApp")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setPinned(app.id, false); }}
            className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-danger"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {mode === "add" && (
          <span className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm"><Plus className="h-3 w-3" /></span>
        )}
        <div className="flex items-center justify-center overflow-hidden rounded-xl" style={{ width: iconPx, height: iconPx }}>
          <AppIcon icon={app.icon} customIconUrl={app.custom_icon_url} name={app.name} size={iconPx} />
        </div>
        <span className="mt-1.5 line-clamp-1 w-full text-center text-[11px] leading-tight text-foreground/80">{app.name}</span>
      </div>
    );
  };

  const content = (
    <div className={`flex flex-col ${embedded ? "w-full" : ""}`}>
      {/* Top bar: search + edit toggle */}
      <div className="flex items-center gap-2 p-3 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchApps")} className="h-9 w-full rounded-full border bg-card/60 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <Button variant={editMode ? "default" : "ghost"} size="icon" className="h-9 w-9 shrink-0" onClick={() => { setEditMode((v) => !v); setAddMode(false); setQuery(""); }} title={editMode ? t("doneEditing") : t("manageApps")} aria-label={editMode ? t("doneEditing") : t("manageApps")}>
          {editMode ? <Check className="h-4 w-4" /> : <Pencil className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <ScrollArea style={{ maxHeight: editMode ? (embedded ? 360 : "calc(100vh - 260px)") : prefs.maxHeight }}>
        <div className="px-3 pb-2">
          {gridApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="mb-3 text-sm text-muted-foreground">{q ? t("noMatchingApps") : t("noAppsInstalled")}</p>
              {!q && isAdmin && <Link href="/market" target={embedded ? "_top" : undefined} className="text-sm text-primary hover:underline" onClick={() => setOpen(false)}>{t("visitMarketplace")}</Link>}
            </div>
          ) : (
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
              {gridApps.map((app) => renderTile(app, editMode ? "edit" : "open"))}
            </div>
          )}

          {editMode && (
            <div className="mt-2 rounded-xl border border-dashed border-border/70">
              {!addMode ? (
                <button type="button" onClick={() => setAddMode(true)} className="flex w-full items-center justify-center gap-2 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"><Plus className="h-4 w-4" /> {t("addApp")}</button>
              ) : (
                <div className="p-2">
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                    <input autoFocus value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder={t("searchApps")} className="h-8 w-full rounded-full border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  </div>
                  {addCandidates.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">{t("noAppsToAdd")}</p>
                  ) : (
                    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                      {addCandidates.map((app) => renderTile(app, "add"))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {editMode && !embedded && (
        <div className="space-y-2 border-t px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Columns</span>
            <div className="flex items-center gap-1">
              {[3, 4, 5].map((n) => (
                <button key={n} className={`h-6 w-6 rounded text-xs font-medium transition-colors ${prefs.columns === n ? "bg-primary text-primary-foreground" : "bg-accent/60 text-foreground/60 hover:bg-accent"}`} onClick={() => persistPrefs({ ...prefs, columns: n })}>{n}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Icon size</span>
            <input type="range" min="0.7" max="1.5" step="0.1" value={prefs.iconScale} onChange={(e) => persistPrefs({ ...prefs, iconScale: parseFloat(e.target.value) })} className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
          </div>
        </div>
      )}

      {onOpenLauncher && (
        <div className="border-t p-2">
          <button type="button" onClick={() => { onOpenLauncher(); setOpen(false); }} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><LayoutGrid className="h-4 w-4" /> {t("allApps")}</button>
        </div>
      )}
    </div>
  );

  // Lifted ghost following the cursor (portaled to body to escape the
  // popover's backdrop-filter containing block).
  const ghost = drag.ghost && draggedApp && typeof document !== "undefined"
    ? createPortal(
        <div className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-1/2 opacity-90" style={{ left: drag.ghost.x, top: drag.ghost.y }}>
          <div className="grid place-items-center overflow-hidden rounded-xl border bg-card shadow-2xl" style={{ width: iconPx, height: iconPx }}>
            <AppIcon icon={draggedApp.icon} customIconUrl={draggedApp.custom_icon_url} name={draggedApp.name} size={iconPx} />
          </div>
        </div>,
        document.body
      )
    : null;

  if (embedded) return <div className="w-full bg-transparent">{content}{ghost}</div>;

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditMode(false); setAddMode(false); setQuery(""); } }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("title")}><DotsIcon className="h-5 w-5" /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] rounded-2xl border-border/60 bg-popover/80 p-0 backdrop-blur-xl" onInteractOutside={(e) => { if (editMode) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (editMode) { e.preventDefault(); setEditMode(false); } }}>
        {content}
      </PopoverContent>
      {ghost}
    </Popover>
  );
}
