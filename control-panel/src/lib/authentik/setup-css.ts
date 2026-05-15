/**
 * Minimal Authentik CSS generator for the setup wizard.
 *
 * Generates branding CSS that styles the Authentik login page
 * immediately after setup — before the UI has loaded and pushed
 * its full theme CSS via the branding bridge.
 *
 * Uses default shadcn/ui neutral colors and the user's WordArt
 * style from the setup wizard.
 */

interface SiteNameStyle {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: number;
  letterSpacing?: string;
  color?: string;
  gradient?: {
    enabled: boolean;
    from: string;
    to: string;
    direction: string;
  } | null;
  textShadow?: string;
  textTransform?: string;
  textStroke?: string;
  transform?: string;
}

// Default shadcn/ui neutral theme colors (same as YE-UI ships with)
const DEFAULTS = {
  background: '0 0% 100%',
  foreground: '240 10% 3.9%',
  card: '0 0% 100%',
  primary: '240 5.9% 10%',
  primaryForeground: '0 0% 98%',
  secondary: '240 4.8% 95.9%',
  muted: '240 4.8% 95.9%',
  mutedForeground: '240 3.8% 46.1%',
  border: '240 5.9% 90%',
  ring: '240 5.9% 10%',
  // Dark mode
  darkBackground: '240 10% 3.9%',
  darkForeground: '0 0% 98%',
  darkCard: '240 10% 3.9%',
  darkPrimary: '0 0% 98%',
  darkSecondary: '240 3.7% 15.9%',
  darkMuted: '240 3.7% 15.9%',
  darkMutedForeground: '240 5% 64.9%',
  darkBorder: '240 3.7% 15.9%',
  darkRing: '240 4.9% 83.9%',
};

function hsl(value: string): string {
  return `hsl(${value})`;
}

/**
 * Build CSS for ::part(branding)::after pseudo-element.
 * Renders the site name via CSS content property so it matches
 * YE-UI's header pixel-for-pixel.
 */
function buildBrandingAfterCSS(
  s: SiteNameStyle | null | undefined,
  siteName?: string,
): string {
  if (!s && !siteName) return '';

  const name = siteName || 'YouEye';
  const escapedName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [];

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

    if (s.gradient?.enabled) {
      lines.push(`  background: linear-gradient(${s.gradient.direction}, ${s.gradient.from}, ${s.gradient.to}) !important;`);
      lines.push(`  -webkit-background-clip: text !important;`);
      lines.push(`  -webkit-text-fill-color: transparent !important;`);
      lines.push(`  background-clip: text !important;`);
    } else if (s.color) {
      lines.push(`  color: ${s.color} !important;`);
    }

    if ((s as Record<string, unknown>).textStroke) {
      lines.push(`  -webkit-text-stroke: ${(s as Record<string, unknown>).textStroke} !important;`);
    }
    if ((s as Record<string, unknown>).transform) {
      lines.push(`  transform: ${(s as Record<string, unknown>).transform} !important;`);
    }
  } else {
    lines.push(`  font-family: 'Inter', sans-serif !important;`);
    lines.push(`  font-weight: 700 !important;`);
    lines.push(`  font-size: ${fontSize} !important;`);
    lines.push(`  line-height: 1.2 !important;`);
  }

  lines.push(`}`);

  return lines.join('\n');
}

/**
 * Generate minimal Authentik login page CSS for the setup wizard.
 * Matches the structure of YE-UI's generateAuthentikCSS but uses
 * default theme colors so it works before the UI has loaded.
 */
