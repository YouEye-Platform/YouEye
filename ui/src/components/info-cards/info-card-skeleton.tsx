"use client";

import { cn } from "@/lib/utils";
import type { InfoCardSize } from "./types";

export function InfoCardSkeleton({
  size = "default",
}: {
  size?: InfoCardSize;
}) {
  return (
    <div className="flex gap-3 rounded-lg border bg-card p-3 animate-pulse">
      <div
        className={cn(
          "rounded bg-muted flex-shrink-0",
          size === "compact" ? "h-10 w-10" : "h-16 w-16"
        )}
      />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-muted rounded w-3/4" />
        {size !== "compact" && <div className="h-3 bg-muted rounded w-full" />}
        {size !== "compact" && <div className="h-3 bg-muted rounded w-1/2" />}
      </div>
    </div>
  );
}
