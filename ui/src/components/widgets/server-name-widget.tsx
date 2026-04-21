/**
 * Server Name WordArt Widget
 *
 * Displays the instance name prominently with WordArt styling,
 * like a search engine logo on the homepage. Uses the user's
 * personal wordart override if set, otherwise falls back to
 * the admin's branding style.
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
  fontSize: "clamp(2.5rem, 5vw, 4rem)",
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

  // Scale up for prominent widget display
  const displayStyle = useMemo((): SiteNameStyle => {
    return {
      ...baseStyle,
      fontSize: "clamp(2.5rem, 5vw, 4rem)",
    };
  }, [baseStyle]);

  if (!loaded || !siteName) return null;

  return (
    <div className="flex h-full items-center justify-center">
      <SiteName name={siteName} style={displayStyle} as="h1" />
    </div>
  );
}
