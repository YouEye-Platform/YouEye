/**
 * WordArt Building Blocks for YE-UI
 *
 * Mirrors the CP's wordart-presets.ts. Users pick from four categories:
 * Font, Effect, Shape, Colour — each with intensity controls.
 */

import type { SiteNameStyle } from "@/lib/db/queries/branding";

export interface FontPreset { id: string; name: string; fontFamily: string; fontWeight: number; letterSpacing: string; textTransform: string; }
export interface EffectPreset { id: string; name: string; textShadow: string; textStroke?: string; scalable: boolean; }
export interface ShapePreset { id: string; name: string; transform: string; scalable: boolean; }
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
];

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
];

export function scaleEffect(effect: EffectPreset, factor: number, colour: string): { textShadow: string; textStroke?: string } {
  if (!effect.scalable || factor === 1) {
    return { textShadow: effect.textShadow.replace(/currentColor/g, colour), textStroke: effect.textStroke?.replace('currentColor', colour) };
  }
  if (factor === 0) return { textShadow: 'none', textStroke: undefined };
  let textStroke = effect.textStroke?.replace('currentColor', colour);
  if (textStroke) { const px = parseInt(textStroke); textStroke = `${Math.round(px * factor)}px ${colour}`; }
  let shadow = effect.textShadow.replace(/currentColor/g, colour);
  shadow = shadow.replace(/(-?\d+(?:\.\d+)?)(px)?/g, (_, num) => `${Math.round(parseFloat(num) * factor)}px`);
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
  shape?: ShapePreset, effectIntensity?: number, shapeIntensity?: number,
): SiteNameStyle {
  const isOutline = effect.textStroke && effect.id === 'outline';
  const effectColour = colour.gradient?.from || colour.color;
  const scaled = scaleEffect(effect, effectIntensity ?? 1, effectColour);
  const transform = shape ? scaleShape(shape, shapeIntensity ?? 1) : undefined;
  return {
    fontFamily: font.fontFamily, fontSize: '1.5rem', fontWeight: font.fontWeight,
    letterSpacing: font.letterSpacing, textTransform: font.textTransform,
    color: isOutline ? 'transparent' : colour.color,
    gradient: isOutline ? null : colour.gradient,
    textShadow: scaled.textShadow, textStroke: scaled.textStroke,
    transform: transform !== 'none' ? transform : undefined,
  };
}
