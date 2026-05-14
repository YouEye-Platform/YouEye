/**
 * WordArt Building Blocks for YE-UI
 *
 * Mirrors the the Control Panel's wordart-presets.ts. Users pick from four categories:
 * Font, Effect, Shape, Colour — each with intensity controls.
 */

import type { SiteNameStyle } from "@/lib/db/queries/branding";

export interface FontPreset { id: string; name: string; fontFamily: string; fontWeight: number; letterSpacing: string; textTransform: string; }
export interface EffectPreset { id: string; name: string; textShadow: string; textStroke?: string; scalable: boolean; }
export interface ShapePreset { id: string; name: string; transform: string; scalable: boolean; type?: 'css'; }
/** Per-character shape: each letter gets an individual transform based on its index */
export interface CharacterShapePreset {
  id: string;
  name: string;
  type: 'character';
  scalable: boolean;
  /** Returns CSS transform for character at `index` out of `total` characters */
  charTransform: (index: number, total: number, intensity: number) => string;
}
export interface ColourPreset { id: string; name: string; color: string; gradient: { enabled: boolean; from: string; to: string; direction: string } | null; }

export const FONT_PRESETS: FontPreset[] = [
  { id: 'modern', name: 'Modern', fontFamily: 'Montserrat', fontWeight: 800, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'lobster', name: 'Lobster', fontFamily: 'Lobster', fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'marker', name: 'Marker', fontFamily: 'Permanent Marker', fontWeight: 400, letterSpacing: '0.03em', textTransform: 'none' },
  { id: 'scifi', name: 'Sci-Fi', fontFamily: 'Orbitron', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' },
  { id: 'display', name: 'Display', fontFamily: 'Abril Fatface', fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'script', name: 'Script', fontFamily: 'Pacifico', fontWeight: 400, letterSpacing: '0.01em', textTransform: 'none' },
  { id: 'block', name: 'Block', fontFamily: 'Bungee', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase' },
  { id: 'stencil', name: 'Stencil', fontFamily: 'Russo One', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase' },
  { id: 'rounded', name: 'Rounded', fontFamily: 'Fredoka', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'brush', name: 'Brush', fontFamily: 'Satisfy', fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'serif', name: 'Serif', fontFamily: 'Playfair Display', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'none' },
  { id: 'handwritten', name: 'Handwritten', fontFamily: 'Caveat', fontWeight: 700, letterSpacing: '0.01em', textTransform: 'none' },
  { id: 'clean', name: 'Clean', fontFamily: 'Inter', fontWeight: 600, letterSpacing: '0.03em', textTransform: 'none' },
  { id: 'mono', name: 'Mono', fontFamily: 'JetBrains Mono', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' },
  { id: 'elegant', name: 'Elegant', fontFamily: 'Raleway', fontWeight: 300, letterSpacing: '0.12em', textTransform: 'uppercase' },
  // ── New fonts ──
  { id: 'bangers', name: 'Bangers', fontFamily: 'Bangers', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'none' },
  { id: 'bebas', name: 'Bebas', fontFamily: 'Bebas Neue', fontWeight: 400, letterSpacing: '0.06em', textTransform: 'uppercase' },
  { id: 'dancing', name: 'Dancing', fontFamily: 'Dancing Script', fontWeight: 700, letterSpacing: '0.01em', textTransform: 'none' },
  { id: 'comfy', name: 'Comfy', fontFamily: 'Comfortaa', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'oswald', name: 'Oswald', fontFamily: 'Oswald', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase' },
  { id: 'titan', name: 'Titan', fontFamily: 'Titan One', fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'military', name: 'Military', fontFamily: 'Black Ops One', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase' },
  { id: 'creepy', name: 'Creepy', fontFamily: 'Creepster', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'none' },
  { id: 'neon-font', name: 'Neon Font', fontFamily: 'Monoton', fontWeight: 400, letterSpacing: '0.03em', textTransform: 'none' },
  { id: 'pixel', name: 'Pixel', fontFamily: 'Press Start 2P', fontWeight: 400, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'tech', name: 'Tech', fontFamily: 'Audiowide', fontWeight: 400, letterSpacing: '0.04em', textTransform: 'none' },
  { id: 'cinzel', name: 'Cinzel', fontFamily: 'Cinzel', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' },
  { id: 'calligraphy', name: 'Calligraphy', fontFamily: 'Great Vibes', fontWeight: 400, letterSpacing: '0.01em', textTransform: 'none' },
  { id: 'quicksand', name: 'Quicksand', fontFamily: 'Quicksand', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'none' },
  { id: 'headline', name: 'Headline', fontFamily: 'Archivo Black', fontWeight: 400, letterSpacing: '0.03em', textTransform: 'none' },
  { id: 'righteous', name: 'Righteous', fontFamily: 'Righteous', fontWeight: 400, letterSpacing: '0.03em', textTransform: 'none' },
];

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'none', name: 'None', textShadow: 'none', scalable: false },
  { id: '3d', name: '3D', textShadow: '0 1px 0 #ccc, 0 2px 0 #bbb, 0 3px 0 #aaa, 0 4px 5px rgba(0,0,0,0.3)', scalable: true },
  { id: 'retro', name: 'Retro', textShadow: '3px 3px 0 rgba(0,0,0,0.25)', scalable: true },
  { id: 'emboss', name: 'Emboss', textShadow: '0 1px 0 rgba(255,255,255,0.3), 0 -1px 0 rgba(0,0,0,0.5)', scalable: true },
  { id: 'outline', name: 'Outline', textShadow: 'none', textStroke: '2px currentColor', scalable: true },
  { id: 'glow', name: 'Glow', textShadow: '0 0 10px currentColor, 0 0 20px currentColor, 0 0 40px currentColor', scalable: true },
  { id: 'neon', name: 'Neon', textShadow: '0 0 7px #fff, 0 0 10px #fff, 0 0 21px #fff, 0 0 42px currentColor, 0 0 82px currentColor', scalable: true },
  { id: 'long-shadow', name: 'Long Shadow', textShadow: '1px 1px rgba(0,0,0,0.15), 2px 2px rgba(0,0,0,0.12), 3px 3px rgba(0,0,0,0.10), 4px 4px rgba(0,0,0,0.08), 5px 5px rgba(0,0,0,0.06), 6px 6px 8px rgba(0,0,0,0.08)', scalable: true },
  { id: 'soft', name: 'Soft', textShadow: '0 2px 4px rgba(0,0,0,0.2)', scalable: true },
  { id: 'sharp', name: 'Sharp', textShadow: '2px 2px 0 rgba(0,0,0,0.4), 4px 4px 0 rgba(0,0,0,0.15)', scalable: true },
  // ── New effects ──
  { id: 'chrome', name: 'Chrome', textShadow: '0 1px 0 #999, 0 2px 0 #888, 0 3px 0 #777, 0 4px 0 #666, 0 5px 0 #555, 0 6px 6px rgba(0,0,0,0.4)', scalable: true },
  { id: 'fire-glow', name: 'Fire Glow', textShadow: '0 0 10px #ff8c00, 0 0 20px #ff4500, 0 0 40px #ff0000, 0 0 60px #8b0000', scalable: true },
  { id: 'vintage', name: 'Vintage', textShadow: '2px 2px 0 rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.2)', scalable: true },
  { id: 'glitch', name: 'Glitch', textShadow: '-2px 0 #ff0000, 2px 0 #00ffff', scalable: true },
  { id: 'double-shadow', name: 'Double', textShadow: '3px 3px 0 rgba(0,0,0,0.3), -2px -2px 0 rgba(255,255,255,0.15)', scalable: true },
  { id: 'engrave', name: 'Engrave', textShadow: '0 -1px 0 rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.15)', scalable: true },
  { id: 'comic', name: 'Comic', textShadow: '3px 3px 0 rgba(0,0,0,0.8)', textStroke: '2px currentColor', scalable: true },
  { id: 'rainbow-shadow', name: 'Rainbow Shadow', textShadow: '1px 1px 0 #ff0000, 2px 2px 0 #ff8800, 3px 3px 0 #ffff00, 4px 4px 0 #00cc00, 5px 5px 0 #0066ff, 6px 6px 0 #9900ff', scalable: true },
  { id: 'frosted', name: 'Frosted', textShadow: '0 0 8px rgba(255,255,255,0.6), 0 0 16px rgba(255,255,255,0.3)', scalable: true },
  { id: 'pixel-shadow', name: 'Pixel Shadow', textShadow: '2px 0 0 rgba(0,0,0,0.3), 0 2px 0 rgba(0,0,0,0.3), 2px 2px 0 rgba(0,0,0,0.3), 4px 2px 0 rgba(0,0,0,0.15), 2px 4px 0 rgba(0,0,0,0.15)', scalable: true },
];

export const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'normal', name: 'Normal', transform: 'none', scalable: false },
  { id: 'italic', name: 'Italic', transform: 'skewX(-12deg)', scalable: true },
  { id: 'lean-back', name: 'Lean Back', transform: 'skewX(12deg)', scalable: true },
  { id: 'wide', name: 'Wide', transform: 'scaleX(1.4)', scalable: true },
  { id: 'tall', name: 'Tall', transform: 'scaleY(1.4) scaleX(0.8)', scalable: true },
  { id: 'pinch-right', name: 'Pinch', transform: 'perspective(120px) rotateY(12deg)', scalable: true },
  { id: 'pinch-left', name: 'Pinch L', transform: 'perspective(120px) rotateY(-12deg)', scalable: true },
  { id: 'tilt-up', name: 'Tilt Up', transform: 'perspective(200px) rotateX(-10deg)', scalable: true },
  { id: 'tilt-down', name: 'Tilt Down', transform: 'perspective(200px) rotateX(10deg)', scalable: true },
  { id: 'wave', name: 'Wave', transform: 'perspective(100px) rotateX(8deg) rotateY(5deg)', scalable: true },
  // ── New CSS-only shapes ──
  { id: 'squeeze', name: 'Squeeze', transform: 'scaleX(0.7)', scalable: true },
  { id: 'stretch', name: 'Stretch', transform: 'scaleY(0.7) scaleX(1.3)', scalable: true },
  { id: 'flip', name: 'Flip', transform: 'rotateY(180deg)', scalable: false },
  { id: 'rotate-cw', name: 'Rotate CW', transform: 'rotate(8deg)', scalable: true },
  { id: 'rotate-ccw', name: 'Rotate CCW', transform: 'rotate(-8deg)', scalable: true },
];

export const CHARACTER_SHAPE_PRESETS: CharacterShapePreset[] = [
  {
    id: 'char-wave', name: 'Wave', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const y = Math.sin((i / Math.max(total - 1, 1)) * Math.PI * 2) * 8 * intensity;
      return `translateY(${y.toFixed(1)}px)`;
    },
  },
  {
    id: 'char-arc', name: 'Arc', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const mid = (total - 1) / 2;
      const y = -Math.pow((i - mid) / Math.max(mid, 1), 2) * 12 * intensity;
      const r = ((i - mid) / Math.max(mid, 1)) * -6 * intensity;
      return `translateY(${y.toFixed(1)}px) rotate(${r.toFixed(1)}deg)`;
    },
  },
  {
    id: 'char-valley', name: 'Valley', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const mid = (total - 1) / 2;
      const y = Math.pow((i - mid) / Math.max(mid, 1), 2) * 12 * intensity;
      const r = ((i - mid) / Math.max(mid, 1)) * 6 * intensity;
      return `translateY(${y.toFixed(1)}px) rotate(${r.toFixed(1)}deg)`;
    },
  },
  {
    id: 'char-bounce', name: 'Bounce', type: 'character', scalable: true,
    charTransform: (i, _total, intensity) => {
      const y = (i % 2 === 0 ? -6 : 6) * intensity;
      return `translateY(${y.toFixed(1)}px)`;
    },
  },
  {
    id: 'char-fan', name: 'Fan', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const mid = (total - 1) / 2;
      const r = ((i - mid) / Math.max(mid, 1)) * 15 * intensity;
      return `rotate(${r.toFixed(1)}deg)`;
    },
  },
  {
    id: 'char-cascade', name: 'Cascade', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const y = (i / Math.max(total - 1, 1)) * 14 * intensity;
      return `translateY(${y.toFixed(1)}px)`;
    },
  },
  {
    id: 'char-zoom', name: 'Zoom', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const mid = (total - 1) / 2;
      const s = 1 + (1 - Math.abs(i - mid) / Math.max(mid, 1)) * 0.4 * intensity;
      return `scale(${s.toFixed(2)})`;
    },
  },
  {
    id: 'char-spiral', name: 'Spiral', type: 'character', scalable: true,
    charTransform: (i, total, intensity) => {
      const r = (i / Math.max(total - 1, 1)) * 30 * intensity;
      const y = Math.sin((i / Math.max(total - 1, 1)) * Math.PI) * 8 * intensity;
      return `rotate(${r.toFixed(1)}deg) translateY(${y.toFixed(1)}px)`;
    },
  },
];

