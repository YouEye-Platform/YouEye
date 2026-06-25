/**
 * Clock Theme Picker
 *
 * Category-tabbed grid of clock style thumbnails.
 * Each thumbnail renders a mini preview of the time display in that theme.
 */

"use client";

import { useState, useMemo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  CLOCK_CATEGORIES,
  CLOCK_PRESETS,
  getClockPresetsByCategory,
  type ClockTheme,
  type ClockCategory,
} from "@/lib/clock-presets";

interface ClockThemePickerProps {
  selectedThemeId: string;
  onSelect: (themeId: string) => void;
}

function ThemeThumbnail({
  theme,
  isSelected,
  onClick,
}: {
  theme: ClockTheme;
  isSelected: boolean;
  onClick: () => void;
}) {
  const timeStyle = useMemo((): CSSProperties => {
    const { time } = theme;
    const style: CSSProperties = {
      fontFamily: time.fontFamily,
      fontSize: "0.7rem",
      fontWeight: time.fontWeight,
      letterSpacing: time.letterSpacing,
      color: time.color,
      lineHeight: 1.2,
      whiteSpace: "nowrap",
    };

    if (time.textShadow !== "none") {
      style.textShadow = time.textShadow.replace(/\d+px/g, (m) => {
        const n = parseInt(m);
        return `${Math.max(1, Math.round(n * 0.3))}px`;
      });
    }

    if (time.gradient) {
      style.background = `linear-gradient(${time.gradient.direction}, ${time.gradient.from}, ${time.gradient.to})`;
      style.WebkitBackgroundClip = "text";
      style.WebkitTextFillColor = "transparent";
    }

    return style;
  }, [theme]);

  const dateStyle = useMemo((): CSSProperties => {
    const { date } = theme;
    return {
      fontFamily: date.fontFamily ?? theme.time.fontFamily,
      fontSize: "0.35rem",
      fontWeight: date.fontWeight ?? 400,
      letterSpacing: date.letterSpacing ?? "0.05em",
      color: date.color,
      textTransform: (date.textTransform as CSSProperties["textTransform"]) ?? "none",
      lineHeight: 1.4,
      whiteSpace: "nowrap",
      textShadow: date.textShadow
        ? date.textShadow.replace(/\d+px/g, (m) => {
            const n = parseInt(m);
            return `${Math.max(1, Math.round(n * 0.2))}px`;
          })
        : undefined,
    };
  }, [theme]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-center justify-center rounded-lg border transition-all",
        "h-[60px] w-full overflow-hidden gap-0.5",
        isSelected
          ? "border-primary ring-2 ring-primary/30 bg-primary/5"
          : "border-border hover:border-primary/50 bg-card/50 hover:bg-card/80"
      )}
      title={theme.name}
    >
      {theme.needsDarkBg && (
        <div className="absolute inset-0 bg-gray-900/90 rounded-lg" />
      )}

      <div className="relative z-10" style={timeStyle}>
        12:34
      </div>
      <div className="relative z-10" style={dateStyle}>
        Thursday
      </div>

      {isSelected && (
        <div className="absolute top-1 right-1 w-3 h-3 rounded-full bg-primary flex items-center justify-center">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-primary-foreground">
            <path d="M1.5 4L3 5.5L6.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <div className="absolute bottom-0.5 left-0 right-0 text-center">
        <span className="text-[8px] text-muted-foreground font-medium leading-none">
          {theme.name}
        </span>
      </div>
    </button>
  );
}

export function ClockThemePicker({
  selectedThemeId,
  onSelect,
}: ClockThemePickerProps) {
  const [activeCategory, setActiveCategory] = useState<ClockCategory>(() => {
    const selected = CLOCK_PRESETS.find((p) => p.id === selectedThemeId);
    return selected?.category ?? "classic";
  });

  const filteredThemes = useMemo(
    () => getClockPresetsByCategory(activeCategory),
    [activeCategory]
  );

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Clock Theme
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {CLOCK_CATEGORIES.map((cat) => (
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

      <div className="grid grid-cols-3 gap-2">
        {filteredThemes.map((theme) => (
          <ThemeThumbnail
            key={theme.id}
            theme={theme}
            isSelected={selectedThemeId === theme.id}
            onClick={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}
