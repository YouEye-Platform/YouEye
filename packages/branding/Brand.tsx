"use client";

import { designSchema, type Theme } from "./lib/design";
import { Artwork } from "./components";
import "./brand.css";

/** Validate persisted input before it can reach the SVG renderer. */
export function Brand({ design, name, view = "title", className = "" }: {
  design: unknown; name?: string; view?: "title" | "icon" | "logo"; className?: string;
}) {
  const parsed = designSchema.safeParse(design);
  if (!parsed.success) return name ? <span className={className}>{name}</span> : null;
  const d = name ? { ...parsed.data, name } : parsed.data;
  return (
    <span className={`mytitle-brand mytitle-brand-${view} ${className}`} role="img" aria-label={name || d.name}>
      {(["light", "dark"] as Theme[]).map((theme) => (
        <span key={theme} className={`mytitle-${theme}`} aria-hidden="true">
          <Artwork design={d} theme={theme} view={view} compact={view === "title"} />
        </span>
      ))}
    </span>
  );
}
