/**
 * Widget Settings Dialog
 *
 * Auto-generates a settings form from the widget's settings_schema.
 * Always includes a Background section for per-widget background control.
 * Used in edit mode when clicking the settings icon on a widget.
 */

"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { X, Settings2 } from "lucide-react";
import { getWidgetMeta, type SettingsField } from "@/components/widgets";
import { GreetingPresetPicker } from "@/components/widgets/greeting-preset-picker";
import { ClockThemePicker } from "@/components/widgets/clock-theme-picker";
import { cn } from "@/lib/utils";

interface WidgetSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widgetType: string;
  currentSettings: Record<string, unknown>;
  onSave: (settings: Record<string, unknown>) => void;
}

type BackgroundStyle = "default" | "transparent" | "custom";

function SettingsFieldInput({
  field,
  value,
  onChange,
}: {
  field: SettingsField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  switch (field.type) {
    case "boolean":
      return (
        <label className="flex items-center justify-between gap-3 py-1">
          <div>
            <div className="text-sm font-medium">{field.label}</div>
            {field.description && (
              <div className="text-xs text-muted-foreground">{field.description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onChange(field.key, !value)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              value ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                value ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>
      );

    case "number":
      return (
        <label className="block py-1">
          <div className="text-sm font-medium">{field.label}</div>
          {field.description && (
            <div className="text-xs text-muted-foreground mb-1">{field.description}</div>
          )}
          <input
            type="number"
            value={(value as number) ?? field.default ?? 0}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(field.key, Number(e.target.value))}
            className="w-full px-3 py-1.5 text-sm rounded-md border bg-background"
          />
        </label>
      );

    case "select":
      return (
        <label className="block py-1">
          <div className="text-sm font-medium">{field.label}</div>
          {field.description && (
            <div className="text-xs text-muted-foreground mb-1">{field.description}</div>
          )}
          <select
            value={(value as string) ?? field.default ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-md border bg-background"
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      );

    case "string":
    default:
      return (
        <label className="block py-1">
          <div className="text-sm font-medium">{field.label}</div>
          {field.description && (
            <div className="text-xs text-muted-foreground mb-1">{field.description}</div>
          )}
          <input
            type="text"
            value={(value as string) ?? field.default ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-md border bg-background"
          />
        </label>
      );
  }
}

function BackgroundStyleSection({
  backgroundStyle,
  customColor,
  onChange,
}: {
  backgroundStyle: BackgroundStyle;
  customColor: string;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useTranslations("widgetSettings");

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t("background")}
      </div>

      {/* Style selector — visual swatch thumbnails */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onChange("backgroundStyle", "default")}
          className={cn(
            "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors",
            backgroundStyle === "default"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border/80"
          )}
        >
          <div className="w-full h-8 rounded-md bg-card/70 border border-border/40" />
          <span className="text-[10px] font-medium">{t("default")}</span>
        </button>

        <button
          type="button"
          onClick={() => onChange("backgroundStyle", "transparent")}
          className={cn(
            "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors",
            backgroundStyle === "transparent"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border/80"
          )}
        >
          <div className="w-full h-8 rounded-md border border-dashed border-border/60 bg-[repeating-conic-gradient(#80808020_0%_25%,transparent_0%_50%)] bg-[size:8px_8px]" />
          <span className="text-[10px] font-medium">{t("transparent")}</span>
        </button>

        <button
          type="button"
          onClick={() => onChange("backgroundStyle", "custom")}
          className={cn(
            "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors",
            backgroundStyle === "custom"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border/80"
          )}
        >
          <div
            className="w-full h-8 rounded-md border border-border/40"
            style={{ backgroundColor: customColor || "#3b82f6" }}
          />
          <span className="text-[10px] font-medium">{t("custom")}</span>
        </button>
      </div>

      {/* Color picker — only shown when custom is selected */}
      {backgroundStyle === "custom" && (
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={customColor || "#3b82f6"}
            onChange={(e) => onChange("customBackgroundColor", e.target.value)}
            className="w-8 h-8 rounded-md border border-border cursor-pointer"
          />
          <input
            type="text"
            value={customColor || "#3b82f6"}
            onChange={(e) => onChange("customBackgroundColor", e.target.value)}
            placeholder="#3b82f6"
            className="flex-1 px-3 py-1.5 text-sm rounded-md border bg-background font-mono"
          />
        </div>
      )}
    </div>
  );
}

export function WidgetSettingsDialog({
  open,
  onOpenChange,
  widgetType,
  currentSettings,
  onSave,
}: WidgetSettingsDialogProps) {
  const tc = useTranslations("common");
  const tw = useTranslations("widgetSettings");
  const meta = getWidgetMeta(widgetType);
  const [localSettings, setLocalSettings] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (open) {
      const defaults: Record<string, unknown> = {};
      meta?.settingsSchema?.forEach((f) => {
        if (f.default !== undefined) defaults[f.key] = f.default;
      });
      setLocalSettings({ ...defaults, ...currentSettings });
    }
  }, [open, currentSettings, meta]);

  // Dialog opens for ANY widget now (background section always available)
  if (!open) return null;

  const handleChange = (key: string, value: unknown) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    onSave(localSettings);
    onOpenChange(false);
  };

  const hasWidgetFields = meta?.settingsSchema?.length;
  const widgetName = meta?.name ?? widgetType;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-popover border rounded-xl shadow-xl w-80 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{widgetName} {tw("title")}</h3>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="p-1 rounded-md hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Widget-specific fields */}
        {hasWidgetFields && (
          <div className="px-4 py-3 space-y-3 border-b">
            {meta.settingsSchema!.map((field) => (
              <SettingsFieldInput
                key={field.key}
                field={field}
                value={localSettings[field.key]}
                onChange={handleChange}
              />
            ))}
          </div>
        )}

        {/* Greeting preset picker — only for greeting widget */}
        {widgetType === "greeting" && (
          <div className="px-4 py-3 border-b">
            <GreetingPresetPicker
              selectedPresetId={(localSettings.greetingPreset as string) ?? "default"}
              onSelect={(presetId) => handleChange("greetingPreset", presetId)}
            />
          </div>
        )}

        {/* Clock theme picker — only for clock widget */}
        {widgetType === "clock" && (
          <div className="px-4 py-3 border-b">
            <ClockThemePicker
              selectedThemeId={(localSettings.clockTheme as string) ?? "gradient"}
              onSelect={(themeId) => handleChange("clockTheme", themeId)}
            />
          </div>
        )}

        {/* Background section — always present */}
        <div className="px-4 py-3">
          <BackgroundStyleSection
            backgroundStyle={(localSettings.backgroundStyle as BackgroundStyle) ?? "default"}
            customColor={(localSettings.customBackgroundColor as string) ?? ""}
            onChange={handleChange}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t">
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
          >
            {tc("cancel")}
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {tc("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
