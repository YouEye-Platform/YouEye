import type { Design, Theme, View } from "./design";
import { getFont } from "./fonts";
import { fontForText } from "./coverage";
import icons from "./icons.json";
import opentype from "../vendor/opentype/index.js";
export const iconPaths = icons as Record<string, string>;
export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const num = (n: number) => Number(n.toFixed(3));
function lettering(text: string, fontId: string, tracking: number) {
  const font = getFont(fontId);
  if (!font) return null;
  const path = new opentype.Path();
  let x = 0;
  if (
    Array.from(text.normalize("NFC")).some(
      (c) => c.trim() && !font.charToGlyphIndex(c),
    )
  )
    return null;
  const glyphs = font.stringToGlyphs(text.normalize("NFC"));
  glyphs.forEach((g, i) => {
    path.extend(g.getPath(x, 0, 100).commands);
    x +=
      ((g.advanceWidth || font.unitsPerEm) * 100) / font.unitsPerEm + tracking;
    if (i < glyphs.length - 1)
      x += (font.getKerningValue(g, glyphs[i + 1]) * 100) / font.unitsPerEm;
  });
  const b = path.getBoundingBox();
  return { path, b };
}
function warpPath(text: string, d: Design) {
  const item = lettering(
    d.uppercase ? text.toUpperCase() : text,
    d.font,
    d.tracking,
  );
  if (!item) return null;
  const { path, b } = item;
  const w = Math.max(b.x2 - b.x1, 1);
  const h = Math.max(b.y2 - b.y1, 1);
  const s = Math.min(600 / w, 100 / h);
  const wid = (w * s * d.width) / 100;
  const height = h * s;
  const a = d.amount / 100;
  const map = (x: number, y: number) => {
    let xx = ((x - (b.x1 + b.x2) / 2) * s * d.width) / 100,
      yy = (y - (b.y1 + b.y2) / 2) * s;
    const t = xx / Math.max(wid / 2, 1);
    if (d.shape === "arch") yy += t * t * 40 * a - 20 * a;
    if (d.shape === "wave") yy += Math.sin(t * Math.PI) * 30 * a;
    if (d.shape === "rise") yy -= t * 25 * a;
    if (d.shape === "bulge") yy *= 1 + (1 - t * t) * a * 0.6;
    if (d.shape === "slant") xx -= yy * a * 0.45;
    return [num(xx), num(yy)];
  };
  const out = new opentype.Path();
  for (const cmd of path.commands) {
    if (cmd.type === "Z") {
      out.close();
      continue;
    }
    const p = map(cmd.x, cmd.y);
    if (cmd.type === "M") out.moveTo(...(p as [number, number]));
    if (cmd.type === "L") out.lineTo(...(p as [number, number]));
    if (cmd.type === "Q") {
      const q = map(cmd.x1, cmd.y1);
      out.quadraticCurveTo(q[0], q[1], p[0], p[1]);
    }
    if (cmd.type === "C") {
      const q = map(cmd.x1, cmd.y1),
        r = map(cmd.x2, cmd.y2);
      out.curveTo(q[0], q[1], r[0], r[1], p[0], p[1]);
    }
  }
  return { data: out.toPathData(2), width: wid, height, bounds: out.getBoundingBox() };
}
function plainPath(
  text: string,
  fontId: string,
  width: number,
  height: number,
) {
  const resolved = fontForText(fontId, text);
  const item = resolved ? lettering(text, resolved, 0) : null;
  if (!item) return "";
  const { path, b } = item;
  const s = Math.min(
    width / Math.max(b.x2 - b.x1, 1),
    height / Math.max(b.y2 - b.y1, 1),
  );
  return `<g transform="scale(${s}) translate(${-(b.x1 + b.x2) / 2} ${-(b.y1 + b.y2) / 2})"><path d="${path.toPathData(2)}"/></g>`;
}
function iconBody(d: Design, theme: Theme, id: string) {
  const c = d.icon,
    p = d[theme],
    bg = theme === "dark" ? c.backgroundDark : c.background,
    fg = c.match ? p.ink : theme === "dark" ? c.foregroundDark : c.foreground;
  let silhouette = `<rect x="0" y="0" width="256" height="256" rx="${c.shape === "rounded" ? c.radius * 2.56 : c.shape === "squircle" ? 72 : 0}"/>`;
  if (c.shape === "circle") silhouette = '<circle cx="128" cy="128" r="128"/>';
  if (c.shape === "diamond")
    silhouette = '<path d="M128 0 256 128 128 256 0 128Z"/>';
  if (c.shape === "hexagon")
    silhouette = '<path d="M64 17 192 17 256 128 192 239 64 239 0 128Z"/>';
  let foreground = "";
  if (c.mode === "symbol")
    foreground = `<g transform="translate(-128 -128)">${iconPaths[c.symbol] || iconPaths.planet}</g>`;
  if (c.mode === "monogram")
    foreground = plainPath(
      c.letters || Array.from(d.name)[0],
      d.font,
      235,
      220,
    );
  if (c.mode === "emoji")
    foreground = `<text text-anchor="middle" dominant-baseline="central" font-size="200" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">${esc(c.emoji)}</text>`;
  if (c.mode === "upload" && c.image)
    foreground = `<image href="${esc(c.image)}" x="-128" y="-128" width="256" height="256" preserveAspectRatio="xMidYMid meet"/>`;
  const accent = theme === "dark" ? c.accentDark : c.accent;
  const patternPaths = {
    none: "",
    dots: '<circle cx="8" cy="8" r="2.5"/>',
    grid: '<path d="M0 0H32V32" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    waves:
      '<path d="M-8 16Q0 0 8 16T24 16T40 16" fill="none" stroke="currentColor" stroke-width="2"/>',
    rays: Array.from(
      { length: 16 },
      (_, i) =>
        `<path d="M128 128L128 -100L165 -100Z" transform="rotate(${i * 22.5} 128 128)"/>`,
    ).join(""),
    orbit:
      '<g fill="none" stroke="currentColor" stroke-width="2"><circle cx="128" cy="128" r="75"/><circle cx="128" cy="128" r="100"/><circle cx="128" cy="128" r="125"/></g>',
  };
  const tiled = ["dots", "grid", "waves"].includes(c.pattern);
  const pattern =
    c.pattern === "none"
      ? ""
      : `<g color="${fg}" fill="${fg}" opacity=".14">${tiled ? `<rect width="256" height="256" fill="url(#${id}-texture)"/>` : patternPaths[c.pattern]}</g>`;
  const transform = `translate(${128 + c.x * 2.56} ${128 + c.y * 2.56}) rotate(${c.rotation}) scale(${c.scale / 100})`;
  const drawn = (extra = "") =>
    `<g fill="${fg}" color="${fg}" transform="${transform}" ${extra}>${foreground}</g>`;
  let layers = "";
  if (c.finish === "raised")
    layers += `<g opacity=".24" transform="translate(0 9)">${drawn()}</g>`;
  if (c.finish === "neon") layers += drawn(`filter="url(#${id}-shine)"`);
  if (c.finish === "sticker")
    layers += drawn(
      'stroke="white" stroke-width="12" stroke-linejoin="round" paint-order="stroke fill"',
    );
  layers += drawn();
  if (c.finish === "glass")
    layers +=
      '<path d="M0 0H256V85Q128 145 0 100Z" fill="white" opacity=".2"/>';
  if (c.finish === "stamp")
    layers += `<rect x="13" y="13" width="230" height="230" rx="${c.shape === "circle" ? 115 : 28}" fill="none" stroke="${fg}" stroke-width="3" stroke-dasharray="4 5" opacity=".8"/>`;
  return `<defs><clipPath id="${id}-clip">${silhouette}</clipPath><linearGradient id="${id}-ibg" gradientTransform="rotate(${c.gradientAngle} .5 .5)"><stop stop-color="${bg}"/><stop offset="1" stop-color="${accent}"/></linearGradient><filter id="${id}-shine" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter><pattern id="${id}-texture" width="32" height="32" patternUnits="userSpaceOnUse" fill="${fg}" color="${fg}">${tiled ? patternPaths[c.pattern] : ""}</pattern></defs><g clip-path="url(#${id}-clip)">${c.transparent ? "" : `<g fill="${c.gradient ? `url(#${id}-ibg)` : bg}">${silhouette}</g>${pattern}`}${layers}${c.border ? `<g fill="none" stroke="${fg}" stroke-width="${c.border * 2}">${silhouette}</g>` : ""}</g>`;
}
export function renderSvg(
  d: Design,
  theme: Theme = "light",
  view: View = "logo",
  id = "export",
  background = false,
  compact = false,
  accessibility?: { label: string; title: string },
) {
  const iconOnly = view === "icon",
    W = iconOnly ? 256 : 960,
    H = iconOnly ? 256 : 440,
    p = d[theme];
  const gradient = `<linearGradient id="${id}-fill" gradientTransform="rotate(${d.angle} .5 .5)"><stop stop-color="${p.ink}"/>${d.effect === "chrome" ? `<stop offset=".45" stop-color="${p.secondary}"/><stop offset=".5" stop-color="${p.ink}"/>` : ""}<stop offset="1" stop-color="${p.secondary}"/></linearGradient>`;
  const defs = `<defs>${gradient}<filter id="${id}-glow" x="-60%" y="-150%" width="220%" height="400%"><feGaussianBlur stdDeviation="${2 + d.amount / 15}"/></filter><pattern id="${id}-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${p.outline}" opacity=".5"/></pattern></defs>`;
  let content = "";
  let viewBox = `0 0 ${W} ${H}`;
  if (iconOnly) content = iconBody(d, theme, id);
  else {
    const layout = view === "title" ? "title" : d.layout;
    const beside = layout === "beside",
      stacked = layout === "stacked",
      badge = layout === "badge";
    let title = warpPath(d.name, d);
    let titleMarkup = "";
    const fill =
      d.gradient || d.effect === "chrome" ? `url(#${id}-fill)` : p.ink;
    if (title) {
      const path = `d="${title.data}"`;
      const depth = d.depth;
      if (d.effect === "extrude")
        for (let n = depth; n > 0; n--)
          titleMarkup += `<path ${path} fill="${p.shadow}" transform="translate(${n * 0.8} ${n})"/>`;
      if (d.effect === "echo")
        for (let n = 3; n > 0; n--)
          titleMarkup += `<path ${path} fill="${n % 2 ? p.secondary : p.shadow}" opacity="${1 - n * 0.12}" transform="translate(${(-n * depth) / 2} ${n * depth})"/>`;
      if (d.effect === "shadow" || d.effect === "sticker")
        titleMarkup += `<path ${path} fill="${p.shadow}" stroke="${p.shadow}" stroke-width="${d.effect === "sticker" ? 8 : 0}" stroke-linejoin="round" transform="translate(${depth} ${depth})"/>`;
      if (d.effect === "neon")
        titleMarkup += `<path ${path} fill="${p.ink}" stroke="${p.ink}" stroke-width="4" filter="url(#${id}-glow)"/>`;
      if (d.effect === "glitch")
        titleMarkup += `<path ${path} fill="${p.secondary}" transform="translate(${-depth} 2)"/><path ${path} fill="${p.shadow}" transform="translate(${depth} -2)"/>`;
      const stroke =
        d.effect === "sticker" ? Math.max(4, d.outline * 2) : d.outline;
      titleMarkup += `<path ${path} fill="${d.effect === "outline" ? "none" : fill}" stroke="${d.effect === "outline" ? p.ink : p.outline}" stroke-width="${d.effect === "outline" ? Math.max(2, stroke) : stroke}" stroke-linejoin="round" paint-order="stroke fill"/>`;
      if (d.effect === "halftone")
        titleMarkup += `<path ${path} fill="url(#${id}-dots)"/>`;
    }
    const tx = beside ? 555 : 480,
      ty = stacked ? 258 : badge ? 240 : layout === "title" ? 220 : 205,
      scale = Math.min(
        badge ? 0.78 : beside ? 0.95 : 1,
        (badge ? 520 : beside ? 660 : 820) /
          Math.max(
            1,
            (title?.width || 600) +
              d.depth * 6 +
              d.outline * 2 +
              (d.shape === "slant" ? 50 : 0),
          ),
      );
    if (compact && view === "title" && title) {
      const b = title.bounds;
      const padding = Math.max(12, d.depth * 3 + d.outline * 2, d.effect === "neon" ? 38 : 0);
      viewBox = `${tx + (b.x1 - padding) * scale} ${ty + (b.y1 - padding) * scale} ${(b.x2 - b.x1 + padding * 2) * scale} ${(b.y2 - b.y1 + padding * 2) * scale}`;
    }
    if (badge)
      content += `<rect x="170" y="65" width="620" height="310" rx="145" fill="none" stroke="${p.ink}" stroke-width="2"/><rect x="180" y="75" width="600" height="290" rx="135" fill="none" stroke="${p.ink}" opacity=".3"/>`;
    if (layout !== "title") {
      const sz = beside ? 126 : badge ? 65 : 90,
        ix = beside ? 103 : 480 - sz / 2,
        iy = beside ? 143 : badge ? 96 : 91;
      content += `<g transform="translate(${ix} ${iy}) scale(${sz / 256})">${iconBody(d, theme, id + "-icon")}</g>`;
    }
    content += `<g data-title-art="" transform="translate(${tx} ${ty}) scale(${scale})">${titleMarkup}</g>`;
  }
  const dimensions = compact && view === "title" ? viewBox.split(" ").slice(2).map(Number) : [W, H];
  const label = accessibility?.label ?? `${d.name} ${iconOnly ? "icon" : "identity"}`;
  const title = accessibility?.title ?? `${d.name} — MyTitle`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions[0]}" height="${dimensions[1]}" viewBox="${viewBox}" role="img" aria-label="${esc(label)}"><title>${esc(title)}</title>${defs}${background ? `<rect width="${W}" height="${H}" fill="${p.surface}"/>` : ""}${content}</svg>`;
}
