/**
 * Font Preload
 *
 * Server component that loads the site name font CSS to prevent FOUT
 * (Flash Of Unstyled Text). Include this in the layout to ensure the
 * font stylesheet is in the initial HTML, loaded before React hydrates.
 */

import { getBranding } from "@/lib/db/queries/branding";
import { FONT_CSS_MAP } from "./site-name";

export async function FontPreload() {
  try {
    const branding = await getBranding();
    const fontFamily = branding.site_name_style?.fontFamily ?? "Inter";
    const cssPath = FONT_CSS_MAP[fontFamily];

    if (!cssPath) return null;

    // Render stylesheet link directly - browser will load it before hydration
    // Using data-font-preload to identify these for cleanup if needed
    return (
      <link
        rel="stylesheet"
        href={cssPath}
        data-font-preload={fontFamily}
      />
    );
  } catch {
    // During build (no database) or on error, return null
    // The client-side SiteName component will load the font as fallback
    return null;
  }
}

/**
 * Font stylesheet link for a specific font family.
 * Use when you know the font family ahead of time (e.g., user override).
 */
export function FontPreloadLink({ fontFamily }: { fontFamily: string }) {
  const cssPath = FONT_CSS_MAP[fontFamily];
  if (!cssPath) return null;

  return (
    <link
      rel="stylesheet"
      href={cssPath}
      data-font-preload={fontFamily}
    />
  );
}
