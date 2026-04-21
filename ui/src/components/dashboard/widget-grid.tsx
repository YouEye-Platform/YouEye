/**
 * Widget Grid
 *
 * Main dashboard layout that renders user widgets with absolute positioning.
 * Provides edit mode with drag/drop, resize, add/remove widgets,
 * background customization, and auto-save of layout changes.
 *
 * Widget positions are stored as percentages (0-100) and converted to
 * pixels at render time, making layouts resolution-independent.
 */

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Paintbrush, Plus, RotateCcw, Check, Settings2, User, Search, Clock, List, Package, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { WidgetContainer, type WidgetPosition } from "./widget-container";
import {
  HomepageBackground,
  DEFAULT_BACKGROUND,
  type BackgroundConfig,
} from "@/components/backgrounds/homepage-background";
import { BackgroundSettingsDialog } from "@/components/backgrounds/background-settings-dialog";
import { WIDGET_REGISTRY, WIDGET_CATALOG, getWidgetMeta } from "@/components/widgets";
import { WidgetSettingsDialog } from "./widget-settings-dialog";
import { AddWidgetDialog } from "./add-widget-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";

export interface WidgetData {
  id: string;
  widgetType: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  order: number;
  settings: Record<string, unknown>;
}

interface WidgetGridProps {
  widgets: WidgetData[];
  username: string;
  initialBackground?: BackgroundConfig;
}

/** Icon to show in the add-widget menu thumbnail for each built-in widget type */
const WIDGET_PREVIEW_ICONS: Record<string, LucideIcon> = {
  "server-name": Type,
  greeting: User,
  search: Search,
  clock: Clock,
  "timeline-preview": List,
};

/** Default layout for the reset button */
const DEFAULT_WIDGETS: Omit<WidgetData, "id">[] = [
  { widgetType: "server-name", positionX: 20, positionY: 18, width: 57, height: 13, settings: {}, order: 0 },
  { widgetType: "search", positionX: 30, positionY: 40, width: 40, height: 10, settings: {}, order: 1 },
  { widgetType: "clock", positionX: 80, positionY: 5, width: 14, height: 10, settings: {}, order: 2 },
];

export interface AppWidgetDef {
  id: string;
  widget_id: string;
  name: string;
  description: string;
  default_size: { width: number; height: number };
  app_id: string;
  app_name: string;
}

