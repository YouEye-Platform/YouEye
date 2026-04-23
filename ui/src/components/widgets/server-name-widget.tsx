/**
 * Server Name WordArt Widget
 *
 * Displays the instance name prominently with WordArt styling,
 * like a search engine logo on the homepage. Uses the user's
 * personal wordart override if set, otherwise falls back to
 * the admin's branding style.
 *
 * Text scales proportionally with the widget container via CSS
 * container query units (cqw). Resize the widget to make the
 * logo larger or smaller.
 */

"use client";

import { useEffect, useState, useMemo } from "react";
import { SiteName } from "@/components/layout/site-name";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

interface ServerNameWidgetProps {
  settings?: Record<string, unknown>;
}

const DEFAULT_WIDGET_STYLE: SiteNameStyle = {
  fontFamily: "Inter",
  fontSize: "clamp(1.5rem, 15cqw, 12rem)",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

export function ServerNameWidget({ settings }: ServerNameWidgetProps) {
  const [siteName, setSiteName] = useState<string>("");
  const [adminStyle, setAdminStyle] = useState<SiteNameStyle | null>(null);
  const [userOverride, setUserOverride] = useState<SiteNameStyle | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/branding").then((r) => r.json()),
      fetch("/api/v1/user/wordart").then((r) => r.json()),
    ])
      .then(([branding, wordart]) => {
        setSiteName(branding.site_name || "YouEye");
        setAdminStyle(branding.site_name_style ?? null);
        setUserOverride(wordart.wordart ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // User override > admin style > default
  const baseStyle = userOverride ?? adminStyle ?? DEFAULT_WIDGET_STYLE;

  // Override fontSize to use container-relative units so the text
  // scales with the widget box. The original style's fontSize is
  // replaced — everything else (font, gradient, effects) is kept.
  const displayStyle = useMemo((): SiteNameStyle => {
    return {
      ...baseStyle,
      fontSize: "clamp(1.5rem, 15cqw, 12rem)",
    };
  }, [baseStyle]);

  if (!loaded || !siteName) return null;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      <SiteName
        name={siteName}
        style={displayStyle}
        as="h1"
        className="whitespace-nowrap"
      />
    </div>
  );
}
