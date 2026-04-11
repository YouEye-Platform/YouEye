/**
 * WordArt SVG Generator for Authentik Login Page
 *
 * Converts YE-UI's SiteNameStyle into an SVG image that can be used
 * as the Authentik branding_logo. Embeds the font as base64 data URI
 * so it renders correctly when loaded via <img> tags (which block
 * external resource fetching).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

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

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function applyTransform(text: string, transform?: string): string {
  if (!transform || transform === 'none') return text;
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/\b\w/g, c => c.toUpperCase());
  return text;
}

function gradientCoords(deg: number): { x1: string; y1: string; x2: string; y2: string } {
  // CSS gradient angles are measured clockwise from "up" (north):
  //   0deg = bottom→top, 90deg = left→right, 180deg = top→bottom
  // SVG linearGradient uses (x1,y1)→(x2,y2) coordinate pairs.
  const rad = (deg * Math.PI) / 180;
  return {
    x1: `${Math.round((50 - 50 * Math.sin(rad)) * 100) / 100}%`,
    y1: `${Math.round((50 + 50 * Math.cos(rad)) * 100) / 100}%`,
    x2: `${Math.round((50 + 50 * Math.sin(rad)) * 100) / 100}%`,
    y2: `${Math.round((50 - 50 * Math.cos(rad)) * 100) / 100}%`,
  };
}

/**
 * Try to read a font TTF file and return base64 data URI.
 * Looks in Authentik's static assets first, then falls back to CP's public/fonts.
 */
function loadFontBase64(fontFamily: string): string | null {
  const slug = fontFamily.toLowerCase().replace(/\s+/g, '-');
  const paths = [
    `/web/dist/assets/fonts/${slug}/${slug}-0.ttf`,           // Inside Authentik container (when run via execShell)
    join(process.cwd(), `public/fonts/${slug}/${slug}-0.ttf`), // CP's own fonts directory
  ];

  for (const p of paths) {
    try {
      const data = readFileSync(p);
      return `data:font/ttf;base64,${data.toString('base64')}`;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Generate an SVG image of the site name in the user's WordArt style.
 * The font is embedded as base64 so it renders in <img> tags.
 */
export function generateWordArtSVG(
  siteName: string,
  style?: SiteNameStyle | null
): string {
  const displayText = applyTransform(siteName, style?.textTransform);
  const escaped = escapeXml(displayText);

  const fontFamily = style?.fontFamily || 'Inter';
  const fontWeight = style?.fontWeight || 600;
  const fontSize = 52;
  const letterSpacing = style?.letterSpacing || '0em';

  // SVG dimensions
  const charWidth = fontSize * 0.65;
  const lsNum = parseFloat(letterSpacing) || 0;
  const extraSpacing = lsNum * fontSize * escaped.length;
  const width = Math.max(200, Math.ceil(escaped.length * charWidth + extraSpacing + 60));
  const height = 90;

  // Embed font as base64
  const fontDataUri = loadFontBase64(fontFamily);
  const fontStyle = fontDataUri
    ? `<style>
      @font-face {
        font-family: '${escapeXml(fontFamily)}';
        src: url('${fontDataUri}') format('truetype');
        font-weight: ${fontWeight};
        font-style: normal;
      }
    </style>`
    : '';

  // Gradient or solid fill
  let fill = style?.color || '#000000';
  let gradientDef = '';
  if (style?.gradient?.enabled && style.gradient.from && style.gradient.to) {
    const deg = parseInt(style.gradient.direction?.match(/(\d+)/)?.[1] || '90', 10);
    const coords = gradientCoords(deg);
    gradientDef = `
  <linearGradient id="wordart-grad" x1="${coords.x1}" y1="${coords.y1}" x2="${coords.x2}" y2="${coords.y2}">
    <stop offset="0%" stop-color="${escapeXml(style.gradient.from)}"/>
    <stop offset="100%" stop-color="${escapeXml(style.gradient.to)}"/>
  </linearGradient>`;
    fill = 'url(#wordart-grad)';
  }

  // Shadow filter
  let filterDef = '';
  let filterAttr = '';
  if (style?.textShadow && style.textShadow !== 'none') {
    const match = style.textShadow.match(
      /(-?\d+(?:\.\d+)?)(px)?\s+(-?\d+(?:\.\d+)?)(px)?\s+(\d+(?:\.\d+)?)(px)?\s+(rgba?\([^)]+\)|#[0-9a-fA-F]+)/
    );
    if (match) {
      const dx = parseFloat(match[1]);
      const dy = parseFloat(match[3]);
      const blur = parseFloat(match[5]);
      const color = match[7];
      filterDef = `
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur / 2}" flood-color="${escapeXml(color)}" flood-opacity="1"/>
  </filter>`;
      filterAttr = ' filter="url(#shadow)"';
    }
  }

  // Transform
  let transformAttr = '';
  if (style?.transform && style.transform !== 'none') {
    // Convert CSS transform to SVG transform
    // Handle skewX, scaleX, scaleY, perspective (approximate)
    const skewMatch = style.transform.match(/skewX\((-?\d+(?:\.\d+)?)deg\)/);
    if (skewMatch) {
      transformAttr = ` transform="skewX(${skewMatch[1]})"`;
    }
    const scaleXMatch = style.transform.match(/scaleX\((\d+(?:\.\d+)?)\)/);
    const scaleYMatch = style.transform.match(/scaleY\((\d+(?:\.\d+)?)\)/);
    if (scaleXMatch || scaleYMatch) {
      const sx = scaleXMatch ? parseFloat(scaleXMatch[1]) : 1;
      const sy = scaleYMatch ? parseFloat(scaleYMatch[1]) : 1;
      transformAttr = ` transform="scale(${sx},${sy})"`;
    }
  }

  // Stroke
  let strokeAttrs = '';
  if (style?.textStroke) {
    const strokeMatch = style.textStroke.match(/(\d+)px\s+(.+)/);
    if (strokeMatch) {
      strokeAttrs = ` stroke="${escapeXml(strokeMatch[2])}" stroke-width="${strokeMatch[1]}"`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  ${fontStyle}
  <defs>${gradientDef}${filterDef}
  </defs>
  <g${transformAttr} transform-origin="${width / 2} ${height / 2}">
    <text x="${width / 2}" y="${height * 0.65}"
      text-anchor="middle"
      font-family="'${escapeXml(fontFamily)}', sans-serif"
      font-weight="${fontWeight}"
      font-size="${fontSize}"
      letter-spacing="${letterSpacing}"
      fill="${fill}"${strokeAttrs}${filterAttr}>${escaped}</text>
  </g>
</svg>`;
}