export function WidgetGrid({ widgets, username, initialBackground }: WidgetGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [isEditMode, setIsEditMode] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showBgSettings, setShowBgSettings] = useState(false);
  const [bgConfig, setBgConfig] = useState<BackgroundConfig>(
    initialBackground ?? DEFAULT_BACKGROUND
  );
  const [settingsWidget, setSettingsWidget] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [appWidgets, setAppWidgets] = useState<AppWidgetDef[]>([]);
  const t = useTranslations('widgetGrid');

  // Fetch app-provided widgets when entering edit mode
  useEffect(() => {
    if (!isEditMode) return;
    fetch("/api/v1/apps/widgets")
      .then((r) => r.json())
      .then((data) => setAppWidgets(data.widgets ?? []))
      .catch(() => setAppWidgets([]));
  }, [isEditMode]);

  // Local widget state (editable)
  const [localWidgets, setLocalWidgets] = useState<WidgetData[]>(() =>
    widgets.map((w) => {
      if (w.widgetType === "greeting") {
        return { ...w, settings: { ...w.settings, name: username } };
      }
      return w;
    })
  );

  // Track container size for percent<->pixel conversion
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Auto-save widgets after changes (debounced)
  const saveWidgets = useCallback((widgetData: WidgetData[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch("/api/v1/widgets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            widgets: widgetData.map((w) => ({
              widgetType: w.widgetType,
              positionX: w.positionX,
              positionY: w.positionY,
              width: w.width,
              height: w.height,
              settings: w.widgetType === "greeting"
                ? (({ name: _n, ...rest }) => rest)(w.settings as Record<string, unknown> & { name?: unknown })
                : w.settings,
              order: w.order,
            })),
          }),
        });
      } catch (err) {
        console.error("Failed to save widgets:", err);
      }
    }, 800);
  }, []);

  // Auto-save background after changes
  const saveBgConfig = useCallback((config: BackgroundConfig) => {
    setBgConfig(config);
    fetch("/api/v1/settings/background", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).catch((err) => console.error("Failed to save background:", err));
  }, []);

  // Widget manipulation callbacks
  const handlePositionChange = useCallback(
    (id: string, x: number, y: number) => {
      setLocalWidgets((prev) => {
        const next = prev.map((w) =>
          w.id === id ? { ...w, positionX: x, positionY: y } : w
        );
        saveWidgets(next);
        return next;
      });
    },
    [saveWidgets]
  );

  const handleSizeChange = useCallback(
    (id: string, width: number, height: number) => {
      setLocalWidgets((prev) => {
        const next = prev.map((w) =>
          w.id === id ? { ...w, width, height } : w
        );
        saveWidgets(next);
        return next;
      });
    },
    [saveWidgets]
  );

  const handleRemove = useCallback(
    (id: string) => {
      setLocalWidgets((prev) => {
        const next = prev.filter((w) => w.id !== id);
        saveWidgets(next);
        return next;
      });
    },
    [saveWidgets]
  );

  const handleAddWidget = useCallback(
    (widgetType: string, appWidgetDef?: AppWidgetDef) => {
      setShowAddMenu(false);
      const meta = getWidgetMeta(widgetType);
      const defaultW = appWidgetDef?.default_size?.width
        ? Math.min(appWidgetDef.default_size.width * 8, 40)
        : (meta?.defaultSize.width ?? 25);
      const defaultH = appWidgetDef?.default_size?.height
        ? Math.min(appWidgetDef.default_size.height * 8, 30)
        : (meta?.defaultSize.height ?? 12);
      const settings: Record<string, unknown> = widgetType === "greeting"
        ? { name: username }
        : widgetType === "app-widget" && appWidgetDef
          ? { appId: appWidgetDef.app_id, widgetId: appWidgetDef.widget_id }
          : {};
      const newWidget: WidgetData = {
        id: `temp-${Date.now()}`,
        widgetType,
        positionX: 35 + Math.random() * 10,
        positionY: 35 + Math.random() * 10,
        width: defaultW,
        height: defaultH,
        order: localWidgets.length,
        settings,
      };
      setLocalWidgets((prev) => {
        const next = [...prev, newWidget];
        saveWidgets(next);
        return next;
      });
    },
    [localWidgets.length, username, saveWidgets]
  );

  const handleReset = useCallback(() => {
    const resetWidgets: WidgetData[] = DEFAULT_WIDGETS.map((w, i) => ({
      ...w,
      id: `reset-${Date.now()}-${i}`,
      settings: w.widgetType === "greeting" ? { ...w.settings, name: username } : w.settings,
    }));
    setLocalWidgets(resetWidgets);
    saveWidgets(resetWidgets);
  }, [username, saveWidgets]);

  const handleSettingsChange = useCallback(
    (newSettings: Record<string, unknown>) => {
      if (!settingsWidget) return;
      setLocalWidgets((prev) => {
        const next = prev.map((w) =>
          w.id === settingsWidget
            ? { ...w, settings: { ...w.settings, ...newSettings } }
            : w
        );
        saveWidgets(next);
        return next;
      });
    },
    [settingsWidget, saveWidgets]
  );

  const settingsWidgetData = settingsWidget
    ? localWidgets.find((w) => w.id === settingsWidget)
    : null;

  // Available widgets for add menu
  const availableWidgets = Object.keys(WIDGET_REGISTRY);

  return (
    <div className="relative w-full h-full" ref={containerRef}>
      {/* Background layer */}
      <HomepageBackground config={bgConfig} />

      {/* Widgets layer */}
      <div className="absolute inset-0 z-10">
        {containerSize.width > 0 && localWidgets.length > 0 &&
          localWidgets.map((widget) => (
            <WidgetContainer
              key={widget.id}
              widget={widget}
              isEditMode={isEditMode}
              containerSize={containerSize}
              onPositionChange={handlePositionChange}
              onSizeChange={handleSizeChange}
              onRemove={handleRemove}
              onSettingsOpen={setSettingsWidget}
            />
          ))}

        {/* Empty dashboard state */}
        {containerSize.width > 0 && localWidgets.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="flex flex-col items-center gap-3 bg-card/60 backdrop-blur-xl rounded-2xl border border-border/40 px-10 py-8 shadow-lg">
              <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center">
                <Plus className="w-8 h-8 text-muted-foreground/60" />
              </div>
              <h3 className="text-lg font-medium text-foreground/80">{t("emptyTitle")}</h3>
              <p className="text-sm text-muted-foreground text-center max-w-[260px]">{t("emptyDescription")}</p>
              <Button
                size="sm"
                onClick={() => { setIsEditMode(true); setShowAddMenu(true); }}
                className="gap-1.5 mt-2"
              >
                <Plus className="h-4 w-4" />
                {t("addFirstWidget")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Edit mode controls — top-left under navbar */}
      <div className="absolute top-4 left-4 z-50">
        {isEditMode ? (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-card/90 backdrop-blur-xl rounded-xl border border-border/50 shadow-lg">
            {/* Add widget */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAddMenu(true)}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              {t('add')}
            </Button>

            {/* Background settings */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowBgSettings(true)}
              className="gap-1.5"
            >
              <Settings2 className="h-4 w-4" />
              {t('background')}
            </Button>

            {/* Reset */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <RotateCcw className="h-4 w-4" />
              {t('reset')}
            </Button>

            <Separator orientation="vertical" className="h-5" />

            {/* Done */}
            <Button
              size="sm"
              onClick={() => { setIsEditMode(false); setShowAddMenu(false); }}
              className="gap-1.5"
            >
              <Check className="h-4 w-4" />
              {t('done')}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="icon"
            className="h-9 w-9 rounded-full bg-card/80 backdrop-blur-xl border border-border/50 shadow-lg hover:bg-card"
            onClick={() => setIsEditMode(true)}
            title={t('editLayout')}
          >
            <Paintbrush className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Background settings dialog */}
      <BackgroundSettingsDialog
        open={showBgSettings}
        onOpenChange={setShowBgSettings}
        config={bgConfig}
        onConfigChange={saveBgConfig}
      />

      {/* Widget settings dialog */}
      {settingsWidgetData && (
        <WidgetSettingsDialog
          open={!!settingsWidget}
          onOpenChange={(open) => { if (!open) setSettingsWidget(null); }}
          widgetType={settingsWidgetData.widgetType}
          currentSettings={settingsWidgetData.settings}
          onSave={handleSettingsChange}
        />
      )}

      {/* Add widget dialog */}
      <AddWidgetDialog
        open={showAddMenu}
        onClose={() => setShowAddMenu(false)}
        builtInWidgets={WIDGET_CATALOG.filter((w) => w.category === "built-in")}
        appWidgets={appWidgets}
        onAddBuiltIn={(widgetType) => handleAddWidget(widgetType)}
        onAddAppWidget={(aw) => handleAddWidget("app-widget", aw)}
      />
    </div>
  );
}
