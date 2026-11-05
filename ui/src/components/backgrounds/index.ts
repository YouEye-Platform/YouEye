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


export * from "./shared";

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
} as const;

export type AnimatedBackgroundStyle = keyof typeof ANIMATED_BACKGROUNDS;
