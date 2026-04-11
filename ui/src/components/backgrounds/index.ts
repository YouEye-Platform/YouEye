/**
 * Animated Backgrounds Registry
 *
 * Central registry of all animated background styles, color presets, and types.
 * To add a new background:
 * 1. Create component in this folder (e.g., my-background.tsx)
 * 2. Register it in ANIMATED_BACKGROUNDS below
 * 3. It will automatically appear in the settings dialog
 */

import { FlowingLines } from "./flowing-lines";
import { InteractiveDots } from "./interactive-dots";
import { VerticalBars } from "./vertical-bars";
import { HorizontalBars } from "./horizontal-bars";
import { SlidingEase } from "./sliding-ease";
import { DotParticles } from "./dot-particles";
import { SmoothWavy } from "./smooth-wavy";
import { FlowingRibbons } from "./flowing-ribbons";
import { FlowingDots } from "./flowing-dots";
import { ShaderGradient } from "./shader-gradient";

// ============================================
// Color Presets
// ============================================

export const COLOR_PRESETS = {
  purple: {
    label: "Purple",
    primary: "#9333ea",
    secondary: "#a855f7",
    accent: "#c084fc",
    colors: ["#9333ea", "#a855f7", "#c084fc", "#d8b4fe", "#7c3aed", "#8b5cf6"],
    background: "#faf5ff",
    backgroundDark: "#1a0a2e",
    rgb: "147, 51, 234",
  },
  blue: {
    label: "Blue",
    primary: "#0ea5e9",
    secondary: "#38bdf8",
    accent: "#7dd3fc",
    colors: ["#0ea5e9", "#38bdf8", "#7dd3fc", "#bae6fd", "#0284c7", "#0369a1"],
    background: "#f0f9ff",
    backgroundDark: "#0a1929",
    rgb: "14, 165, 233",
  },
  green: {
    label: "Green",
    primary: "#10b981",
    secondary: "#34d399",
    accent: "#6ee7b7",
    colors: ["#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#059669", "#047857"],
    background: "#f0fdf4",
    backgroundDark: "#0a1f14",
    rgb: "16, 185, 129",
  },
  orange: {
    label: "Orange",
    primary: "#f97316",
    secondary: "#fb923c",
    accent: "#fdba74",
    colors: ["#f97316", "#fb923c", "#fdba74", "#fed7aa", "#ea580c", "#c2410c"],
    background: "#fff7ed",
    backgroundDark: "#1f150a",
    rgb: "249, 115, 22",
  },
  pink: {
    label: "Pink",
    primary: "#ec4899",
    secondary: "#f472b6",
    accent: "#f9a8d4",
    colors: ["#ec4899", "#f472b6", "#f9a8d4", "#fbcfe8", "#db2777", "#be185d"],
    background: "#fdf2f8",
    backgroundDark: "#1f0a18",
    rgb: "236, 72, 153",
  },
  gray: {
    label: "Gray",
    primary: "#6b7280",
    secondary: "#9ca3af",
    accent: "#d1d5db",
    colors: ["#6b7280", "#9ca3af", "#d1d5db", "#e5e7eb", "#4b5563", "#374151"],
    background: "#f9fafb",
    backgroundDark: "#111827",
    rgb: "107, 114, 128",
  },
  sunset: {
    label: "Sunset",
    primary: "#f97316",
    secondary: "#ec4899",
    accent: "#8b5cf6",
    colors: ["#f97316", "#fb923c", "#ec4899", "#f472b6", "#8b5cf6", "#a78bfa"],
    background: "#fef3e2",
    backgroundDark: "#1c0f08",
    rgb: "249, 115, 22",
  },
  ocean: {
    label: "Ocean",
    primary: "#0ea5e9",
    secondary: "#10b981",
    accent: "#06b6d4",
    colors: ["#0ea5e9", "#38bdf8", "#10b981", "#34d399", "#06b6d4", "#22d3ee"],
    background: "#ecfeff",
    backgroundDark: "#0a1a1f",
    rgb: "14, 165, 233",
  },
  forest: {
    label: "Forest",
    primary: "#10b981",
    secondary: "#84cc16",
    accent: "#22c55e",
    colors: ["#10b981", "#34d399", "#84cc16", "#a3e635", "#22c55e", "#4ade80"],
    background: "#f0fdf4",
    backgroundDark: "#0a1a0f",
    rgb: "16, 185, 129",
  },
  neon: {
    label: "Neon",
    primary: "#f0abfc",
    secondary: "#67e8f9",
    accent: "#fde047",
    colors: ["#f0abfc", "#e879f9", "#67e8f9", "#22d3ee", "#fde047", "#facc15"],
    background: "#1a1a2e",
    backgroundDark: "#0a0a1a",
    rgb: "240, 171, 252",
  },
} as const;

