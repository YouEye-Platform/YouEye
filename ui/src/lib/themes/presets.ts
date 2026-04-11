/**
 * Built-in Theme Presets
 *
 * 8 preset themes using OKLCH color values matching shadcn/ui v4.
 * All themes share the same neutral base (Zinc) and vary in their
 * primary/accent/ring colors. The first theme (Zinc) is the default.
 *
 * Color format: OKLCH values as used in CSS custom properties.
 * Example: "oklch(0.205 0 0)" for near-black, "oklch(0.985 0 0)" for near-white.
 */

import type { ThemeColors } from "@/db/schema";

export interface PresetTheme {
  name: string;
  colors: ThemeColors;
}

// ─── Shared neutral base (Zinc) ───────────────────────────────────────
// These are the non-primary colors shared across all presets.

const LIGHT_BASE = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.145 0 0)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.145 0 0)",
  secondary: "oklch(0.97 0 0)",
  secondaryForeground: "oklch(0.205 0 0)",
  muted: "oklch(0.97 0 0)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "oklch(0.97 0 0)",
  accentForeground: "oklch(0.205 0 0)",
  destructive: "oklch(0.577 0.245 27.325)",
  destructiveForeground: "oklch(0.985 0 0)",
  border: "oklch(0.922 0 0)",
  input: "oklch(0.922 0 0)",
};

const DARK_BASE = {
  darkBackground: "oklch(0.145 0 0)",
  darkForeground: "oklch(0.985 0 0)",
  darkCard: "oklch(0.205 0 0)",
  darkCardForeground: "oklch(0.985 0 0)",
  darkPopover: "oklch(0.205 0 0)",
  darkPopoverForeground: "oklch(0.985 0 0)",
  darkSecondary: "oklch(0.269 0 0)",
  darkSecondaryForeground: "oklch(0.985 0 0)",
  darkMuted: "oklch(0.269 0 0)",
  darkMutedForeground: "oklch(0.708 0 0)",
  darkAccent: "oklch(0.269 0 0)",
  darkAccentForeground: "oklch(0.985 0 0)",
  darkDestructive: "oklch(0.704 0.191 22.216)",
  darkDestructiveForeground: "oklch(0.985 0 0)",
  darkBorder: "oklch(1 0 0 / 10%)",
  darkInput: "oklch(1 0 0 / 15%)",
};

// ─── Slate neutral base ──────────────────────────────────────────────
// Slightly blue-gray undertone

const SLATE_LIGHT_BASE = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.129 0.042 264.695)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.129 0.042 264.695)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.129 0.042 264.695)",
  secondary: "oklch(0.968 0.007 264.695)",
  secondaryForeground: "oklch(0.208 0.042 265.755)",
  muted: "oklch(0.968 0.007 264.695)",
  mutedForeground: "oklch(0.554 0.023 264.364)",
  accent: "oklch(0.968 0.007 264.695)",
  accentForeground: "oklch(0.208 0.042 265.755)",
  destructive: "oklch(0.577 0.245 27.325)",
  destructiveForeground: "oklch(0.985 0 0)",
  border: "oklch(0.929 0.013 255.508)",
  input: "oklch(0.929 0.013 255.508)",
};

const SLATE_DARK_BASE = {
  darkBackground: "oklch(0.129 0.042 264.695)",
  darkForeground: "oklch(0.968 0.007 264.695)",
  darkCard: "oklch(0.208 0.042 265.755)",
  darkCardForeground: "oklch(0.968 0.007 264.695)",
  darkPopover: "oklch(0.208 0.042 265.755)",
  darkPopoverForeground: "oklch(0.968 0.007 264.695)",
  darkSecondary: "oklch(0.279 0.041 260.031)",
  darkSecondaryForeground: "oklch(0.968 0.007 264.695)",
  darkMuted: "oklch(0.279 0.041 260.031)",
  darkMutedForeground: "oklch(0.704 0.04 256.788)",
  darkAccent: "oklch(0.279 0.041 260.031)",
  darkAccentForeground: "oklch(0.968 0.007 264.695)",
  darkDestructive: "oklch(0.704 0.191 22.216)",
  darkDestructiveForeground: "oklch(0.985 0 0)",
  darkBorder: "oklch(1 0 0 / 10%)",
  darkInput: "oklch(1 0 0 / 15%)",
};

// ─── Theme Definitions ───────────────────────────────────────────────

export const PRESET_THEMES: PresetTheme[] = [
  // 1. Zinc — neutral gray, clean and modern (DEFAULT)
  {
    name: "Zinc",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.205 0 0)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.708 0 0)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.922 0 0)",
      darkPrimaryForeground: "oklch(0.205 0 0)",
      darkRing: "oklch(0.556 0 0)",
    },
  },

  // 2. Slate — cool gray with blue undertone
  {
    name: "Slate",
    colors: {
      ...SLATE_LIGHT_BASE,
      primary: "oklch(0.208 0.042 265.755)",
      primaryForeground: "oklch(0.984 0.003 247.858)",
      ring: "oklch(0.704 0.04 256.788)",
      ...SLATE_DARK_BASE,
      darkPrimary: "oklch(0.929 0.013 255.508)",
      darkPrimaryForeground: "oklch(0.208 0.042 265.755)",
      darkRing: "oklch(0.554 0.023 264.364)",
    },
  },

  // 3. Violet — purple/violet primary
  {
    name: "Violet",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.541 0.281 293.009)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.541 0.281 293.009)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.627 0.265 303.9)",
      darkPrimaryForeground: "oklch(0.985 0 0)",
      darkRing: "oklch(0.627 0.265 303.9)",
    },
  },

  // 4. Blue — classic blue primary
  {
    name: "Blue",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.546 0.245 262.881)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.546 0.245 262.881)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.488 0.243 264.376)",
      darkPrimaryForeground: "oklch(0.985 0 0)",
      darkRing: "oklch(0.488 0.243 264.376)",
    },
  },

  // 5. Rose — pink/rose primary
  {
    name: "Rose",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.585 0.233 17.642)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.585 0.233 17.642)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.645 0.246 16.439)",
      darkPrimaryForeground: "oklch(0.985 0 0)",
      darkRing: "oklch(0.645 0.246 16.439)",
    },
  },

  // 6. Orange — warm orange primary
  {
    name: "Orange",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.646 0.222 41.116)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.646 0.222 41.116)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.646 0.222 41.116)",
      darkPrimaryForeground: "oklch(0.985 0 0)",
      darkRing: "oklch(0.646 0.222 41.116)",
    },
  },

  // 7. Green — nature green primary
  {
    name: "Green",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.595 0.173 149.575)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.595 0.173 149.575)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.696 0.17 162.48)",
      darkPrimaryForeground: "oklch(0.145 0 0)",
      darkRing: "oklch(0.696 0.17 162.48)",
    },
  },

  // 8. Ocean — deep teal/cyan primary
  {
    name: "Ocean",
    colors: {
      ...LIGHT_BASE,
      primary: "oklch(0.545 0.155 217.876)",
      primaryForeground: "oklch(0.985 0 0)",
      ring: "oklch(0.545 0.155 217.876)",
      ...DARK_BASE,
      darkPrimary: "oklch(0.6 0.118 184.704)",
      darkPrimaryForeground: "oklch(0.145 0 0)",
      darkRing: "oklch(0.6 0.118 184.704)",
    },
  },
];
