/**
 * Widget Registry
 *
 * Central mapping from widget type strings to React components + metadata.
 * Supports built-in widgets and will extend to app-provided widgets.
 */

import { GreetingWidget } from "./greeting-widget";
import { SearchWidget } from "./search-widget";
import { ClockWidget } from "./clock-widget";
import { TimelinePreviewWidget } from "./timeline-preview-widget";
import { AppWidget } from "./app-widget";
import type { ComponentType } from "react";

export interface WidgetComponentProps {
  settings?: Record<string, unknown>;
}

export interface SettingsField {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label: string;
  description?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: { label: string; value: string }[];
}

export interface WidgetMeta {
  id: string;
  name: string;
  description: string;
  category: "built-in" | "app" | "system";
  component: ComponentType<WidgetComponentProps>;
  defaultSize: { width: number; height: number };
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  settingsSchema?: SettingsField[];
  /** For app-provided widgets */
  appId?: string;
}

/** The generic app widget component used for all app-provided widgets */
export { AppWidget };

export const WIDGET_CATALOG: WidgetMeta[] = [
  {
    id: "greeting",
    name: "Greeting",
    description: "Personalized greeting with time-based message",
    category: "built-in",
    component: GreetingWidget,
    defaultSize: { width: 40, height: 10 },
    minSize: { width: 20, height: 6 },
    settingsSchema: [
      {
        key: "name",
        type: "string",
        label: "Display name",
        description: "Name shown in the greeting",
        default: "",
      },
    ],
  },
  {
    id: "search",
    name: "Search",
    description: "Quick search bar for apps and content",
    category: "built-in",
    component: SearchWidget,
    defaultSize: { width: 35, height: 8 },
    minSize: { width: 20, height: 6 },
  },
  {
    id: "clock",
    name: "Clock",
    description: "Digital clock with date display",
    category: "built-in",
    component: ClockWidget,
    defaultSize: { width: 18, height: 15 },
    minSize: { width: 12, height: 10 },
    settingsSchema: [
      {
        key: "showSeconds",
        type: "boolean",
        label: "Show seconds",
        default: true,
      },
      {
        key: "format24h",
        type: "boolean",
        label: "24-hour format",
        default: true,
      },
    ],
  },
  {
    id: "timeline-preview",
    name: "Timeline Preview",
    description: "Recent entries from your encrypted timeline",
    category: "built-in",
    component: TimelinePreviewWidget,
    defaultSize: { width: 25, height: 25 },
    minSize: { width: 18, height: 18 },
    maxSize: { width: 50, height: 60 },
    settingsSchema: [
      {
        key: "maxItems",
        type: "number",
        label: "Maximum items",
        description: "Number of entries to show",
        default: 5,
        min: 1,
        max: 20,
      },
      {
        key: "collection",
        type: "select",
        label: "Collection",
        default: "all",
        options: [
          { label: "All", value: "all" },
          { label: "History", value: "history" },
          { label: "Upcoming", value: "upcoming" },
          { label: "Imported", value: "imported" },
        ],
      },
    ],
  },
];

/** Backward-compatible lookup: type string → component */
export const WIDGET_REGISTRY: Record<string, ComponentType<WidgetComponentProps>> = {
  ...Object.fromEntries(WIDGET_CATALOG.map((w) => [w.id, w.component])),
  "app-widget": AppWidget,
};

/** Get metadata for a widget type */
export function getWidgetMeta(widgetType: string): WidgetMeta | undefined {
  return WIDGET_CATALOG.find((w) => w.id === widgetType);
}

