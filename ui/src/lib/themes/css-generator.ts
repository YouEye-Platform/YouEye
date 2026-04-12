/**
 * CSS Variable Generator
 *
 * Generates CSS custom properties from ThemeColors for:
 * 1. Inline injection into <html> (runtime theme switching)
 * 2. shadcn/ui CSS variable override strings
 * 3. Authentik login page styling
 */

import type { ThemeColors } from "@/db/schema";

/**
 * Generate CSS custom properties string from theme colors.
 * Returns both :root (light) and .dark sections as a complete CSS block.
 *
 * This is injected as a <style> tag or applied directly to the <html> element.
 */
export function generateCSSVariables(colors: ThemeColors): string {
  return `:root {
  --background: ${colors.background};
  --foreground: ${colors.foreground};
  --card: ${colors.card};
  --card-foreground: ${colors.cardForeground};
  --popover: ${colors.popover};
  --popover-foreground: ${colors.popoverForeground};
  --primary: ${colors.primary};
  --primary-foreground: ${colors.primaryForeground};
  --secondary: ${colors.secondary};
  --secondary-foreground: ${colors.secondaryForeground};
  --muted: ${colors.muted};
  --muted-foreground: ${colors.mutedForeground};
  --accent: ${colors.accent};
  --accent-foreground: ${colors.accentForeground};
  --destructive: ${colors.destructive};
  --destructive-foreground: ${colors.destructiveForeground};
  --border: ${colors.border};
  --input: ${colors.input};
  --ring: ${colors.ring};
}
.dark {
  --background: ${colors.darkBackground};
  --foreground: ${colors.darkForeground};
  --card: ${colors.darkCard};
  --card-foreground: ${colors.darkCardForeground};
  --popover: ${colors.darkPopover};
  --popover-foreground: ${colors.darkPopoverForeground};
  --primary: ${colors.darkPrimary};
  --primary-foreground: ${colors.darkPrimaryForeground};
  --secondary: ${colors.darkSecondary};
  --secondary-foreground: ${colors.darkSecondaryForeground};
  --muted: ${colors.darkMuted};
  --muted-foreground: ${colors.darkMutedForeground};
  --accent: ${colors.darkAccent};
  --accent-foreground: ${colors.darkAccentForeground};
  --destructive: ${colors.darkDestructive};
  --destructive-foreground: ${colors.darkDestructiveForeground};
  --border: ${colors.darkBorder};
  --input: ${colors.darkInput};
  --ring: ${colors.darkRing};
}`;
}

/**
 * Generate a flat map of CSS variable name → value for inline style injection.
 * Used by the ThemeProvider to set CSS variables directly on the <html> element.
 */
export function generateCSSVariableMap(
  colors: ThemeColors,
  mode: "light" | "dark"
): Record<string, string> {
  if (mode === "dark") {
    return {
      "--background": colors.darkBackground,
      "--foreground": colors.darkForeground,
      "--card": colors.darkCard,
      "--card-foreground": colors.darkCardForeground,
      "--popover": colors.darkPopover,
      "--popover-foreground": colors.darkPopoverForeground,
      "--primary": colors.darkPrimary,
      "--primary-foreground": colors.darkPrimaryForeground,
      "--secondary": colors.darkSecondary,
      "--secondary-foreground": colors.darkSecondaryForeground,
      "--muted": colors.darkMuted,
      "--muted-foreground": colors.darkMutedForeground,
      "--accent": colors.darkAccent,
      "--accent-foreground": colors.darkAccentForeground,
      "--destructive": colors.darkDestructive,
      "--destructive-foreground": colors.darkDestructiveForeground,
      "--border": colors.darkBorder,
      "--input": colors.darkInput,
      "--ring": colors.darkRing,
    };
  }

  return {
    "--background": colors.background,
    "--foreground": colors.foreground,
    "--card": colors.card,
    "--card-foreground": colors.cardForeground,
    "--popover": colors.popover,
    "--popover-foreground": colors.popoverForeground,
    "--primary": colors.primary,
    "--primary-foreground": colors.primaryForeground,
    "--secondary": colors.secondary,
    "--secondary-foreground": colors.secondaryForeground,
    "--muted": colors.muted,
    "--muted-foreground": colors.mutedForeground,
    "--accent": colors.accent,
    "--accent-foreground": colors.accentForeground,
    "--destructive": colors.destructive,
    "--destructive-foreground": colors.destructiveForeground,
    "--border": colors.border,
    "--input": colors.input,
    "--ring": colors.ring,
  };
}

