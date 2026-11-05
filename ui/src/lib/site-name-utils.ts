/**
 * Shared site-name utilities — server-safe (no "use client").
 *
 * Both the client SiteName component and the server-side header config
 * API import from here so the logic is shared without crossing the
 * Next.js client/server boundary.
 */

import type { SiteNameStyle } from "@/lib/db/queries/branding";

/** Font family → local CSS file mapping */
export const FONT_CSS_MAP: Record<string, string> = {
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
  'Bangers': '/fonts/bangers.css',
  'Bebas Neue': '/fonts/bebas-neue.css',
  'Dancing Script': '/fonts/dancing-script.css',
  'Comfortaa': '/fonts/comfortaa.css',
  'Oswald': '/fonts/oswald.css',
  'Titan One': '/fonts/titan-one.css',
  'Black Ops One': '/fonts/black-ops-one.css',
  'Creepster': '/fonts/creepster.css',
  'Monoton': '/fonts/monoton.css',
  'Press Start 2P': '/fonts/press-start-2p.css',
  'Audiowide': '/fonts/audiowide.css',
  'Cinzel': '/fonts/cinzel.css',
  'Great Vibes': '/fonts/great-vibes.css',
  'Quicksand': '/fonts/quicksand.css',
  'Archivo Black': '/fonts/archivo-black.css',
};

/**
 * Convert a SiteNameStyle to a plain CSS properties object + font URL.
 * Used by the header config API to pre-compute CSS for native apps.
 */
export function siteNameStyleToCSS(s: SiteNameStyle): {
  css: Record<string, string | number | undefined>;
  fontUrl: string | null;
} {
  const css: Record<string, string | number | undefined> = {
    fontFamily: `"${s.fontFamily}", sans-serif`,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    letterSpacing: s.letterSpacing,
    textTransform: s.textTransform as string,
    textShadow: s.textShadow !== "none" ? s.textShadow : undefined,
    WebkitTextStroke: s.textStroke || undefined,
    transform: s.transform || undefined,
    display: s.transform ? "inline-block" : undefined,
  };

  if (s.gradient?.enabled) {
    css.color = "transparent";
    css.backgroundImage = `linear-gradient(${s.gradient.direction}, ${s.gradient.from}, ${s.gradient.to})`;
    css.WebkitBackgroundClip = "text";
    css.WebkitTextFillColor = "transparent";
    css.backgroundClip = "text";
  } else {
    css.color = s.color;
  }

  const fontUrl = FONT_CSS_MAP[s.fontFamily] ?? null;

  return { css, fontUrl };
}
