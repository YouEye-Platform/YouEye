/**
 * Clock Theme Presets
 *
 * Selectable visual themes for the clock widget.
 * Each theme defines typography, colors, and effects for time and date display.
 */

export interface ClockThemeCSS {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly letterSpacing: string;
  readonly color: string;
  readonly gradient?: {
    readonly from: string;
    readonly to: string;
    readonly direction: string;
  };
  readonly textShadow: string;
  readonly textTransform?: string;
}

export interface ClockTheme {
  readonly id: string;
  readonly name: string;
  readonly category: ClockCategory;
  readonly time: ClockThemeCSS;
  readonly date: Partial<ClockThemeCSS> & { readonly color: string };
  /** Thumbnail preview needs a dark backdrop */
  readonly needsDarkBg?: boolean;
}

export type ClockCategory = "clean" | "bold" | "glow" | "retro";

export const CLOCK_CATEGORIES: readonly { readonly id: ClockCategory; readonly label: string }[] = [
  { id: "clean", label: "Clean" },
  { id: "bold", label: "Bold" },
  { id: "glow", label: "Glow" },
  { id: "retro", label: "Retro" },
] as const;

export const CLOCK_PRESETS: readonly ClockTheme[] = [
  // ─── Clean ───
  {
    id: "gradient",
    name: "Gradient",
    category: "clean",
    time: {
      fontFamily: "inherit",
      fontWeight: 600,
      letterSpacing: "0.05em",
      color: "var(--primary)",
      gradient: {
        from: "var(--primary)",
        to: "color-mix(in oklch, var(--primary) 60%, var(--muted-foreground))",
        direction: "135deg",
      },
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    category: "clean",
    time: {
      fontFamily: "inherit",
      fontWeight: 300,
      letterSpacing: "-0.02em",
      color: "var(--foreground)",
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 400,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    },
  },
  {
    id: "soft",
    name: "Soft",
    category: "clean",
    time: {
      fontFamily: "inherit",
      fontWeight: 400,
      letterSpacing: "0.02em",
      color: "var(--muted-foreground)",
      textShadow: "none",
    },
    date: {
      color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
      fontWeight: 400,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
  },

  // ─── Bold ───
  {
    id: "solid",
    name: "Solid",
    category: "bold",
    time: {
      fontFamily: "inherit",
      fontWeight: 800,
      letterSpacing: "0.04em",
      color: "var(--foreground)",
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 600,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
  },
  {
    id: "accent",
    name: "Accent",
    category: "bold",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.02em",
      color: "var(--primary)",
      textShadow: "none",
    },
    date: {
      color: "var(--foreground)",
      fontWeight: 500,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    category: "bold",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.03em",
      color: "#f97316",
      gradient: {
        from: "#f97316",
        to: "#ec4899",
        direction: "135deg",
      },
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    category: "bold",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.03em",
      color: "#06b6d4",
      gradient: {
        from: "#06b6d4",
        to: "#3b82f6",
        direction: "135deg",
      },
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },

  // ─── Glow ───
  {
    id: "neon",
    name: "Neon",
    category: "glow",
    needsDarkBg: true,
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.06em",
      color: "#22d3ee",
      textShadow: "0 0 7px #22d3ee, 0 0 20px #22d3ee80, 0 0 40px #22d3ee40",
    },
    date: {
      color: "#22d3ee99",
      fontWeight: 500,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      textShadow: "0 0 5px #22d3ee60",
    },
  },
  {
    id: "neon-pink",
    name: "Neon Pink",
    category: "glow",
    needsDarkBg: true,
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.06em",
      color: "#f472b6",
      textShadow: "0 0 7px #f472b6, 0 0 20px #f472b680, 0 0 40px #f472b640",
    },
    date: {
      color: "#f472b699",
      fontWeight: 500,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      textShadow: "0 0 5px #f472b660",
    },
  },
  {
    id: "glow-primary",
    name: "Glow",
    category: "glow",
    needsDarkBg: true,
    time: {
      fontFamily: "inherit",
      fontWeight: 600,
      letterSpacing: "0.04em",
      color: "var(--primary)",
      textShadow: "0 0 10px var(--primary), 0 0 30px color-mix(in oklch, var(--primary) 50%, transparent)",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },

  // ─── Retro ───
  {
    id: "terminal",
    name: "Terminal",
    category: "retro",
    needsDarkBg: true,
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 700,
      letterSpacing: "0.1em",
      color: "#4ade80",
      textShadow: "0 0 5px #4ade8080",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "#4ade8099",
      fontWeight: 400,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      textShadow: "0 0 3px #4ade8040",
    },
  },
  {
    id: "digital",
    name: "Digital",
    category: "retro",
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 700,
      letterSpacing: "0.12em",
      color: "var(--foreground)",
      textShadow: "none",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "var(--muted-foreground)",
      fontWeight: 400,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },
  {
    id: "amber",
    name: "Amber",
    category: "retro",
    needsDarkBg: true,
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 700,
      letterSpacing: "0.1em",
      color: "#fbbf24",
      textShadow: "0 0 5px #fbbf2480",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "#fbbf2499",
      fontWeight: 400,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      textShadow: "0 0 3px #fbbf2440",
    },
  },
] as const;

export function getClockPresetsByCategory(category: ClockCategory): readonly ClockTheme[] {
  return CLOCK_PRESETS.filter((p) => p.category === category);
}

export function getClockPreset(id: string): ClockTheme | undefined {
  return CLOCK_PRESETS.find((p) => p.id === id);
}