export type AnyShapePreset = ShapePreset | CharacterShapePreset;

/** All shapes combined for the picker carousel — CSS shapes first, then character shapes */
export const ALL_SHAPE_PRESETS: AnyShapePreset[] = [
  ...SHAPE_PRESETS,
  ...CHARACTER_SHAPE_PRESETS,
];

export function isCharacterShape(s: AnyShapePreset): s is CharacterShapePreset {
  return s.type === 'character';
}

export const COLOUR_PRESETS: ColourPreset[] = [
  { id: 'white', name: 'White', color: '#ffffff', gradient: null },
  { id: 'black', name: 'Black', color: '#111111', gradient: null },
  { id: 'gold', name: 'Gold', color: '#D4AF37', gradient: { enabled: true, from: '#FFE878', to: '#8B6914', direction: '180deg' } },
  { id: 'silver', name: 'Silver', color: '#C0C0C0', gradient: { enabled: true, from: '#F0F0F0', to: '#707070', direction: '180deg' } },
  { id: 'bronze', name: 'Bronze', color: '#CD7F32', gradient: { enabled: true, from: '#E8A95B', to: '#8B4513', direction: '180deg' } },
  { id: 'fire', name: 'Fire', color: '#FF4500', gradient: { enabled: true, from: '#FFD700', to: '#FF0000', direction: '180deg' } },
  { id: 'ocean', name: 'Ocean', color: '#0077FF', gradient: { enabled: true, from: '#00D4FF', to: '#0044AA', direction: '180deg' } },
  { id: 'toxic', name: 'Toxic', color: '#39FF14', gradient: { enabled: true, from: '#ADFF2F', to: '#006400', direction: '180deg' } },
  { id: 'sunset', name: 'Sunset', color: '#FF6B35', gradient: { enabled: true, from: '#FF6B35', to: '#FF1493', direction: '135deg' } },
  { id: 'aurora', name: 'Aurora', color: '#00FF88', gradient: { enabled: true, from: '#00FF88', to: '#8B5CF6', direction: '135deg' } },
  { id: 'cyber', name: 'Cyber', color: '#00FFFF', gradient: { enabled: true, from: '#00FFFF', to: '#FF00FF', direction: '90deg' } },
  { id: 'lava', name: 'Lava', color: '#FF4500', gradient: { enabled: true, from: '#FF6347', to: '#8B0000', direction: '180deg' } },
  { id: 'cotton-candy', name: 'Cotton Candy', color: '#FF69B4', gradient: { enabled: true, from: '#FFB6C1', to: '#9370DB', direction: '135deg' } },
  { id: 'electric', name: 'Electric', color: '#7B68EE', gradient: { enabled: true, from: '#E040FB', to: '#1E90FF', direction: '135deg' } },
  { id: 'rainbow', name: 'Rainbow', color: '#FF0000', gradient: { enabled: true, from: '#FF0000', to: '#0000FF', direction: '90deg' } },
  { id: 'forest', name: 'Forest', color: '#228B22', gradient: { enabled: true, from: '#90EE90', to: '#004D00', direction: '180deg' } },
  // ── New colours ──
  { id: 'navy', name: 'Navy', color: '#1B2A4A', gradient: null },
  { id: 'crimson', name: 'Crimson', color: '#DC143C', gradient: null },
  { id: 'slate', name: 'Slate', color: '#64748B', gradient: null },
  { id: 'rose-gold', name: 'Rose Gold', color: '#B76E79', gradient: { enabled: true, from: '#F4C2C2', to: '#8B5A5A', direction: '180deg' } },
  { id: 'platinum', name: 'Platinum', color: '#E5E4E2', gradient: { enabled: true, from: '#FFFFFF', to: '#A9A9A9', direction: '180deg' } },
  { id: 'galaxy', name: 'Galaxy', color: '#2C003E', gradient: { enabled: true, from: '#7B2FBE', to: '#0D0221', direction: '135deg' } },
  { id: 'autumn', name: 'Autumn', color: '#D2691E', gradient: { enabled: true, from: '#FF8C00', to: '#8B0000', direction: '135deg' } },
  { id: 'ice', name: 'Ice', color: '#B0E0E6', gradient: { enabled: true, from: '#FFFFFF', to: '#87CEEB', direction: '180deg' } },
  { id: 'peach', name: 'Peach', color: '#FFCBA4', gradient: { enabled: true, from: '#FFDAB9', to: '#FF8C69', direction: '180deg' } },
  { id: 'sapphire', name: 'Sapphire', color: '#0F52BA', gradient: { enabled: true, from: '#4169E1', to: '#0A1172', direction: '180deg' } },
  { id: 'cherry', name: 'Cherry', color: '#DE3163', gradient: { enabled: true, from: '#FF6B81', to: '#800020', direction: '180deg' } },
  { id: 'pastel-pink', name: 'Pastel Pink', color: '#FFB6C1', gradient: { enabled: true, from: '#FFD1DC', to: '#FF69B4', direction: '180deg' } },
  { id: 'teal', name: 'Teal', color: '#008080', gradient: { enabled: true, from: '#40E0D0', to: '#004D4D', direction: '180deg' } },
  { id: 'emerald', name: 'Emerald', color: '#50C878', gradient: { enabled: true, from: '#98FB98', to: '#006400', direction: '180deg' } },
  { id: 'holographic', name: 'Holographic', color: '#E0B0FF', gradient: { enabled: true, from: '#FF69B4', to: '#00CED1', direction: '90deg' } },
];

