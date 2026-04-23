/**
 * Clock Widget
 *
 * Displays the current time and date with a modern, styled look.
 * Updates every second. Text scales proportionally with the widget
 * container via CSS container query units (cqw/cqh).
 */

"use client";

import { useEffect, useState } from "react";

interface ClockWidgetProps {
  settings?: { showSeconds?: boolean; format24h?: boolean };
}

export function ClockWidget({ settings }: ClockWidgetProps) {
  const [now, setNow] = useState<Date>(new Date());

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

  return (
    <div className="flex h-full flex-col items-center justify-center gap-[1cqh] overflow-hidden">
      <span
        className="tabular-nums font-semibold tracking-wide leading-none whitespace-nowrap"
        style={{
          fontSize: "clamp(1rem, 10cqw, 6rem)",
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
        style={{
          fontSize: "clamp(0.5rem, 3cqw, 1.5rem)",
        }}
      >
        {dateStr}
      </span>
    </div>
  );
}
