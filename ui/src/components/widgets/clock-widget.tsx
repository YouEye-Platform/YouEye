/**
 * Clock Widget
 *
 * Displays the current time and date with selectable visual themes.
 * Text is fit-to-width: it always fills the container, and height
 * auto-adjusts. Resize the widget wider -> text gets bigger.
 * Minimal padding for a tight, clean appearance.
 */

"use client";

import { useEffect, useState, useRef, useCallback, type CSSProperties } from "react";
import { getClockPreset, type ClockTheme } from "@/lib/clock-presets";

interface ClockWidgetProps {
  settings?: {
    showSeconds?: boolean;
    format24h?: boolean;
    clockTheme?: string;
  };
  onAutoSize?: (size: { height: number }) => void;
}

/** Build inline styles from a clock theme preset */
function buildTimeStyle(theme: ClockTheme, fitSize: number): CSSProperties {
  const { time } = theme;
  const style: CSSProperties = {
    fontSize: `${fitSize}px`,
    fontFamily: time.fontFamily,
    fontWeight: time.fontWeight,
    letterSpacing: time.letterSpacing,
    color: time.color,
  };

  if (time.textShadow !== "none") {
    style.textShadow = time.textShadow;
  }

  if (time.gradient) {
    style.backgroundImage = `linear-gradient(${time.gradient.direction}, ${time.gradient.from}, ${time.gradient.to})`;
    style.WebkitBackgroundClip = "text";
    style.WebkitTextFillColor = "transparent";
    style.backgroundClip = "text";
  }

  return style;
}

function buildDateStyle(theme: ClockTheme, dateSize: number): CSSProperties {
  const { date, time } = theme;
  const style: CSSProperties = {
    fontSize: `${dateSize}px`,
    fontFamily: date.fontFamily ?? time.fontFamily,
    fontWeight: date.fontWeight ?? 400,
    letterSpacing: date.letterSpacing ?? "0.05em",
    color: date.color,
    textTransform: (date.textTransform as CSSProperties["textTransform"]) ?? "none",
  };

  if (date.textShadow) {
    style.textShadow = date.textShadow;
  }

  return style;
}

const DEFAULT_THEME_ID = "gradient";

export function ClockWidget({ settings, onAutoSize }: ClockWidgetProps) {
  const [now, setNow] = useState<Date>(new Date());
  const containerRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [fitSize, setFitSize] = useState(32);
  const onAutoSizeRef = useRef(onAutoSize);
  onAutoSizeRef.current = onAutoSize;

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const showSeconds = settings?.showSeconds ?? true;
  const format24h = settings?.format24h ?? true;
  const themeId = settings?.clockTheme ?? DEFAULT_THEME_ID;
  const theme = getClockPreset(themeId) ?? getClockPreset(DEFAULT_THEME_ID)!;

  const timeStr = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
    hour12: !format24h,
  });

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const fitText = useCallback(() => {
    const container = containerRef.current;
    const timeEl = timeRef.current;
    if (!container || !timeEl) return;

    const cw = container.clientWidth;
    if (cw <= 0) return;

    const currentSize = parseFloat(getComputedStyle(timeEl).fontSize);
    const textW = timeEl.getBoundingClientRect().width;

    if (textW <= 0 || currentSize <= 0) return;

    const newSize = Math.max(10, Math.min(currentSize * (cw / textW) * 0.95, 400));
    setFitSize(newSize);

    requestAnimationFrame(() => {
      const c = containerRef.current;
      if (c) {
        let totalH = 0;
        for (const child of c.children) {
          totalH += (child as HTMLElement).getBoundingClientRect().height;
        }
        onAutoSizeRef.current?.({ height: Math.ceil(totalH) + 4 });
      }
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(fitText);
    observer.observe(container);
    fitText();

    return () => observer.disconnect();
  }, [fitText]);

  const dateSize = Math.max(8, fitSize * 0.28);

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col items-center justify-center overflow-hidden">
      <span
        ref={timeRef}
        className="tabular-nums leading-none whitespace-nowrap"
        style={buildTimeStyle(theme, fitSize)}
      >
        {timeStr}
      </span>
      <span
        className="leading-tight whitespace-nowrap"
        style={buildDateStyle(theme, dateSize)}
      >
        {dateStr}
      </span>
    </div>
  );
}
