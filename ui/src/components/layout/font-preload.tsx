/**
 * Font Preload
 *
 * Server component that preloads the site name font to prevent FOUT
 * (Flash Of Unstyled Text). Includes both:
 * - <link rel="preload" as="font"> for the font file (critical)
 * - <link rel="stylesheet"> for the CSS
 *
 * The font file preload is essential to eliminate flicker.
 */

import { getBranding } from "@/lib/db/queries/branding";
import { FONT_CSS_MAP } from "./site-name";

/**
 * Map of font family → primary font file path (weight 400 or 700 depending on typical site name use).
 * Most site names use weight 400-700, so we preload the most common weight.
 */
const FONT_FILE_MAP: Record<string, string> = {
  'Inter': '/fonts/inter/inter-4.ttf',  // weight 700
  'Montserrat': '/fonts/montserrat/montserrat-4.ttf',  // weight 700
  'Playfair Display': '/fonts/playfair-display/playfair-display-4.ttf',
  'Poppins': '/fonts/poppins/poppins-4.ttf',
  'Space Grotesk': '/fonts/space-grotesk/space-grotesk-4.ttf',
  'JetBrains Mono': '/fonts/jetbrains-mono/jetbrains-mono-4.ttf',
  'Raleway': '/fonts/raleway/raleway-4.ttf',
  'Caveat': '/fonts/caveat/caveat-4.ttf',
  'Outfit': '/fonts/outfit/outfit-4.ttf',
  'Plus Jakarta Sans': '/fonts/plus-jakarta-sans/plus-jakarta-sans-4.ttf',
  'Lobster': '/fonts/lobster/lobster-0.ttf',  // single weight
  'Permanent Marker': '/fonts/permanent-marker/permanent-marker-0.ttf',
  'Orbitron': '/fonts/orbitron/orbitron-4.ttf',
  'Abril Fatface': '/fonts/abril-fatface/abril-fatface-0.ttf',
  'Pacifico': '/fonts/pacifico/pacifico-0.ttf',
  'Bungee': '/fonts/bungee/bungee-0.ttf',
  'Russo One': '/fonts/russo-one/russo-one-0.ttf',
  'Fredoka': '/fonts/fredoka/fredoka-4.ttf',
  'Satisfy': '/fonts/satisfy/satisfy-0.ttf',
  'Righteous': '/fonts/righteous/righteous-0.ttf',
  'Bangers': '/fonts/bangers/bangers-0.ttf',
  'Bebas Neue': '/fonts/bebas-neue/bebas-neue-0.ttf',
  'Dancing Script': '/fonts/dancing-script/dancing-script-4.ttf',
  'Comfortaa': '/fonts/comfortaa/comfortaa-4.ttf',
  'Oswald': '/fonts/oswald/oswald-4.ttf',
  'Titan One': '/fonts/titan-one/titan-one-0.ttf',
  'Black Ops One': '/fonts/black-ops-one/black-ops-one-0.ttf',
  'Creepster': '/fonts/creepster/creepster-0.woff2',  // woff2 format
  'Monoton': '/fonts/monoton/monoton-0.ttf',
  'Press Start 2P': '/fonts/press-start-2p/press-start-2p-0.ttf',
  'Audiowide': '/fonts/audiowide/audiowide-0.ttf',
  'Cinzel': '/fonts/cinzel/cinzel-4.ttf',
  'Great Vibes': '/fonts/great-vibes/great-vibes-0.ttf',
  'Quicksand': '/fonts/quicksand/quicksand-4.ttf',
  'Archivo Black': '/fonts/archivo-black/archivo-black-0.ttf',
};

export async function FontPreload() {
  try {
    const branding = await getBranding();
    const fontFamily = branding.site_name_style?.fontFamily ?? "Inter";
    const cssPath = FONT_CSS_MAP[fontFamily];
    const fontPath = FONT_FILE_MAP[fontFamily];

    if (!cssPath) return null;

    // Preload font file first (critical for eliminating flicker),
    // then load CSS (which references the font)
    const fontType = fontPath?.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';

    return (
      <>
        {fontPath && (
          <link
            rel="preload"
            href={fontPath}
            as="font"
            type={fontType}
            crossOrigin="anonymous"
          />
        )}
        <link
          rel="stylesheet"
          href={cssPath}
          data-font-preload={fontFamily}
        />
      </>
    );
  } catch {
    // During build (no database) or on error, return null
    // The client-side SiteName component will load the font as fallback
    return null;
  }
}

/**
 * Font preload for a specific font family.
 * Use when you know the font family ahead of time (e.g., user override).
 */
export function FontPreloadLink({ fontFamily }: { fontFamily: string }) {
  const cssPath = FONT_CSS_MAP[fontFamily];
  const fontPath = FONT_FILE_MAP[fontFamily];

  if (!cssPath) return null;

  const fontType = fontPath?.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';

  return (
    <>
      {fontPath && (
        <link
          rel="preload"
          href={fontPath}
          as="font"
          type={fontType}
          crossOrigin="anonymous"
        />
      )}
      <link
        rel="stylesheet"
        href={cssPath}
        data-font-preload={fontFamily}
      />
    </>
  );
}
