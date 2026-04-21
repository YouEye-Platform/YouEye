/**
 * App Drawer — Google-style Popover with expandable edit mode
 *
 * Normal: compact dropdown from the 9-dot grid button.
 * Edit: expands to near-full-height with hidden apps panel on the left,
 *       drag-and-drop reordering, and layout controls at the bottom.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  Plus,
  GripVertical,
  EyeOff,
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
  className = "w-10 h-10",
}: {
  icon: string | null;
  customIconUrl: string | null;
  name: string;
  className?: string;
}) {
  if (customIconUrl) {
    return (
      <img
        src={customIconUrl}
        alt={name}
        className={`${className} rounded-xl object-cover`}
      />
    );
  }
  if (icon && icon.startsWith("emoji:")) {
    return <span className="text-xl leading-none">{icon.slice(6)}</span>;
  }
  if (icon && (icon.startsWith("http") || icon.startsWith("/"))) {
    return (
      <img
        src={icon}
        alt={name}
        className={`${className} rounded-xl object-cover`}
      />
    );
  }
  if (icon) {
    const key = toKebabCase(icon);
    const IconComponent = ICON_MAP[key];
    if (IconComponent) {
      return <IconComponent className="h-5 w-5 text-foreground/80" />;
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
  const savePrefsTimeout = useRef<NodeJS.Timeout | null>(null);
  const t = useTranslations("appDrawer");

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

        // Remove dragged, insert at target position
        const [dragged] = visible.splice(dragIdx, 1);
        visible.splice(targetIdx, 0, dragged);

        // Reassign orders
        const orderMap = new Map<string, number>();
        visible.forEach((a, i) => orderMap.set(a.id, i));

        // Persist order changes
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

  const handleAppClick = (app: DrawerApp) => {
    if (editMode) return;
    if (app.url) {
      window.location.href = app.url;
      setOpen(false);
    }
  };

  // Drag handlers
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
  };

  const handleDropOnApp = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (draggedAppId && draggedAppId !== targetId) {
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
        className={
          editMode
            ? "w-[520px] rounded-xl p-0 origin-top-right transition-all duration-200"
            : "w-[340px] rounded-xl p-0 origin-top-right transition-all duration-200"
        }
        style={editMode ? { maxHeight: "calc(100vh - 80px)" } : undefined}
      >
        {editMode ? (
          <EditModeView
            visibleApps={visibleApps}
            hiddenApps={hiddenApps}
            prefs={prefs}
            onPrefsChange={persistPrefs}
            onDone={() => setEditMode(false)}
            onToggleVisibility={toggleVisibility}
            draggedAppId={draggedAppId}
            dragOverTarget={dragOverTarget}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOverApp={handleDragOverApp}
            onDropOnApp={handleDropOnApp}
            onDropOnHidden={handleDropOnHidden}
            onDropOnVisible={handleDropOnVisible}
            t={t}
          />
        ) : (
          <NormalModeView
            apps={visibleApps}
            columns={prefs.columns}
            maxHeight={prefs.maxHeight}
            isAdmin={isAdmin}
            onAppClick={handleAppClick}
            onClose={() => setOpen(false)}
            onEdit={() => setEditMode(true)}
            t={t}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ────────────────────────────────────────
// Normal Mode
// ────────────────────────────────────────

function NormalModeView({
  apps,
  columns,
  maxHeight,
  isAdmin,
  onAppClick,
  onClose,
  onEdit,
  t,
}: {
  apps: DrawerApp[];
  columns: number;
  maxHeight: number;
  isAdmin: boolean;
  onAppClick: (app: DrawerApp) => void;
  onClose: () => void;
  onEdit: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      {/* Pencil icon — top left */}
      <div className="absolute top-2 left-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
          onClick={onEdit}
          title="Edit drawer"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea style={{ maxHeight }}>
        <div className="p-3 pt-2">
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
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
          ) : (
            <div
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
              }}
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
                    <div className="w-10 h-10 rounded-xl bg-accent/80 flex items-center justify-center text-base font-medium shadow-sm overflow-hidden transition-transform duration-150">
                      <AppIcon
                        icon={app.icon}
                        customIconUrl={app.custom_icon_url}
                        name={app.name}
                      />
                    </div>
                    <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                      {app.name}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

// ────────────────────────────────────────
// Edit Mode — two-panel with drag-and-drop
// ────────────────────────────────────────