export function scaleEffect(effect: EffectPreset, factor: number, colour: string): { textShadow: string; textStroke?: string } {
  if (!effect.scalable || factor === 1) {
    return { textShadow: effect.textShadow.replace(/currentColor/g, colour), textStroke: effect.textStroke?.replace('currentColor', colour) };
  }
  if (factor === 0) return { textShadow: 'none', textStroke: undefined };
  let textStroke = effect.textStroke?.replace('currentColor', colour);
  if (textStroke) { const px = parseInt(textStroke); textStroke = `${Math.round(px * factor)}px ${colour}`; }
  let shadow = effect.textShadow.replace(/currentColor/g, colour);
  shadow = shadow.split(/,(?![^(]*\))/).map(layer => {
    return layer.trim().replace(
      /^(-?\d+(?:\.\d+)?)(px)?\s+(-?\d+(?:\.\d+)?)(px)?\s+(?:(-?\d+(?:\.\d+)?)(px)?(?:\s+(-?\d+(?:\.\d+)?)(px)?)?)?/,
      (match, h, _hu, v, _vu, blur, _bu, spread, _su) => {
        const sh = Math.round(parseFloat(h) * factor);
        const sv = Math.round(parseFloat(v) * factor);
        let result = `${sh}px ${sv}px`;
        if (blur !== undefined) { result += ` ${Math.round(parseFloat(blur) * factor)}px`; if (spread !== undefined) { result += ` ${Math.round(parseFloat(spread) * factor)}px`; } }
        return result;
      }
    );
  }).join(', ');
  return { textShadow: shadow, textStroke };
}

