"use client";

import { cn } from "@/lib/utils";
import type { InfoCardData, InfoCardSize } from "../types";

interface ArticleSummaryCardProps {
  data: InfoCardData;
  size: InfoCardSize;
  className?: string;
}

export function ArticleSummaryCard({
  data,
  size,
  className,
}: ArticleSummaryCardProps) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50",
        size === "compact" && "p-2",
        className
      )}
    >
      {data.thumbnailUrl && (
        <img
          src={data.thumbnailUrl}
          alt=""
          className={cn(
            "rounded object-cover flex-shrink-0",
            size === "compact" ? "h-10 w-10" : "h-20 w-20"
          )}
        />
      )}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "font-medium",
            size === "compact" ? "text-sm" : "text-base"
          )}
        >
          {data.title}
        </p>
        {data.description && size !== "compact" && (
          <p
            className={cn(
              "text-sm text-muted-foreground mt-1",
              size === "expanded" ? "line-clamp-5" : "line-clamp-3"
            )}
          >
            {data.description}
          </p>
        )}
        {data.facts &&
          data.facts.length > 0 &&
          size === "expanded" && (
            <div className="flex flex-wrap gap-2 mt-2">
              {data.facts.map((fact, i) => (
                <span key={i} className="text-xs text-muted-foreground">
                  <span className="font-medium">{fact.label}:</span>{" "}
                  {fact.value}
                </span>
              ))}
            </div>
          )}
        {data.actions &&
          size !== "compact" &&
          data.actions.map((action, i) => (
            <a
              key={i}
              href={action.url}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
              target={action.type === "link" ? "_blank" : undefined}
              rel={
                action.type === "link" ? "noopener noreferrer" : undefined
              }
            >
              {action.label}
            </a>
          ))}
      </div>
    </div>
  );
}
