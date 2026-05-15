/**
 * Add Widget Dialog — Tabbed view with live widget previews
 *
 * Tabs at top organized by source (Built-in, then each app).
 * Each tab shows a horizontal carousel of widgets with live preview
 * renders of the actual widget, name, and description.
 */

"use client";

import { useState, useEffect, useRef, type ComponentType } from "react";
import { X, ChevronLeft, ChevronRight, Plus, Package, Languages, CloudSun, Film, StickyNote, BookOpen, Search, Home } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { WIDGET_CATALOG, type WidgetMeta, type WidgetComponentProps } from "@/components/widgets";
import type { AppWidgetDef } from "./widget-grid";

interface AddWidgetDialogProps {
  open: boolean;
  onClose: () => void;
  builtInWidgets: WidgetMeta[];
  appWidgets: AppWidgetDef[];
  onAddBuiltIn: (widgetType: string) => void;
  onAddAppWidget: (def: AppWidgetDef) => void;
}

const APP_ICONS: Record<string, LucideIcon> = {
  "built-in": Home,
  "ye-weather": CloudSun,
  "ye-translate": Languages,
  "ye-cinema": Film,
  "ye-notes": StickyNote,
  "ye-wiki": BookOpen,
  "ye-search": Search,
};

interface TabDef {
  id: string;
  label: string;
  icon: LucideIcon;
  items: WidgetItem[];
}

interface WidgetItem {
  id: string;
  name: string;
  description: string;
  isAppWidget: boolean;
  appWidgetDef?: AppWidgetDef;
  builtInId?: string;
  /** Built-in widget component for live preview */
  component?: ComponentType<WidgetComponentProps>;
}

export function AddWidgetDialog({
  open,
  onClose,
  builtInWidgets,
  appWidgets,
  onAddBuiltIn,
  onAddAppWidget,
}: AddWidgetDialogProps) {
  const [activeTab, setActiveTab] = useState("built-in");
  const [appUrls, setAppUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) setActiveTab("built-in");
  }, [open]);

  // Fetch app URLs for iframe previews when dialog opens
  useEffect(() => {
    if (!open || appWidgets.length === 0) return;
    fetch("/api/v1/apps/drawer")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.apps) return;
        const urls: Record<string, string> = {};
        for (const app of data.apps) {
          if (app.id && app.url) urls[app.id] = app.url;
        }
        setAppUrls(urls);
      })
      .catch(() => {});
  }, [open, appWidgets.length]);

  if (!open) return null;

  // Build tabs
  const tabs: TabDef[] = [];

  // Built-in tab — attach actual component for live preview
  const builtInItems: WidgetItem[] = builtInWidgets.map((w) => {
    const catalogEntry = WIDGET_CATALOG.find((c) => c.id === w.id);
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      isAppWidget: false,
      builtInId: w.id,
      component: catalogEntry?.component,
    };
  });
  tabs.push({
    id: "built-in",
    label: "Built-in",
    icon: Home,
    items: builtInItems,
  });

  // Group app widgets by app
  const appGroups: Record<string, { appName: string; appId: string; widgets: AppWidgetDef[] }> = {};
  for (const aw of appWidgets) {
    if (!appGroups[aw.app_id]) {
      appGroups[aw.app_id] = { appName: aw.app_name, appId: aw.app_id, widgets: [] };
    }
    appGroups[aw.app_id].widgets.push(aw);
  }

  for (const group of Object.values(appGroups)) {
    const items: WidgetItem[] = group.widgets.map((aw) => ({
      id: `${aw.app_id}:${aw.id}`,
      name: aw.name,
      description: aw.description,
      isAppWidget: true,
      appWidgetDef: aw,
    }));
    tabs.push({
      id: group.appId,
      label: group.appName,
      icon: APP_ICONS[group.appId] ?? Package,
      items,
    });
  }

  const currentTab = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  function handleAdd(item: WidgetItem) {
    if (item.isAppWidget && item.appWidgetDef) {
      onAddAppWidget(item.appWidgetDef);
    } else if (item.builtInId) {
      onAddBuiltIn(item.builtInId);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative w-full max-w-3xl max-h-[85vh] bg-popover border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header with close */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-lg font-semibold">Add Widget</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 py-3 border-b overflow-x-auto shrink-0">
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                <TabIcon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Carousel content */}
        <div className="flex-1 min-h-0 px-6 py-6">
          {currentTab && <WidgetCarousel items={currentTab.items} onAdd={handleAdd} appUrls={appUrls} />}
        </div>
      </div>
    </div>
  );
}

