/**
 * Server Name WordArt Widget
 *
 * Displays the instance name prominently with WordArt styling.
 * Text is fit-to-width: it always fills the container's full width,
 * and height auto-adjusts to match. Resize the widget wider → text
 * gets bigger. The box always hugs the text tightly.
 */

"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { SiteName } from "@/components/layout/site-name";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

interface ServerNameWidgetProps {
  settings?: Record<string, unknown>;
  onAutoSize?: (size: { height: number }) => void;
}

const DEFAULT_WIDGET_STYLE: SiteNameStyle = {
  fontFamily: "Inter",
  fontSize: "48px",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

export function ServerNameWidget({ settings, onAutoSize }: ServerNameWidgetProps) {
  const [siteName, setSiteName] = useState<string>("");
  const [adminStyle, setAdminStyle] = useState<SiteNameStyle | null>(null);
  const [userOverride, setUserOverride] = useState<SiteNameStyle | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fitSize, setFitSize] = useState(48);
  const containerRef = useRef<HTMLDivElement>(null);
  const onAutoSizeRef = useRef(onAutoSize);
  onAutoSizeRef.current = onAutoSize;

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

  const baseStyle = userOverride ?? adminStyle ?? DEFAULT_WIDGET_STYLE;

  // Fit text to container width and report ideal height
  const fitText = useCallback(() => {
    const container = containerRef.current;
    if (!container || !loaded || !siteName) return;

    const h1 = container.querySelector("h1");
    if (!h1) return;

    const cw = container.clientWidth;
    if (cw <= 0) return;

    const currentSize = parseFloat(getComputedStyle(h1).fontSize);
    const rect = h1.getBoundingClientRect();
    const textW = rect.width;

    if (textW <= 0 || currentSize <= 0) return;

    const newSize = Math.max(12, Math.min(currentSize * (cw / textW) * 0.98, 500));
    setFitSize(newSize);

    // Report ideal height after the font size settles
    requestAnimationFrame(() => {
      const h1After = container.querySelector("h1");
      if (h1After) {
        const textH = h1After.getBoundingClientRect().height;
        onAutoSizeRef.current?.({ height: Math.ceil(textH) + 4 });
      }
    });
  }, [loaded, siteName]);

  // Observe container for resize (user drags width)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !loaded || !siteName) return;

    const observer = new ResizeObserver(fitText);
    observer.observe(container);
    document.fonts.ready.then(fitText);
    fitText();

    return () => observer.disconnect();
  }, [fitText]);

  const displayStyle: SiteNameStyle = {
    ...baseStyle,
    fontSize: `${fitSize}px`,
  };

  if (!loaded || !siteName) return null;

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center overflow-visible">
      <SiteName
        name={siteName}
        style={displayStyle}
        as="h1"
        className="whitespace-nowrap leading-none"
      />
    </div>
  );
}
