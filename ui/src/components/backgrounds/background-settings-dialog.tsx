/**
 * Background Settings Dialog
 *
 * Full-featured settings dialog accessible from edit mode toolbar.
 * Allows switching between solid/animated/image backgrounds,
 * choosing animation styles and color presets, and tweaking
 * advanced customization sliders.
 */
"use client";

import { useState, useCallback } from "react";
import { useTheme } from "next-themes";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import {
  ANIMATED_BACKGROUNDS,
  COLOR_PRESETS,
  DEFAULT_CUSTOMIZATION,
  getPresetBackground,
  type AnimatedBackgroundStyle,
  type ColorPreset,
  type BackgroundCustomization,
} from "./index";
import type { BackgroundConfig } from "./homepage-background";
import { GRADIENT_BACKGROUND_PRESETS } from "@/lib/greeting-presets";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

interface BackgroundSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: BackgroundConfig;
  onConfigChange: (config: BackgroundConfig) => void;
}

// Background type options — icons are decorative, labels are translated below
const BG_TYPE_IDS = ["solid", "animated", "image"] as const;
const BG_TYPE_ICONS: Record<string, string> = { solid: "\u25A0", animated: "\u25B6", image: "\uD83D\uDDBC" };

export function BackgroundSettingsDialog({
  open,
  onOpenChange,
  config,
  onConfigChange,
}: BackgroundSettingsDialogProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [localConfig, setLocalConfig] = useState<BackgroundConfig>(config);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const t = useTranslations('backgroundSettings');

  // Sync local state when dialog opens
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) setLocalConfig(config);
      onOpenChange(isOpen);
    },
    [config, onOpenChange]
  );

  const updateConfig = useCallback(
    (updates: Partial<BackgroundConfig>) => {
      const newConfig = { ...localConfig, ...updates };
      if (updates.settings) {
        newConfig.settings = { ...localConfig.settings, ...updates.settings };
      }
      setLocalConfig(newConfig);
      onConfigChange(newConfig);
    },
    [localConfig, onConfigChange]
  );

  const updateSettings = useCallback(
    (settings: Partial<BackgroundConfig["settings"]>) => {
      const newConfig = {
        ...localConfig,
        settings: { ...localConfig.settings, ...settings },
      };
      setLocalConfig(newConfig);
      onConfigChange(newConfig);
    },
    [localConfig, onConfigChange]
  );

  const updateCustomization = useCallback(
    (key: keyof BackgroundCustomization, value: number | boolean) => {
      const current = localConfig.settings.customization ?? DEFAULT_CUSTOMIZATION;
      updateSettings({
        customization: { ...current, [key]: value },
      });
    },
    [localConfig, updateSettings]
  );

  const animatedStyle = localConfig.settings.animatedStyle ?? "flowing-lines";
  const animatedPreset = localConfig.settings.animatedPreset ?? "purple";
  const customization = localConfig.settings.customization ?? DEFAULT_CUSTOMIZATION;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {/* Background Type Selector */}
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground/70 mb-2 block">
              {t('type')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {BG_TYPE_IDS.map((typeId) => (
                <button
                  key={typeId}
                  onClick={() => updateConfig({ type: typeId })}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                    localConfig.type === typeId
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <span className="text-xl">{BG_TYPE_ICONS[typeId]}</span>
                  <span className="text-xs font-medium">{t(typeId)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Solid Color Options */}
          {localConfig.type === "solid" && (
            <div>
              <label className="text-sm font-medium text-foreground/70 mb-2 block">
                {t('color')}
              </label>
              <div className="grid grid-cols-5 gap-2">
                {Object.entries(COLOR_PRESETS).map(([key, preset]) => {
                  const bg = getPresetBackground(preset, isDark);
                  return (
                    <button
                      key={key}
                      onClick={() =>
                        updateSettings({ solidColor: bg })
                      }
                      className={`h-10 rounded-lg border-2 transition-all ${
                        localConfig.settings.solidColor === bg
                          ? "border-primary scale-105"
                          : "border-transparent hover:border-primary/30"
                      }`}
                      style={{ backgroundColor: bg }}
                      title={preset.label}
                    />
                  );
                })}
              </div>
              {/* Custom color input */}
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="color"
                  value={localConfig.settings.solidColor ?? (isDark ? "#111827" : "#f9fafb")}
                  onChange={(e) => updateSettings({ solidColor: e.target.value })}
                  className="w-8 h-8 rounded cursor-pointer"
                />
                <span className="text-xs text-foreground/50">{t('customColor')}</span>
              </div>

              {/* Gradient presets */}
              <div className="mt-4">
                <label className="text-sm font-medium text-foreground/70 mb-2 block">
                  Gradients
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {GRADIENT_BACKGROUND_PRESETS.map((gp) => (
                    <button
                      key={gp.id}
                      onClick={() => updateSettings({ solidColor: gp.css })}
                      className={cn(
                        "h-10 rounded-lg border-2 transition-all",
                        localConfig.settings.solidColor === gp.css
                          ? "border-primary scale-105"
                          : "border-transparent hover:border-primary/30"
                      )}
                      style={{ background: gp.css }}
                      title={gp.name}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Animated Background Options */}
          {localConfig.type === "animated" && (
            <>
              {/* Animation Style Picker */}
              <div>
                <label className="text-sm font-medium text-foreground/70 mb-2 block">
                  {t('animationStyle')}
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-[200px] overflow-y-auto pr-1">
                  {Object.entries(ANIMATED_BACKGROUNDS).map(([key, bg]) => (
                    <button
                      key={key}
                      onClick={() =>
                        updateSettings({
                          animatedStyle: key as AnimatedBackgroundStyle,
                        })
                      }
                      className={`flex items-center gap-2 p-2 rounded-lg border text-left transition-colors ${
                        animatedStyle === key
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <span className="text-lg flex-shrink-0">{bg.icon}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {bg.name}
                        </div>
                        <div className="text-xs text-foreground/50 truncate">
                          {bg.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Color Preset Picker */}
              <div>
                <label className="text-sm font-medium text-foreground/70 mb-2 block">
                  {t('colorPalette')}
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {Object.entries(COLOR_PRESETS).map(([key, preset]) => (
                    <button
                      key={key}
                      onClick={() =>
                        updateSettings({ animatedPreset: key as ColorPreset })
                      }
                      className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                        animatedPreset === key
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      {/* Color swatch showing first 3 colors */}
                      <div className="flex gap-0.5">
                        {preset.colors.slice(0, 3).map((color, i) => (
                          <div
                            key={i}
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <span className="text-xs">{preset.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Disable Animations Toggle */}
              <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/50 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={localConfig.settings.disableAnimations ?? false}
                  onChange={(e) =>
                    updateSettings({ disableAnimations: e.target.checked })
                  }
                  className="w-4 h-4 rounded accent-primary"
                />
                <div>
                  <div className="text-sm font-medium">
                    {t('disableAnimations')}
                  </div>
                  <div className="text-xs text-foreground/50">
                    {t('disableAnimationsHint')}
                  </div>
                </div>
              </label>

              {/* Advanced Customization Toggle */}
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-sm text-foreground/60 hover:text-foreground/80 transition-colors"
              >
                {showAdvanced ? "\u25BC" : "\u25B6"} {t('advancedSettings')}
              </button>

              {showAdvanced && (
                <div className="space-y-4 pl-2 border-l-2 border-border">
                  {/* Speed */}
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{t('speed')}</span>
                      <span className="text-foreground/50">
                        {customization.speed.toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      value={[customization.speed]}
                      min={0.1}
                      max={3.0}
                      step={0.1}
                      onValueChange={([v]) => updateCustomization("speed", v)}
                    />
                  </div>

                  {/* Scale */}
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{t('scale')}</span>
                      <span className="text-foreground/50">
                        {customization.scale.toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      value={[customization.scale]}
                      min={0.5}
                      max={2.0}
                      step={0.1}
                      onValueChange={([v]) => updateCustomization("scale", v)}
                    />
                  </div>

                  {/* Intensity */}
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{t('intensity')}</span>
                      <span className="text-foreground/50">
                        {customization.intensity.toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      value={[customization.intensity]}
                      min={0.1}
                      max={2.0}
                      step={0.1}
                      onValueChange={([v]) => updateCustomization("intensity", v)}
                    />
                  </div>

                  {/* Cursor Reactivity */}
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{t('cursorReactivity')}</span>
                      <span className="text-foreground/50">
                        {customization.reactivity.toFixed(1)}x
                      </span>
                    </div>
                    <Slider
                      value={[customization.reactivity]}
                      min={0}
                      max={2.0}
                      step={0.1}
                      onValueChange={([v]) => updateCustomization("reactivity", v)}
                    />
                  </div>

                  {/* Reset button */}
                  <button
                    onClick={() => updateSettings({ customization: DEFAULT_CUSTOMIZATION })}
                    className="text-xs text-foreground/50 hover:text-foreground/70 underline"
                  >
                    {t('resetToDefaults')}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Image Background (placeholder for future) */}
          {localConfig.type === "image" && (
            <div className="text-center py-8 text-foreground/50">
              <p className="text-sm">{t('imageComingSoon')}</p>
              <p className="text-xs mt-1">
                {t('imageComingDescription')}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