/**
 * Generate a compact CSS variable string for the header config API.
 * This is consumed by native apps (Wiki, Search) to apply the theme.
 */
export function generateCompactCSS(colors: ThemeColors): string {
  const lightVars = Object.entries(generateCSSVariableMap(colors, "light"))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const darkVars = Object.entries(generateCSSVariableMap(colors, "dark"))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  return `${lightVars} [dark] ${darkVars}`;
}

/**
 * Authentik Branding CSS Configuration
 *
 * Passed alongside ThemeColors to generate the login page CSS.
 */
export interface AuthentikBrandingConfig {
  siteNameStyle?: SiteNameStyle | null;
  fontUrl?: string;
  /** Site name to render via ::after pseudo-element (replaces SVG logo) */
  siteName?: string;
  /** Font file format for the branding font ('woff2' or 'truetype'). Defaults to 'truetype'. */
  fontFileFormat?: 'woff2' | 'truetype';
  /** List of font filenames for the branding font (e.g. ['font-0.woff2', 'font-1.woff2']) */
  fontFiles?: string[];
}

interface SiteNameStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: number;
  letterSpacing: string;
  color: string;
  gradient: {
    enabled: boolean;
    from: string;
    to: string;
    direction: string;
  } | null;
  textShadow: string;
  textTransform: string;
  textStroke?: string;
  transform?: string;
  charShapeId?: string;
  charShapeIntensity?: number;
}

/**
 * Generate Authentik login page custom CSS.
 *
 * Uses ::part() selectors to pierce Shadow DOM (Authentik 2025.12.x Lit components)
 * and PatternFly/Authentik CSS variables for form elements inside Shadow DOM.
 * Uses [data-theme='dark'] / [data-theme='light'] for mode switching (NOT @media prefers-color-scheme).
 */
