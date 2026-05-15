/**
 * Greeting Preset Picker
 *
 * Category-tabbed grid of 17 WordArt style thumbnails.
 * Each thumbnail renders a mini preview of the greeting style.
 * Hover previews are applied live to the greeting widget.
 */

"use client";

import { useState, useMemo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  GREETING_CATEGORIES,
  GREETING_PRESETS,
  getPresetsByCategory,
  type GreetingPreset,
  type GreetingCategory,
} from "@/lib/greeting-presets";

interface GreetingPresetPickerProps {
  selectedPresetId: string;
  onSelect: (presetId: string) => void;
  onHover?: (presetId: string | null) => void;
}

/** Small 120x60 preview thumbnail for a preset */
function PresetThumbnail({
  preset,
  isSelected,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  preset: GreetingPreset;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const thumbnailStyle = useMemo((): CSSProperties => {
    const { css } = preset;
    const style: CSSProperties = {
      fontFamily: css.fontFamily,
      fontSize: "0.6rem",
      fontWeight: css.fontWeight,
      letterSpacing: css.letterSpacing,
      textTransform: css.textTransform as CSSProperties["textTransform"],
      color: css.color,
      textShadow: css.textShadow !== "none" ? css.textShadow.replace(/\d+px/g, (m) => {
        const n = parseInt(m);
        return `${Math.max(1, Math.round(n * 0.3))}px`;
      }) : "none",
      lineHeight: 1.2,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    if (css.gradient) {
      style.background = `linear-gradient(${css.gradient.direction}, ${css.gradient.from}, ${css.gradient.to})`;
      style.WebkitBackgroundClip = "text";
      style.WebkitTextFillColor = "transparent";
    }

    if (css.border) {
      style.border = css.border.replace(/\d+px/, "1px");
      style.padding = "2px 4px";
      style.borderRadius = "2px";
    }

    if (css.background && !css.gradient) {
      style.background = css.background;
      if (css.borderRadius) style.borderRadius = "4px";
      style.padding = "2px 6px";
    }

    if (css.backdropFilter) {
      style.backdropFilter = css.backdropFilter;
    }

    return style;
  }, [preset]);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "relative flex items-center justify-center rounded-lg border transition-all",
        "h-[60px] w-full overflow-hidden",
        isSelected
          ? "border-primary ring-2 ring-primary/30 bg-primary/5"
          : "border-border hover:border-primary/50 bg-card/50 hover:bg-card/80"
      )}
      title={preset.name}
    >
      {/* Dark background for presets that need contrast */}
      {(preset.id === "cyberpunk" || preset.id === "terminal" || preset.id === "neon-pulse" || preset.id === "glassmorphism") && (
        <div className="absolute inset-0 bg-gray-900/90 rounded-lg" />
      )}

      <div className="relative z-10 px-2" style={thumbnailStyle}>
        Hello
      </div>

      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-1 right-1 w-3 h-3 rounded-full bg-primary flex items-center justify-center">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-primary-foreground">
            <path d="M1.5 4L3 5.5L6.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      {/* Name label */}
      <div className="absolute bottom-0.5 left-0 right-0 text-center">
        <span className="text-[8px] text-muted-foreground font-medium leading-none">
          {preset.name}
        </span>
      </div>
    </button>
  );
}

export function GreetingPresetPicker({
  selectedPresetId,
  onSelect,
  onHover,
}: GreetingPresetPickerProps) {
  const [activeCategory, setActiveCategory] = useState<GreetingCategory>(() => {
    const selected = GREETING_PRESETS.find((p) => p.id === selectedPresetId);
    return selected?.category ?? "classic";
  });

  const filteredPresets = useMemo(
    () => getPresetsByCategory(activeCategory),
    [activeCategory]
  );

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Greeting Style
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {GREETING_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setActiveCategory(cat.id)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
              activeCategory === cat.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Preset grid — 3 columns */}
      <div className="grid grid-cols-3 gap-2">
        {filteredPresets.map((preset) => (
          <PresetThumbnail
            key={preset.id}
            preset={preset}
            isSelected={selectedPresetId === preset.id}
            onClick={() => onSelect(preset.id)}
            onMouseEnter={() => onHover?.(preset.id)}
            onMouseLeave={() => onHover?.(null)}
          />
        ))}
      </div>
    </div>
  );
}
