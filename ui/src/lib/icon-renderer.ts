/**
 * Server-side Icon Renderer
 *
 * Generates icon PNGs from an IconConfig.
 * - Letter mode: builds SVG with embedded font, converts via sharp
 * - Upload/emoji/lucide: expects client-rendered PNG blob (stored as-is)
 *
 * Used for:
 * 1. Auto-regenerating the icon when wordart changes (letter mode)
 * 2. Resizing client-uploaded icons to standard favicon sizes
 */

import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import type { IconConfig, IconSize } from "./icon-config";
import { ICON_SIZES } from "./icon-config";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

// Persistent data dir outside the app code so icons survive deploys.
// Falls back to public/branding only if DATA_DIR env is not set.
const BRANDING_DIR = process.env.BRANDING_DATA_DIR
  || join(process.env.DATA_DIR || "/opt/youeye-ui-data", "branding");

/** Build an SVG for letter-mode icon */
function buildLetterSVG(
  letter: string,
  style: SiteNameStyle,
  config: IconConfig,
  size: number
): string {
  const { background, shape } = config;

  // Background
  let bgFill = "none";
  let defs = "";
  if (background.type === "solid" && background.color) {
    bgFill = background.color;
  } else if (background.type === "gradient" && background.gradient) {
    defs += `<linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${background.gradient.from}" />
      <stop offset="100%" stop-color="${background.gradient.to}" />
    </linearGradient>`;
    bgFill = "url(#bg-grad)";
  }

  // Shape
  let shapeEl: string;
  const r = size;
  if (shape === "circle") {
    shapeEl = `<circle cx="${r / 2}" cy="${r / 2}" r="${r / 2}" fill="${bgFill}" />`;
  } else if (shape === "rounded-square") {
    const radius = Math.round(r * 0.2);
    shapeEl = `<rect width="${r}" height="${r}" rx="${radius}" fill="${bgFill}" />`;
  } else {
    shapeEl = `<rect width="${r}" height="${r}" fill="${bgFill}" />`;
  }

  // Text fill (color or gradient from wordart)
  let textFill = style.color || "#ffffff";
  if (style.gradient?.enabled) {
    defs += `<linearGradient id="text-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${style.gradient.from}" />
      <stop offset="100%" stop-color="${style.gradient.to}" />
    </linearGradient>`;
    textFill = "url(#text-grad)";
  }

  // Embed font if available
  let fontFaceCSS = "";
  const fontSlug = style.fontFamily.toLowerCase().replace(/\s+/g, "-");
  const fontDir = join(process.cwd(), "public", "fonts", fontSlug);
  if (existsSync(fontDir)) {
    const fontFiles = readdirSync(fontDir).filter((f) =>
      /\.(ttf|woff2?)$/.test(f)
    );
    if (fontFiles.length > 0) {
      const fontFile = fontFiles[0];
      const fontPath = join(fontDir, fontFile);
      const fontData = readFileSync(fontPath);
      const b64 = fontData.toString("base64");
      const format = fontFile.endsWith(".woff2")
        ? "woff2"
        : fontFile.endsWith(".woff")
          ? "woff"
          : "truetype";
      const mime =
        format === "woff2"
          ? "font/woff2"
          : format === "woff"
            ? "font/woff"
            : "font/ttf";
      fontFaceCSS = `@font-face { font-family: '${style.fontFamily}'; src: url('data:${mime};base64,${b64}') format('${format}'); font-weight: ${style.fontWeight || 400}; }`;
    }
  }

  const fontSize = Math.round(r * 0.55);
  const textTransform = style.textTransform || "none";
  const displayLetter =
    textTransform === "uppercase"
      ? letter.toUpperCase()
      : textTransform === "lowercase"
        ? letter.toLowerCase()
        : letter;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${r}" viewBox="0 0 ${r} ${r}">
  <defs>${defs}</defs>
  ${fontFaceCSS ? `<style>${fontFaceCSS}</style>` : ""}
  ${shapeEl}
  <text x="${r / 2}" y="${r / 2}" text-anchor="middle" dominant-baseline="central"
    font-family="'${style.fontFamily}', sans-serif" font-weight="${style.fontWeight || 700}"
    font-size="${fontSize}" fill="${textFill}"
    letter-spacing="${style.letterSpacing || '0'}">${displayLetter}</text>
</svg>`;
}

/** Render an icon config to PNG files at standard sizes */
export async function renderIconPNGs(
  config: IconConfig,
  siteName: string,
  siteNameStyle: SiteNameStyle | null,
  sourceBlob?: Buffer
): Promise<Record<IconSize, string>> {
  await mkdir(BRANDING_DIR, { recursive: true });
  const sharp = (await import("sharp")).default;

  const results = {} as Record<IconSize, string>;

  if (config.mode === "letter" && siteNameStyle) {
    // Server-side SVG render for letter mode
    const letter = config.letter || siteName?.[0] || "Y";
    for (const size of ICON_SIZES) {
      const svg = buildLetterSVG(letter, siteNameStyle, config, size);
      const pngBuf = await sharp(Buffer.from(svg))
        .resize(size, size)
        .png()
        .toBuffer();
      const filename = `icon-${size}.png`;
      await writeFile(join(BRANDING_DIR, filename), pngBuf);
      results[size] = `/branding/${filename}`;
    }
  } else if (sourceBlob) {
    // Client rendered a PNG — resize to all standard sizes
    for (const size of ICON_SIZES) {
      const pngBuf = await sharp(sourceBlob)
        .resize(size, size, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
      const filename = `icon-${size}.png`;
      await writeFile(join(BRANDING_DIR, filename), pngBuf);
      results[size] = `/branding/${filename}`;
    }
  }

  return results;
}

/** Read a rendered icon PNG by size */
export async function getRenderedIcon(
  size: IconSize
): Promise<Buffer | null> {
  const filepath = join(BRANDING_DIR, `icon-${size}.png`);
  try {
    return await readFile(filepath);
  } catch {
    return null;
  }
}

/** Check if rendered icons exist */
export function hasRenderedIcons(): boolean {
  return existsSync(join(BRANDING_DIR, "icon-32.png"));
}