export function generateAuthentikCSS(
  colors: ThemeColors,
  branding?: AuthentikBrandingConfig
): string {
  const s = branding?.siteNameStyle;
  const fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Inline @font-face declarations directly in the CSS.
  // Font files must be copied into Authentik's /web/dist/assets/fonts/ directory
  // by the bridge endpoint — see ui-bridge/authentik/branding/route.ts.
  const fontFaces: string[] = [];

  // Always include Inter (ships as .ttf)
  const interWeights = [400, 500, 600, 700];
  for (const w of interWeights) {
    fontFaces.push(`@font-face { font-family: 'Inter'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(/static/dist/assets/fonts/inter/inter-${interWeights.indexOf(w)}.ttf) format('truetype'); }`);
  }

  // Include the branding font if different from Inter.
  // Each woff2 file covers a specific unicode range, so we load ALL files
  // to ensure the font works for any character set (latin, cyrillic, etc.).
  if (s?.fontFamily && s.fontFamily !== 'Inter') {
    const slug = s.fontFamily.toLowerCase().replace(/\s+/g, '-');
    const fmt = branding?.fontFileFormat || 'truetype';
    const files = branding?.fontFiles ?? [`${slug}-0.${fmt === 'woff2' ? 'woff2' : 'ttf'}`];
    for (const file of files) {
      const fileFmt = file.endsWith('.woff2') ? 'woff2' : 'truetype';
      fontFaces.push(`@font-face { font-family: '${s.fontFamily}'; font-style: normal; font-weight: ${s.fontWeight || 400}; font-display: swap; src: url(/static/dist/assets/fonts/${slug}/${file}) format('${fileFmt}'); }`);
    }
  }

  const imports = fontFaces;

  // Build WordArt / branding CSS for ::part(branding)::after pseudo-element.
  // Authentik renders branding_logo as an <img> inside ::part(branding).
  // We can't target the <img> child through ::part(), so we:
  //   1. Make the branding container hide its children (font-size: 0, the img is transparent)
  //   2. Use ::after with content: "SiteName" to render the WordArt via pure CSS
  // This guarantees pixel-perfect matching with YouEye's header since it's the same CSS engine.
  const brandingAfterCSS = buildBrandingAfterCSS(s, branding?.siteName);

  return `${imports.join('\n')}

/* ─── YouEye Authentik Theme (2025.12.x) ─── */
/* CSS variables that pierce Shadow DOM — LIGHT mode */
:root {
  --pf-global--FontFamily--sans-serif: ${fontFamily} !important;
  --pf-global--FontFamily--heading--sans-serif: ${fontFamily} !important;
  --pf-global--primary-color--100: ${colors.primary} !important;
  --pf-global--primary-color--200: ${colors.ring} !important;
  --pf-global--BackgroundColor--100: ${colors.background} !important;
  --pf-global--BackgroundColor--200: ${colors.secondary} !important;
  --pf-global--Color--100: ${colors.foreground} !important;
  --pf-global--Color--200: ${colors.mutedForeground} !important;
  --pf-global--BorderColor--100: ${colors.border} !important;
  --pf-global--BorderRadius--sm: 0.5rem !important;
  --pf-global--BorderRadius--lg: 0.75rem !important;
  --pf-global--link--Color: ${colors.primary} !important;
  --pf-global--link--Color--hover: ${colors.primary} !important;
  --ak-accent: ${colors.primary} !important;
  --ak-font-family-sans-serif: ${fontFamily} !important;
}

/* DARK mode overrides via [data-theme] attribute */
[data-theme='dark'] {
  --pf-global--primary-color--100: ${colors.darkPrimary} !important;
  --pf-global--primary-color--200: ${colors.darkRing} !important;
  --pf-global--BackgroundColor--100: ${colors.darkBackground} !important;
  --pf-global--BackgroundColor--200: ${colors.darkSecondary} !important;
  --pf-global--Color--100: ${colors.darkForeground} !important;
  --pf-global--Color--200: ${colors.darkMutedForeground} !important;
  --pf-global--BorderColor--100: ${colors.darkBorder} !important;
  --pf-global--link--Color: ${colors.darkPrimary} !important;
  --pf-global--link--Color--hover: ${colors.darkPrimary} !important;
  --ak-accent: ${colors.darkPrimary} !important;
}

/* Hide default background image — light DOM */
.pf-c-background-image,
.pf-c-background-image::before {
  display: none !important;
}

/* Full-page gradient background — light DOM (.pf-c-login is on ak-flow-executor) */
.pf-c-login {
  background: linear-gradient(135deg, ${colors.background}, ${colors.secondary}, ${colors.muted}) !important;
  min-height: 100vh !important;
}

[data-theme='dark'] .pf-c-login {
  background: linear-gradient(135deg, ${colors.darkBackground}, ${colors.darkSecondary}, ${colors.darkMuted}) !important;
}

/* Subtle animated gradient shift */
@keyframes ye-gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.pf-c-login {
  background-size: 200% 200% !important;
  animation: ye-gradient-shift 15s ease infinite !important;
}

/* Login card — via ::part(main) (Shadow DOM) */
ak-flow-executor::part(main) {
  border-radius: 1rem !important;
  border: 1px solid color-mix(in srgb, ${colors.border} 40%, transparent) !important;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25) !important;
  backdrop-filter: blur(16px) !important;
  background: color-mix(in srgb, ${colors.card} 90%, transparent) !important;
  overflow: hidden !important;
}

[data-theme='dark'] ak-flow-executor::part(main) {
  border: 1px solid color-mix(in srgb, ${colors.darkBorder} 40%, transparent) !important;
  background: color-mix(in srgb, ${colors.darkCard} 90%, transparent) !important;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5) !important;
}

/* Branding/logo area — via ::part(branding) (Shadow DOM)
   The SVG logo <img> is needed for the Authentik dashboard sidebar.
   On the login flow, we hide the img via visibility:hidden on the
   parent and visibility:visible on ::after for pixel-perfect WordArt. */
ak-flow-executor::part(branding) {
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  align-items: center !important;
  padding: 2rem 2rem !important;
  visibility: hidden !important;
}

${brandingAfterCSS}

[data-theme='dark'] ak-flow-executor::part(branding)::after {
  ${s?.gradient?.enabled ? '' : `color: ${s?.color ?? colors.darkForeground} !important;`}
}

/* Locale selector styling */
ak-flow-executor::part(locale-select) {
  opacity: 0.7 !important;
}

/* Footer links */
ak-brand-links::part(list) {
  opacity: 0.6 !important;
}

/* Force font download by referencing it in the light DOM.
   Shadow DOM @font-face rules are global but the browser only downloads
   the font file when text using that font is actually rendered.
   This hidden element ensures the font file is fetched before the
   shadow DOM branding text needs it. */
body::before {
  content: '\\200B';
  font-family: ${s?.fontFamily ? `'${s.fontFamily}', ` : ''}'Inter', sans-serif !important;
  font-weight: ${s?.fontWeight || 400} !important;
  position: absolute !important;
  width: 0 !important;
  height: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
`.trim();
}