function WidgetCarousel({ items, onAdd, appUrls }: { items: WidgetItem[]; onAdd: (item: WidgetItem) => void; appUrls: Record<string, string> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  function updateScrollState() {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, [items]);

  function scroll(dir: "left" | "right") {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.7;
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No widgets available in this category.
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {/* Left arrow */}
      {canScrollLeft && (
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-card/90 border shadow-lg flex items-center justify-center hover:bg-accent transition-colors -ml-2"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}

      {/* Right arrow */}
      {canScrollRight && (
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-card/90 border shadow-lg flex items-center justify-center hover:bg-accent transition-colors -mr-2"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}

      {/* Scrollable widget cards */}
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto h-full pb-2 scrollbar-hide"
        style={{ scrollSnapType: "x mandatory", scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {items.map((item) => (
          <WidgetPreviewCard key={item.id} item={item} onAdd={() => onAdd(item)} appUrls={appUrls} />
        ))}
      </div>
    </div>
  );
}

/** Virtual canvas dimensions for scaled-down built-in widget previews */
const VIRTUAL_W = 480;
const VIRTUAL_H = 280;
/** Visible preview area matches the card width (224px) and height (144px) */
const PREVIEW_W = 224;
const PREVIEW_H = 144;
const SCALE = PREVIEW_W / VIRTUAL_W;

function WidgetPreviewCard({ item, onAdd, appUrls }: { item: WidgetItem; onAdd: () => void; appUrls: Record<string, string> }) {
  const hasLivePreview = !!item.component || (item.isAppWidget && item.appWidgetDef);

  return (
    <div
      className="flex-shrink-0 w-56 flex flex-col rounded-xl border border-border/50 overflow-hidden hover:border-primary/40 transition-all group cursor-pointer"
      style={{ scrollSnapAlign: "start" }}
      onClick={onAdd}
    >
      {/* Live preview area */}
      <div className="relative overflow-hidden bg-background/30" style={{ height: `${PREVIEW_H}px` }}>
        {item.component ? (
          /* Built-in widget: render actual component scaled down */
          <div
            className="absolute top-0 left-0 pointer-events-none select-none"
            style={{
              width: `${VIRTUAL_W}px`,
              height: `${VIRTUAL_H}px`,
              transform: `scale(${SCALE})`,
              transformOrigin: "top left",
            }}
          >
            <div className="w-full h-full flex items-center justify-center">
              <item.component settings={{}} />
            </div>
          </div>
        ) : item.isAppWidget && item.appWidgetDef ? (
          /* App widget: render iframe embed preview */
          <AppWidgetPreview appId={item.appWidgetDef.app_id} widgetId={item.appWidgetDef.widget_id} appUrls={appUrls} />
        ) : (
          /* Fallback: generic icon */
          <div className="flex items-center justify-center h-full">
            <Package className="w-10 h-10 text-muted-foreground/40" />
          </div>
        )}

        {/* Add overlay on hover */}
        <div className="absolute inset-0 bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg">
            <Plus className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-3 flex-1 flex flex-col gap-1">
        <h4 className="text-sm font-semibold leading-tight">{item.name}</h4>
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{item.description}</p>
      </div>
    </div>
  );
}

/** Iframe preview for app-provided widgets */
function AppWidgetPreview({ appId, widgetId, appUrls }: { appId: string; widgetId: string; appUrls: Record<string, string> }) {
  const url = appUrls[appId];

  if (!url) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const embedSrc = `${url}/embed/widget/${encodeURIComponent(widgetId)}`;

  return (
    <iframe
      src={embedSrc}
      className="absolute top-0 left-0 w-full h-full border-0 pointer-events-none"
      style={{ background: "transparent", colorScheme: "normal" }}
      loading="lazy"
      tabIndex={-1}
      title={`${appId} ${widgetId} preview`}
    />
  );
}
