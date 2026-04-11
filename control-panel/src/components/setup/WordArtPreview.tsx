'use client';

import { useMemo, useEffect, CSSProperties } from 'react';
import type { SiteNameStyle } from '@/lib/wordart-presets';

/** Font family → local CSS file mapping */
const FONT_CSS_MAP: Record<string, string> = {
  'Montserrat': '/fonts/montserrat.css',
  'Playfair Display': '/fonts/playfair-display.css',
  'Inter': '/fonts/inter.css',
  'Poppins': '/fonts/poppins.css',
  'Space Grotesk': '/fonts/space-grotesk.css',
  'JetBrains Mono': '/fonts/jetbrains-mono.css',
  'Raleway': '/fonts/raleway.css',
  'Caveat': '/fonts/caveat.css',
  'Outfit': '/fonts/outfit.css',
  'Plus Jakarta Sans': '/fonts/plus-jakarta-sans.css',
  'Lobster': '/fonts/lobster.css',
  'Permanent Marker': '/fonts/permanent-marker.css',
  'Orbitron': '/fonts/orbitron.css',
  'Abril Fatface': '/fonts/abril-fatface.css',
  'Pacifico': '/fonts/pacifico.css',
  'Bungee': '/fonts/bungee.css',
  'Russo One': '/fonts/russo-one.css',
  'Fredoka': '/fonts/fredoka.css',
  'Satisfy': '/fonts/satisfy.css',
  'Righteous': '/fonts/righteous.css',
};

/** Load a font via local self-hosted CSS (idempotent) */
export function useGoogleFont(fontFamily: string) {
  useEffect(() => {
    const id = `gf-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;
    const cssPath = FONT_CSS_MAP[fontFamily];
    if (!cssPath) return; // Unknown font, skip
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
  }, [fontFamily]);
}

/** Preload all setup fonts at once */
export function usePreloadAllFonts() {
  useEffect(() => {
    Object.entries(FONT_CSS_MAP).forEach(([family, cssPath]) => {
      const id = `gf-${family.replace(/\s+/g, '-')}`;
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = cssPath;
      document.head.appendChild(link);
    });
  }, []);
}

interface Props {
  name: string;
  style: SiteNameStyle;
  sizeOverride?: string;
  className?: string;
  showReflection?: boolean;
}

export default function WordArtPreview({ name, style, sizeOverride, className = '' }: Props) {
  useGoogleFont(style.fontFamily);

  const cssStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`,
      fontSize: sizeOverride || style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties['textTransform'],
      textShadow: style.textShadow === 'none' ? undefined : style.textShadow,
      lineHeight: 1.2,
      WebkitTextStroke: style.textStroke || undefined,
      transform: style.transform || undefined,
      display: 'inline-block', // needed for transform to apply
    };
    if (style.gradient?.enabled) {
      return {
        ...base,
        background: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      };
    }
    return { ...base, color: style.color };
  }, [style, sizeOverride]);

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <span style={cssStyle}>{name || 'YouEye'}</span>
    </div>
  );
}
