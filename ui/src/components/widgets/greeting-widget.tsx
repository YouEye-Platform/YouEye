/**
 * Greeting Widget
 *
 * Displays a time-aware greeting ("Good morning", "Good afternoon", etc.)
 * followed by the user's name. Supports 17 WordArt style presets with
 * custom fonts, gradients, animations, and decorative effects.
 */

"use client";

import { useEffect, useState, useMemo, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { getGreetingPreset, type GreetingPreset } from "@/lib/greeting-presets";
import { cn } from "@/lib/utils";

interface GreetingWidgetProps {
  settings?: {
    name?: string;
    greetingPreset?: string;
  };
}

/** Returns a translation key for the time-appropriate greeting */
function getGreetingKey(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "goodNight";
  if (hour < 12) return "goodMorning";
  if (hour < 17) return "goodAfternoon";
  if (hour < 21) return "goodEvening";
  return "goodNight";
}

/** Build inline styles from a preset's CSS definition */
function buildPresetStyle(preset: GreetingPreset): CSSProperties {
  const { css } = preset;
  const style: CSSProperties = {
    fontFamily: css.fontFamily,
    fontSize: css.fontSize,
    fontWeight: css.fontWeight,
    letterSpacing: css.letterSpacing,
    textTransform: css.textTransform as CSSProperties["textTransform"],
    color: css.color,
    textShadow: css.textShadow,
    lineHeight: 1.3,
    transition: "all 0.3s ease",
  };

  if (css.gradient) {
    style.background = `linear-gradient(${css.gradient.direction}, ${css.gradient.from}, ${css.gradient.to})`;
    style.WebkitBackgroundClip = "text";
    style.WebkitTextFillColor = "transparent";
    if (css.backgroundSize) {
      style.backgroundSize = css.backgroundSize;
    }
  }

  if (css.background && !css.gradient) {
    style.background = css.background;
  }

  if (css.borderRadius) style.borderRadius = css.borderRadius;
  if (css.padding) style.padding = css.padding;
  if (css.border) style.border = css.border;

  if (css.backdropFilter) {
    style.backdropFilter = css.backdropFilter;
    style.WebkitBackdropFilter = css.backdropFilter;
  }

  if (preset.animation) {
    style.animation = preset.animation;
  }

  return style;
}

export function GreetingWidget({ settings }: GreetingWidgetProps) {
  const t = useTranslations("greeting");
  const [greetingKey, setGreetingKey] = useState(getGreetingKey);

  useEffect(() => {
    const interval = setInterval(() => setGreetingKey(getGreetingKey()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const name = settings?.name || t("defaultName");
  const presetId = settings?.greetingPreset ?? "default";
  const preset = useMemo(() => getGreetingPreset(presetId), [presetId]);
  const style = useMemo(() => buildPresetStyle(preset), [preset]);

  const greeting = t(greetingKey);

  // Terminal format: "> Good morning, name_" with blinking cursor
  if (preset.terminalFormat) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className={cn("wordart-animated", "inline-block")}
          style={style}
        >
          <span style={{ opacity: 0.5 }}>{">"}</span>{" "}
          {greeting}, <span style={{ fontWeight: 500 }}>{name}</span>
          <span
            style={{
              animation: "wordart-cursor-blink 1s step-end infinite",
              marginLeft: "2px",
            }}
          >
            _
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div
        className={cn(preset.animation ? "wordart-animated" : undefined, "text-center")}
        style={style}
      >
        {greeting},{" "}
        <span style={{ fontWeight: Math.min((preset.css.fontWeight || 400) + 200, 900) }}>
          {name}
        </span>
      </div>
    </div>
  );
}