export function generateSetupAuthentikCSS(
  siteNameStyle?: SiteNameStyle | null,
  domain?: string,
  siteName?: string,
  fontFileFormat?: 'woff2' | 'truetype',
  fontFiles?: string[],
): string {
  const c = DEFAULTS;
  const fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Inline @font-face declarations pointing to Authentik's static directory.
  // Font files must be copied into Authentik by the setup route.
  const fontSlug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
  const imports: string[] = [];

  // Always include Inter (ships as .ttf)
  const interWeights = [400, 500, 600, 700];
  for (const w of interWeights) {
    imports.push(`@font-face { font-family: 'Inter'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(/static/dist/assets/fonts/inter/inter-${interWeights.indexOf(w)}.ttf) format('truetype'); }`);
  }

  if (siteNameStyle?.fontFamily && siteNameStyle.fontFamily !== 'Inter') {
    const slug = fontSlug(siteNameStyle.fontFamily);
    const fmt = fontFileFormat || 'truetype';
    const allFiles = fontFiles ?? [`${slug}-0.${fmt === 'woff2' ? 'woff2' : 'ttf'}`];
    for (const file of allFiles) {
      const fileFmt = file.endsWith('.woff2') ? 'woff2' : 'truetype';
      imports.push(`@font-face { font-family: '${siteNameStyle.fontFamily}'; font-style: normal; font-weight: ${siteNameStyle.fontWeight || 400}; font-display: swap; src: url(/static/dist/assets/fonts/${slug}/${file}) format('${fileFmt}'); }`);
    }
  }

  const brandingAfterCSS = buildBrandingAfterCSS(siteNameStyle, siteName);

  return `${imports.join('\n')}

/* YouEye Authentik Theme (setup defaults) */
:root {
  --pf-global--FontFamily--sans-serif: ${fontFamily} !important;
  --pf-global--FontFamily--heading--sans-serif: ${fontFamily} !important;
  --pf-global--primary-color--100: ${hsl(c.primary)} !important;
  --pf-global--primary-color--200: ${hsl(c.ring)} !important;
  --pf-global--BackgroundColor--100: ${hsl(c.background)} !important;
  --pf-global--BackgroundColor--200: ${hsl(c.secondary)} !important;
  --pf-global--Color--100: ${hsl(c.foreground)} !important;
  --pf-global--Color--200: ${hsl(c.mutedForeground)} !important;
  --pf-global--BorderColor--100: ${hsl(c.border)} !important;
  --pf-global--BorderRadius--sm: 0.5rem !important;
  --pf-global--BorderRadius--lg: 0.75rem !important;
  --pf-global--link--Color: ${hsl(c.primary)} !important;
  --pf-global--link--Color--hover: ${hsl(c.primary)} !important;
  --ak-accent: ${hsl(c.primary)} !important;
  --ak-font-family-sans-serif: ${fontFamily} !important;
}

[data-theme='dark'] {
  --pf-global--primary-color--100: ${hsl(c.darkPrimary)} !important;
  --pf-global--primary-color--200: ${hsl(c.darkRing)} !important;
  --pf-global--BackgroundColor--100: ${hsl(c.darkBackground)} !important;
  --pf-global--BackgroundColor--200: ${hsl(c.darkSecondary)} !important;
  --pf-global--Color--100: ${hsl(c.darkForeground)} !important;
  --pf-global--Color--200: ${hsl(c.darkMutedForeground)} !important;
  --pf-global--BorderColor--100: ${hsl(c.darkBorder)} !important;
  --pf-global--link--Color: ${hsl(c.darkPrimary)} !important;
  --pf-global--link--Color--hover: ${hsl(c.darkPrimary)} !important;
  --ak-accent: ${hsl(c.darkPrimary)} !important;
}

.pf-c-background-image,
.pf-c-background-image::before {
  display: none !important;
}

.pf-c-login {
  background: linear-gradient(135deg, ${hsl(c.background)}, ${hsl(c.secondary)}, ${hsl(c.muted)}) !important;
  min-height: 100vh !important;
}

[data-theme='dark'] .pf-c-login {
  background: linear-gradient(135deg, ${hsl(c.darkBackground)}, ${hsl(c.darkSecondary)}, ${hsl(c.darkMuted)}) !important;
}

@keyframes ye-gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.pf-c-login {
  background-size: 200% 200% !important;
  animation: ye-gradient-shift 15s ease infinite !important;
}

ak-flow-executor::part(main) {
  border-radius: 1rem !important;
  border: 1px solid color-mix(in srgb, ${hsl(c.border)} 40%, transparent) !important;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25) !important;
  backdrop-filter: blur(16px) !important;
  background: color-mix(in srgb, ${hsl(c.card)} 90%, transparent) !important;
  overflow: hidden !important;
}

[data-theme='dark'] ak-flow-executor::part(main) {
  border: 1px solid color-mix(in srgb, ${hsl(c.darkBorder)} 40%, transparent) !important;
  background: color-mix(in srgb, ${hsl(c.darkCard)} 90%, transparent) !important;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5) !important;
}

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
  ${siteNameStyle?.gradient?.enabled ? '' : `color: ${siteNameStyle?.color ?? hsl(c.darkForeground)} !important;`}
}

ak-flow-executor::part(locale-select) {
  opacity: 0.7 !important;
}

ak-brand-links::part(list) {
  opacity: 0.6 !important;
}`.trim();
}
