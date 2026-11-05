/**
 * Widget Registry
 *
 * Central mapping from widget type strings to React components + metadata.
 * Supports built-in widgets and will extend to app-provided widgets.
 */

import { GreetingWidget } from "./greeting-widget";
import { ServerNameWidget } from "./server-name-widget";
import { BookmarksWidget } from "./bookmarks-widget";
import { ClockWidget } from "./clock-widget";
import { AppWidget } from "./app-widget";
import type { ComponentType } from "react";

export interface WidgetComponentProps {
  settings?: Record<string, unknown>;
  /** Called by auto-fit widgets to report their ideal content height (px). */
  onAutoSize?: (size: { height: number }) => void;
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
  /** Widget auto-fits height to content. Width is user-controlled, text fills it. */
  autoFit?: boolean;
  /** Allow widget content (e.g. text-shadow effects) to paint beyond the container bounds. */
  allowOverflow?: boolean;
}

/** The generic app widget component used for all app-provided widgets */
export { AppWidget };

export const WIDGET_CATALOG: WidgetMeta[] = [
  {
    id: "server-name",
    name: "Server Name",
    description: "Instance name with WordArt styling — like a search engine logo",
    category: "built-in",
    component: ServerNameWidget,
    defaultSize: { width: 13, height: 4 },
    minSize: { width: 8, height: 3 },
    autoFit: true,
    allowOverflow: true,
  },
  {
    id: "greeting",
    name: "Greeting",
    description: "Personalized greeting with time-based message",
    category: "built-in",
    component: GreetingWidget,
    defaultSize: { width: 35, height: 8 },
    minSize: { width: 18, height: 5 },
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
    id: "clock",
    name: "Clock",
    description: "Digital clock with date display",
    category: "built-in",
    component: ClockWidget,
    defaultSize: { width: 14, height: 6 },
    minSize: { width: 8, height: 3 },
    autoFit: true,
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
    id: "bookmarks",
    name: "Bookmarks",
    description: "Quick-access bookmarks organized into pages",
    category: "built-in",
    component: BookmarksWidget,
    defaultSize: { width: 25, height: 14 },
    minSize: { width: 15, height: 8 },
    settingsSchema: [
      {
        key: "showLabels",
        type: "boolean",
        label: "Show labels",
        description: "Display bookmark titles",
        default: true,
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