export function scaleShape(shape: ShapePreset, factor: number): string {
  if (!shape.scalable || factor === 1 || shape.transform === 'none') return shape.transform;
  if (factor === 0) return 'none';
  return shape.transform.replace(/(-?\d+(?:\.\d+)?)(deg|px)/g, (_, num, unit) => {
    const base = parseFloat(num);
    if (unit === 'px') return `${Math.round(base / factor)}${unit}`;
    return `${(base * factor).toFixed(1)}${unit}`;
  });
}

export function composeStyle(
  font: FontPreset, effect: EffectPreset, colour: ColourPreset,
  shape?: AnyShapePreset, effectIntensity?: number, shapeIntensity?: number,
): SiteNameStyle {
  const isOutline = effect.textStroke && effect.id === 'outline';
  const effectColour = colour.gradient?.from || colour.color;
  const scaled = scaleEffect(effect, effectIntensity ?? 1, effectColour);

  let transform: string | undefined;
  let charShapeId: string | undefined;
  let charShapeIntensity: number | undefined;

  if (shape) {
    if (isCharacterShape(shape)) {
      charShapeId = shape.id;
      charShapeIntensity = shapeIntensity ?? 1;
    } else {
      const t = scaleShape(shape, shapeIntensity ?? 1);
      transform = t !== 'none' ? t : undefined;
    }
  }

  return {
    fontFamily: font.fontFamily, fontSize: '1.5rem', fontWeight: font.fontWeight,
    letterSpacing: font.letterSpacing, textTransform: font.textTransform,
    color: isOutline ? 'transparent' : colour.color,
    gradient: isOutline ? null : colour.gradient,
    textShadow: scaled.textShadow, textStroke: scaled.textStroke,
    transform, charShapeId, charShapeIntensity,
  };
}
