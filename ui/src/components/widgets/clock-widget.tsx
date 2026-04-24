/**
 * Clock Widget
 *
 * Displays the current time and date with a modern, styled look.
 * Text is fit-to-width: it always fills the container, and height
 * auto-adjusts. Resize the widget wider → text gets bigger.
 * Minimal padding for a tight, clean appearance.
 */

"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface ClockWidgetProps {
  settings?: { showSeconds?: boolean; format24h?: boolean };
  onAutoSize?: (size: { height: number }) => void;
}

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
        // Sum up all child heights
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

  // Date is proportional to time
  const dateSize = Math.max(8, fitSize * 0.28);

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col items-center justify-center overflow-hidden">
      <span
        ref={timeRef}
        className="tabular-nums font-semibold tracking-wide leading-none whitespace-nowrap"
        style={{
          fontSize: `${fitSize}px`,
          backgroundImage: "linear-gradient(135deg, var(--primary), color-mix(in oklch, var(--primary) 60%, var(--muted-foreground)))",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}
      >
        {timeStr}
      </span>
      <span
        className="text-muted-foreground leading-tight whitespace-nowrap font-medium tracking-wider uppercase"
        style={{ fontSize: `${dateSize}px` }}
      >
        {dateStr}
      </span>
    </div>
  );
}
