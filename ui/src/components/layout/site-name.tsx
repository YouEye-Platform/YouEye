/**
 * Site Name
 *
 * Renders the instance name with WordArt-style CSS properties.
 * Automatically loads the required self-hosted font on mount.
 */

"use client";

import { useEffect } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { CHARACTER_SHAPE_PRESETS } from "@/lib/wordart-presets";
import { FONT_CSS_MAP } from "@/lib/site-name-utils";

// Re-export for any existing consumers
export { FONT_CSS_MAP } from "@/lib/site-name-utils";
export { siteNameStyleToCSS } from "@/lib/site-name-utils";

interface SiteNameProps {
  name: string;
  style: SiteNameStyle | null;
  className?: string;
  as?: "h1" | "span" | "div";
}

const DEFAULT_STYLE: SiteNameStyle = {
  fontFamily: "Inter",
  fontSize: "1.5rem",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

export function SiteName({ name, style, className, as: Tag = "span" }: SiteNameProps) {
  const s = style ?? DEFAULT_STYLE;

  // Load the font CSS on mount
  useEffect(() => {
    const cssPath = FONT_CSS_MAP[s.fontFamily];
    if (!cssPath) return;
    const id = `gf-${s.fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
  }, [s.fontFamily]);

  const cssProps: React.CSSProperties = {
    fontFamily: `"${s.fontFamily}", sans-serif`,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    letterSpacing: s.letterSpacing,
    textTransform: s.textTransform as React.CSSProperties["textTransform"],
    textShadow: s.textShadow !== "none" ? s.textShadow : undefined,
    WebkitTextStroke: s.textStroke || "unset",
    transform: s.transform || undefined,
    display: s.transform ? "inline-block" : undefined,
    backfaceVisibility: "hidden",
  };

  if (s.gradient?.enabled) {
    cssProps.color = "transparent";
    cssProps.backgroundImage = `linear-gradient(${s.gradient.direction}, ${s.gradient.from}, ${s.gradient.to})`;
    cssProps.WebkitBackgroundClip = "text";
    cssProps.WebkitTextFillColor = "transparent";
    cssProps.backgroundClip = "text";
  } else {
    cssProps.color = s.color;
    cssProps.backgroundImage = "none";
    cssProps.WebkitBackgroundClip = "initial";
    cssProps.WebkitTextFillColor = s.color;
    cssProps.backgroundClip = "initial";
  }

  const gKey = s.gradient?.enabled ? `g-${s.gradient.from}-${s.gradient.to}` : 's';

  const charShape = s.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find(p => p.id === s.charShapeId) ?? null
    : null;

  if (charShape) {
    const intensity = s.charShapeIntensity ?? 1;
    return (
      <Tag key={gKey} className={className} style={{ ...cssProps, display: 'inline-flex', alignItems: 'baseline' }}>
        {name.split('').map((ch, i) => (
          <span key={i} style={{ display: 'inline-block', transform: charShape.charTransform(i, name.length, intensity) }}>
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </Tag>
    );
  }

  return (
    <Tag key={gKey} className={className} style={cssProps}>
      {name}
    </Tag>
  );
}

export type { SiteNameStyle };
