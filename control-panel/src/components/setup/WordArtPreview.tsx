'use client';

import { useMemo, useEffect, useRef, CSSProperties } from 'react';
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
      WebkitTextStroke: style.textStroke || 'unset',
      transform: style.transform || undefined,
      display: 'inline-block', // needed for transform to apply
      backfaceVisibility: 'hidden', // force compositor layer for reliable background-clip
    };
    // Use backgroundImage (not background shorthand) to avoid resetting background-clip.
    // The background shorthand resets all sub-properties including background-clip;
    // when React skips re-applying backgroundClip (because its value didn't change),
    // the clip gets lost and the gradient renders as a box instead of clipped to text.
    if (style.gradient?.enabled) {
      return {
        ...base,
        color: 'transparent',
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      };
    }
    return {
      ...base,
      color: style.color,
      backgroundImage: 'none',
      WebkitBackgroundClip: 'initial',
      WebkitTextFillColor: style.color,
      backgroundClip: 'initial',
    };
  }, [style, sizeOverride]);

  // Imperatively enforce background-clip after every render.
  // React's style reconciliation skips re-applying backgroundClip when its value
  // hasn't changed ('text' → 'text'), but the browser resets it when the background
  // shorthand is updated internally. This useEffect guarantees the clip is correct.
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spanRef.current;
    if (el && style.gradient?.enabled) {
      el.style.backgroundClip = 'text';
      el.style.setProperty('-webkit-background-clip', 'text');
    }
  });

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <span ref={spanRef} style={cssStyle}>{name || 'YouEye'}</span>
    </div>
  );
}
