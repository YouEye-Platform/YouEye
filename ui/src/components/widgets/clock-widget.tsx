/**
 * Clock Widget
 *
 * Displays the current time and date. Updates every second.
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
    <div className="flex h-full flex-col items-center justify-center gap-0.5 p-0">
      <span className="text-3xl font-light tabular-nums tracking-wider text-foreground leading-tight">
        {timeStr}
      </span>
      <span className="text-xs text-muted-foreground leading-tight">{dateStr}</span>
    </div>
  );
}