export type ColorPreset = keyof typeof COLOR_PRESETS;

// ============================================
// Customization
// ============================================

export interface BackgroundCustomization {
  speed: number; // 0.1 - 3.0
  scale: number; // 0.5 - 2.0
  intensity: number; // 0.1 - 2.0
  reactivity: number; // 0.0 - 2.0 (cursor reactivity)
  gradientEnabled: boolean;
}

export const DEFAULT_CUSTOMIZATION: BackgroundCustomization = {
  speed: 1.0,
  scale: 1.0,
  intensity: 1.0,
  reactivity: 1.0,
  gradientEnabled: false,
};

// ============================================
// Background Registry
// ============================================

export const ANIMATED_BACKGROUNDS = {
  "flowing-lines": {
    id: "flowing-lines",
    name: "Flowing Lines",
    description: "Horizontal wavy lines that respond to mouse",
    icon: "〰️",
    component: FlowingLines,
  },
  "interactive-dots": {
    id: "interactive-dots",
    name: "Interactive Dots",
    description: "Grid of dots that pulse and react to cursor",
    icon: "⚬",
    component: InteractiveDots,
  },
  "vertical-bars": {
    id: "vertical-bars",
    name: "Vertical Bars",
    description: "Animated vertical bars with noise pattern",
    icon: "▮",
    component: VerticalBars,
  },
  "horizontal-bars": {
    id: "horizontal-bars",
    name: "Horizontal Bars",
    description: "Flowing horizontal bars with mouse interaction",
    icon: "▬",
    component: HorizontalBars,
  },
  "sliding-ease": {
    id: "sliding-ease",
    name: "Sliding Ease",
    description: "Smooth sliding bars with easing transitions",
    icon: "◫",
    component: SlidingEase,
  },
  "dot-particles": {
    id: "dot-particles",
    name: "Dot Particles",
    description: "Click to create particle bursts",
    icon: "✦",
    component: DotParticles,
  },
  "smooth-wavy": {
    id: "smooth-wavy",
    name: "Smooth Wavy",
    description: "Layered wavy lines in multiple directions",
    icon: "≋",
    component: SmoothWavy,
  },
  "flowing-ribbons": {
    id: "flowing-ribbons",
    name: "Flowing Ribbons",
    description: "Deforming grid mesh with wave effects",
    icon: "⌇",
    component: FlowingRibbons,
  },
  "flowing-dots": {
    id: "flowing-dots",
    name: "Flowing Dots",
    description: "Dots that flow in noise-based patterns",
    icon: "⁘",
    component: FlowingDots,
  },
  "shader-gradient": {
    id: "shader-gradient",
    name: "Shader Gradient",
    description: "3D animated gradient with cursor-reactive colors",
    icon: "🌈",
    component: ShaderGradient,
  },
} as const;

export type AnimatedBackgroundStyle = keyof typeof ANIMATED_BACKGROUNDS;

// ============================================
// Props interface for all animated backgrounds
// ============================================

export interface AnimatedBackgroundProps {
  colorPreset: ColorPreset;
  customization?: BackgroundCustomization;
  isDark?: boolean;
  className?: string;
}

// ============================================
// Helpers
// ============================================

/** Convert hex color to RGB object */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.charAt(0) === "#" ? hex.substring(1) : hex;
  return {
    r: Number.parseInt(clean.substring(0, 2), 16),
    g: Number.parseInt(clean.substring(2, 4), 16),
    b: Number.parseInt(clean.substring(4, 6), 16),
  };
}

/** Interpolate between two RGB colors */
export function interpolateColor(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number
) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/** Get the preset's background color based on theme */
export function getPresetBackground(
  preset: (typeof COLOR_PRESETS)[ColorPreset],
  isDark: boolean
): string {
  return isDark ? preset.backgroundDark : preset.background;
}