/**
 * Build the ::part(branding)::after CSS block.
 *
 * Uses a CSS pseudo-element with `content: "SiteName"` to render
 * the WordArt via pure CSS. This guarantees pixel-perfect matching
 * with YE-UI's <SiteName> component since it uses the identical
 * CSS properties (font, gradient, shadow, transform, stroke).
 *
 * The branding_logo SVG is kept for the dashboard sidebar header.
 * On the login flow, visibility:hidden hides the <img> and
 * visibility:visible on ::after renders the WordArt.
 */
function buildBrandingAfterCSS(
  s: SiteNameStyle | null | undefined,
  siteName?: string,
): string {
  // If no style and no site name, nothing to render
  if (!s && !siteName) return '';

  const name = siteName || 'YouEye';
  const lines: string[] = [];

  // Escape the site name for CSS content property
  const escapedName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Dynamic font-size: large for short names, scales down for longer ones
  const len = name.length;
  const maxRem = len <= 4 ? 4 : len <= 6 ? 3.5 : len <= 10 ? 3 : len <= 16 ? 2.5 : 2;
  const minRem = Math.max(maxRem - 1, 1.5);
  const fontSize = `clamp(${minRem}rem, ${Math.round(maxRem * 2.5)}vw, ${maxRem}rem)`;

  lines.push(`ak-flow-executor::part(branding)::after {`);
  lines.push(`  content: "${escapedName}" !important;`);
  lines.push(`  display: block !important;`);
  lines.push(`  visibility: visible !important;`);
  lines.push(`  width: 100% !important;`);
  lines.push(`  text-align: center !important;`);

  if (s) {
    lines.push(`  font-family: '${s.fontFamily || 'Inter'}', sans-serif !important;`);
    lines.push(`  font-weight: ${s.fontWeight || 700} !important;`);
    lines.push(`  font-size: ${fontSize} !important;`);
    lines.push(`  line-height: 1.2 !important;`);

    if (s.letterSpacing && s.letterSpacing !== '0em') {
      lines.push(`  letter-spacing: ${s.letterSpacing} !important;`);
    }
    if (s.textTransform && s.textTransform !== 'none') {
      lines.push(`  text-transform: ${s.textTransform} !important;`);
    }
    if (s.textShadow && s.textShadow !== 'none') {
      lines.push(`  text-shadow: ${s.textShadow} !important;`);
    }

    // Gradient text
    if (s.gradient?.enabled) {
      lines.push(`  background: linear-gradient(${s.gradient.direction}, ${s.gradient.from}, ${s.gradient.to}) !important;`);
      lines.push(`  -webkit-background-clip: text !important;`);
      lines.push(`  -webkit-text-fill-color: transparent !important;`);
      lines.push(`  background-clip: text !important;`);
    } else if (s.color) {
      lines.push(`  color: ${s.color} !important;`);
    }

    if (s.textStroke) {
      lines.push(`  -webkit-text-stroke: ${s.textStroke} !important;`);
    }
    if (s.transform) {
      lines.push(`  transform: ${s.transform} !important;`);
    }
  } else {
    // No style — render with defaults
    lines.push(`  font-family: 'Inter', sans-serif !important;`);
    lines.push(`  font-weight: 700 !important;`);
    lines.push(`  font-size: ${fontSize} !important;`);
    lines.push(`  line-height: 1.2 !important;`);
  }

  lines.push(`}`);

  return lines.join('\n');
}