function EditModeView({
  visibleApps,
  hiddenApps,
  prefs,
  onPrefsChange,
  onDone,
  onToggleVisibility,
  draggedAppId,
  dragOverTarget,
  onDragStart,
  onDragEnd,
  onDragOverApp,
  onDropOnApp,
  onDropOnHidden,
  onDropOnVisible,
  t,
}: {
  visibleApps: DrawerApp[];
  hiddenApps: DrawerApp[];
  prefs: DrawerPrefs;
  onPrefsChange: (p: DrawerPrefs) => void;
  onDone: () => void;
  onToggleVisibility: (id: string, visible: boolean) => void;
  draggedAppId: string | null;
  dragOverTarget: string | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  onDragOverApp: (e: React.DragEvent, id: string) => void;
  onDropOnApp: (e: React.DragEvent, id: string) => void;
  onDropOnHidden: (e: React.DragEvent) => void;
  onDropOnVisible: (e: React.DragEvent) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-col p-4 gap-4" style={{ maxHeight: "calc(100vh - 100px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <span className="text-sm font-semibold">{t("title")}</span>
        <Button
          variant="default"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onDone}
        >
          <Check className="h-3.5 w-3.5" />
          {t("doneEditing")}
        </Button>
      </div>

      {/* Two-panel body — each panel in its own distinct card */}
      <div className="flex flex-1 min-h-0 gap-3">
        {/* Left card — hidden apps */}
        <div
          className={`w-[155px] rounded-xl border bg-card shadow-sm flex flex-col shrink-0 transition-all overflow-hidden ${
            draggedAppId
              ? "border-primary/40 bg-primary/5 border-dashed shadow-md"
              : "border-border"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDropOnHidden}
        >
          <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-border/50">
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              Hidden ({hiddenApps.length})
            </span>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              {hiddenApps.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/50 text-center py-6 px-2">
                  Drag apps here to hide
                </div>
              ) : (
                hiddenApps.map((app) => (
                  <div
                    key={app.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-grab transition-all hover:bg-accent/40 opacity-60 ${
                      draggedAppId === app.id ? "opacity-30 scale-95" : ""
                    }`}
                    draggable
                    onDragStart={(e) => onDragStart(e, app.id)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="w-6 h-6 rounded-md bg-accent/60 flex items-center justify-center overflow-hidden shrink-0">
                      <AppIcon
                        icon={app.icon}
                        customIconUrl={app.custom_icon_url}
                        name={app.name}
                        className="w-4 h-4"
                      />
                    </div>
                    <span className="text-[11px] truncate flex-1">
                      {app.name}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleVisibility(app.id, true);
                      }}
                      title="Show in drawer"
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right card — visible apps grid */}
        <div
          className={`flex-1 rounded-xl border bg-card shadow-sm flex flex-col min-h-0 overflow-hidden ${
            draggedAppId && !visibleApps.find((a) => a.id === draggedAppId)
              ? "border-primary/40 bg-primary/5 shadow-md"
              : "border-border"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDropOnVisible}
        >
          <ScrollArea className="flex-1">
            <div
              className="grid gap-1 p-3"
              style={{
                gridTemplateColumns: `repeat(${prefs.columns}, 1fr)`,
              }}
            >
              {visibleApps.map((app) => {
                const up = isAppUp(app.status);
                const isDragging = draggedAppId === app.id;
                const isDragOver = dragOverTarget === app.id;
                return (
                  <div
                    key={app.id}
                    className={`relative flex flex-col items-center p-2 rounded-xl cursor-grab transition-all duration-150 ${
                      isDragging
                        ? "opacity-30 scale-90"
                        : isDragOver
                          ? "bg-primary/10 ring-2 ring-primary/30 scale-105"
                          : "hover:bg-accent/60"
                    }${up ? "" : " opacity-40 grayscale"}`}
                    draggable
                    onDragStart={(e) => onDragStart(e, app.id)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => onDragOverApp(e, app.id)}
                    onDrop={(e) => onDropOnApp(e, app.id)}
                    title={app.name}
                  >
                    <GripVertical className="absolute top-0.5 right-0.5 h-3 w-3 text-muted-foreground/30" />
                    <div className="w-10 h-10 rounded-xl bg-accent/80 flex items-center justify-center text-base font-medium shadow-sm overflow-hidden">
                      <AppIcon
                        icon={app.icon}
                        customIconUrl={app.custom_icon_url}
                        name={app.name}
                      />
                    </div>
                    <span className="text-[11px] text-center line-clamp-1 w-full mt-1.5 text-foreground/80 leading-tight">
                      {app.name}
                    </span>
                  </div>
                );
              })}
              {visibleApps.length === 0 && (
                <div className="col-span-full text-xs text-muted-foreground text-center py-8">
                  Drag apps here to show
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Controls card */}
      <DrawerControls prefs={prefs} onPrefsChange={onPrefsChange} />
    </div>
  );
}

// ────────────────────────────────────────
// Controls Footer (edit mode only)
// ────────────────────────────────────────

function DrawerControls({
  prefs,
  onPrefsChange,
}: {
  prefs: DrawerPrefs;
  onPrefsChange: (p: DrawerPrefs) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm px-3 py-2.5 space-y-2 shrink-0">
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
          min="0.7"
          max="1.5"
          step="0.1"
          value={prefs.iconScale}
          onChange={(e) =>
            onPrefsChange({ ...prefs, iconScale: parseFloat(e.target.value) })
          }
          className="w-24 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
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
            onPrefsChange({
              ...prefs,
              maxHeight: parseInt(e.target.value, 10),
            })
          }
          className="w-24 h-1.5 appearance-none bg-accent rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>
    </div>
  );
}
