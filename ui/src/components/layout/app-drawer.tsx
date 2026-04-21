/**
 * App Drawer — Sheet-based panel with edit mode
 *
 * Opens as a right-side sheet from the 9-dot grid button.
 * Normal mode: grid of visible apps with configurable columns/scale.
 * Edit mode: two-panel layout for dragging apps in/out of the drawer.
 * Drawer preferences (columns, icon scale, max height) persist per-user.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Settings,
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
  Minus,
  Plus,
  GripVertical,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { ComponentType } from "react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  columns: 3,
  iconScale: 1,
  maxHeight: 400,
};

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
};

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
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
  const imgClass = `rounded-xl object-cover`;
  const imgStyle = { width: size, height: size };
  const iconInner = Math.round(size * 0.5);

  if (customIconUrl) {
    return <img src={customIconUrl} alt={name} className={imgClass} style={imgStyle} />;
  }
  if (icon && icon.startsWith("emoji:")) {
    return <span style={{ fontSize: iconInner }} className="leading-none">{icon.slice(6)}</span>;
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return <img src={icon} alt={name} className={imgClass} style={imgStyle} />;
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
    if (IconComponent) {
      return <IconComponent className="text-foreground/80" style={{ width: iconInner, height: iconInner }} />;
    }
  }
  return (
    <span className="text-foreground/80 font-medium" style={{ fontSize: iconInner * 0.8 }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function isAppUp(status: string | null): boolean {
  return status !== "unhealthy";
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
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslations("appDrawer");

  // Fetch apps (all, including hidden)
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

  // Fetch drawer prefs
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

  // Save prefs with debounce
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

  // Toggle app visibility
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
        // Revert on error
        setAllApps((prev) =>
          prev.map((a) => (a.id === appId ? { ...a, visible: !visible } : a))
        );
      }
    },
    []
  );

  // Move app up/down in order
  const moveApp = useCallback(
    async (appId: string, direction: "up" | "down") => {
      setAllApps((prev) => {
        const visibleApps = [...prev]
          .filter((a) => a.visible)
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

        const idx = visibleApps.findIndex((a) => a.id === appId);
        if (idx < 0) return prev;
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= visibleApps.length) return prev;

        const thisApp = visibleApps[idx];
        const swapApp = visibleApps[swapIdx];
        const thisOrder = thisApp.order;
        const swapOrder = swapApp.order;

        // Persist both order changes
        fetch(`/api/v1/apps/drawer/${thisApp.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: swapOrder }),
        }).catch(() => {});
        fetch(`/api/v1/apps/drawer/${swapApp.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: thisOrder }),
        }).catch(() => {});

        return prev.map((a) => {
          if (a.id === thisApp.id) return { ...a, order: swapOrder };
          if (a.id === swapApp.id) return { ...a, order: thisOrder };
          return a;
        });
      });
    },
    []
  );

  const handleAppClick = (app: DrawerApp) => {
    if (editMode) return;
    if (app.url) {
      window.location.href = app.url;
      setOpen(false);
    }
  };

  // Sorted app lists
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

  // Icon sizing based on scale
  const baseIconSize = 48;
  const iconSize = Math.round(baseIconSize * prefs.iconScale);
  const containerSize = iconSize + 16;

  return (
    <>
      {/* Trigger button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label={t("title")}
        onClick={() => setOpen(true)}
      >
        <DotsIcon className="h-5 w-5" />
      </Button>

      {/* Sheet panel */}
      <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditMode(false); }}>
        <SheetContent
          side="right"
          showCloseButton={!editMode}
          className="w-[380px] sm:max-w-[420px] flex flex-col p-0"
        >
          {/* Header */}
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border/40">
            <div className="flex items-center justify-between">
              <SheetTitle className="text-base">{t("title")}</SheetTitle>
              <Button
                variant={editMode ? "default" : "ghost"}
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => setEditMode(!editMode)}
              >
                {editMode ? (
                  <><Check className="h-3.5 w-3.5" />{t("doneEditing")}</>
                ) : (
                  <><Pencil className="h-3.5 w-3.5" />Edit</>
                )}
              </Button>
            </div>
            <SheetDescription className="sr-only">
              {t("description")}
            </SheetDescription>
          </SheetHeader>

          {/* Main content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {editMode ? (
              <EditModeContent
                visibleApps={visibleApps}
                hiddenApps={hiddenApps}
                iconSize={iconSize}
                containerSize={containerSize}
                columns={prefs.columns}
                onToggleVisibility={toggleVisibility}
                onMoveApp={moveApp}
              />
            ) : (
              <NormalModeContent
                apps={visibleApps}
                iconSize={iconSize}
                containerSize={containerSize}
                columns={prefs.columns}
                maxHeight={prefs.maxHeight}
                isAdmin={isAdmin}
                onAppClick={handleAppClick}
                onClose={() => setOpen(false)}
                t={t}
              />
            )}
          </div>

          {/* Controls footer — visible in edit mode */}
          {editMode && (
            <DrawerControls prefs={prefs} onPrefsChange={persistPrefs} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

// ────────────────────────────────────────
// Normal Mode
// ────────────────────────────────────────

function NormalModeContent({
  apps,
  iconSize,
  containerSize,
  columns,
  maxHeight,
  isAdmin,
  onAppClick,
  onClose,
  t,
}: {
  apps: DrawerApp[];
  iconSize: number;
  containerSize: number;
  columns: number;
  maxHeight: number;
  isAdmin: boolean;
  onAppClick: (app: DrawerApp) => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-4">
        <p className="text-sm text-muted-foreground mb-3">
          {t("noAppsInstalled")}
        </p>
        {isAdmin && (
          <Link
            href="/app-market"
            className="text-sm text-primary hover:underline"
            onClick={onClose}
          >
            {t("visitMarketplace")}
          </Link>
        )}
      </div>
    );
  }

  return (
    <ScrollArea style={{ maxHeight }} className="flex-1">
      <div
        className="grid gap-1 p-3"
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      >
        {apps.map((app) => {
          const up = isAppUp(app.status);
          return (
            <div
              key={app.id}
              className={`relative flex flex-col items-center p-2 rounded-xl cursor-pointer transition-all duration-150 hover:bg-accent/60 hover:scale-105${up ? "" : " opacity-40 grayscale"}`}
              onClick={() => onAppClick(app)}
              title={up ? app.name : `${app.name} — offline`}
            >
              <div
                className="rounded-xl bg-accent/80 flex items-center justify-center font-medium shadow-sm overflow-hidden transition-transform duration-150"
                style={{ width: containerSize, height: containerSize }}
              >
                <AppIcon
                  icon={app.icon}
                  customIconUrl={app.custom_icon_url}
                  name={app.name}
                  size={iconSize}
                />
              </div>
              <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                {app.name}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ────────────────────────────────────────
// Edit Mode — two panels
// ────────────────────────────────────────

function EditModeContent({
  visibleApps,
  hiddenApps,
  iconSize,
  containerSize,
  columns,
  onToggleVisibility,
  onMoveApp,
}: {
  visibleApps: DrawerApp[];
  hiddenApps: DrawerApp[];
  iconSize: number;
  containerSize: number;
  columns: number;
  onToggleVisibility: (appId: string, visible: boolean) => void;
  onMoveApp: (appId: string, direction: "up" | "down") => void;
}) {
  return (
    <ScrollArea className="flex-1">
      <div className="p-3 space-y-4">
        {/* Visible apps section */}
        <div>
          <div className="flex items-center gap-2 mb-2 px-1">
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              In drawer ({visibleApps.length})
            </span>
          </div>
          {visibleApps.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border/60 rounded-lg">
              No apps in drawer
            </div>
          ) : (
            <div className="space-y-1">
              {visibleApps.map((app, idx) => (
                <EditAppRow
                  key={app.id}
                  app={app}
                  iconSize={Math.round(iconSize * 0.7)}
                  isFirst={idx === 0}
                  isLast={idx === visibleApps.length - 1}
                  onHide={() => onToggleVisibility(app.id, false)}
                  onMoveUp={() => onMoveApp(app.id, "up")}
                  onMoveDown={() => onMoveApp(app.id, "down")}
                />
              ))}
            </div>
          )}
        </div>

        {/* Hidden apps section */}
        {hiddenApps.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Hidden ({hiddenApps.length})
              </span>
            </div>
            <div className="space-y-1">
              {hiddenApps.map((app) => (
                <div
                  key={app.id}
                  className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-accent/40 transition-colors opacity-60"
                >
                  <div
                    className="rounded-lg bg-accent/60 flex items-center justify-center overflow-hidden shrink-0"
                    style={{ width: Math.round(iconSize * 0.7), height: Math.round(iconSize * 0.7) }}
                  >
                    <AppIcon
                      icon={app.icon}
                      customIconUrl={app.custom_icon_url}
                      name={app.name}
                      size={Math.round(iconSize * 0.5)}
                    />
                  </div>
                  <span className="text-sm flex-1 truncate">{app.name}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => onToggleVisibility(app.id, true)}
                    title="Show in drawer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function EditAppRow({
  app,
  iconSize,
  isFirst,
  isLast,
  onHide,
  onMoveUp,
  onMoveDown,
}: {
  app: DrawerApp;
  iconSize: number;
  isFirst: boolean;
  isLast: boolean;
  onHide: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const up = isAppUp(app.status);
  return (
    <div
      className={`flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-accent/40 transition-colors${up ? "" : " opacity-40 grayscale"}`}
    >
      <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
      <div
        className="rounded-lg bg-accent/80 flex items-center justify-center overflow-hidden shrink-0"
        style={{ width: iconSize, height: iconSize }}
      >
        <AppIcon
          icon={app.icon}
          customIconUrl={app.custom_icon_url}
          name={app.name}
          size={Math.round(iconSize * 0.75)}
        />
      </div>
      <span className="text-sm flex-1 truncate">{app.name}</span>
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isFirst}
          onClick={onMoveUp}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isLast}
          onClick={onMoveDown}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive hover:text-destructive"
          onClick={onHide}
          title="Hide from drawer"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Controls Footer
// ────────────────────────────────────────

function DrawerControls({
  prefs,
  onPrefsChange,
}: {
  prefs: DrawerPrefs;
  onPrefsChange: (p: DrawerPrefs) => void;
}) {
  return (
    <div className="border-t border-border/40 px-4 py-3 space-y-3 bg-muted/30">
      {/* Columns */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Columns</span>
        <div className="flex items-center gap-1">
          {[2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`w-7 h-7 rounded-md text-xs font-medium transition-colors ${
                prefs.columns === n
                  ? "bg-primary text-primary-foreground"
                  : "bg-accent/60 text-foreground/60 hover:bg-accent"
              }`}
              onClick={() => onPrefsChange({ ...prefs, columns: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Icon scale */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Icon size</span>
        <input
          type="range"
          min="0.6"
          max="1.8"
          step="0.1"
          value={prefs.iconScale}
          onChange={(e) =>
            onPrefsChange({ ...prefs, iconScale: parseFloat(e.target.value) })
          }
          className="w-28 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Max height */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Max height</span>
        <input
          type="range"
          min="200"
          max="700"
          step="50"
          value={prefs.maxHeight}
          onChange={(e) =>
            onPrefsChange({ ...prefs, maxHeight: parseInt(e.target.value, 10) })
          }
          className="w-28 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>
    </div>
  );
}
