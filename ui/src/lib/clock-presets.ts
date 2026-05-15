/**
 * Clock Theme Presets
 *
 * Selectable visual themes for the clock widget, matching the greeting
 * widget's preset structure. 5 categories, 17 curated styles.
 * Self-hosted fonts: Caveat, Dancing Script, Playfair Display (in /public/fonts/).
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
  /** CSS animation applied to the time element */
  readonly animation?: string;
}

export type ClockCategory = "classic" | "minimal" | "decorative" | "animated" | "fun";

export const CLOCK_CATEGORIES: readonly { readonly id: ClockCategory; readonly label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "minimal", label: "Minimal" },
  { id: "decorative", label: "Decorative" },
  { id: "animated", label: "Animated" },
  { id: "fun", label: "Fun" },
] as const;

export const CLOCK_PRESETS: readonly ClockTheme[] = [
  // ─── Classic ───
  {
    id: "gradient",
    name: "Default",
    category: "classic",
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
    id: "elegant",
    name: "Elegant",
    category: "classic",
    time: {
      fontFamily: "'Playfair Display', Georgia, serif",
      fontWeight: 400,
      letterSpacing: "0.04em",
      color: "var(--foreground)",
      textShadow: "0 1px 3px rgba(0,0,0,0.1)",
    },
    date: {
      fontFamily: "'Playfair Display', Georgia, serif",
      color: "var(--muted-foreground)",
      fontWeight: 400,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
  },
  {
    id: "luxury",
    name: "Luxury",
    category: "classic",
    time: {
      fontFamily: "'Playfair Display', Georgia, serif",
      fontWeight: 700,
      letterSpacing: "0.08em",
      color: "transparent",
      gradient: { from: "#BF953F", to: "#FCF6BA", direction: "135deg" },
      textShadow: "none",
    },
    date: {
      fontFamily: "'Playfair Display', Georgia, serif",
      color: "#BF953F",
      fontWeight: 500,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
  },

  // ─── Minimal ───
  {
    id: "monochrome",
    name: "Monochrome",
    category: "minimal",
    time: {
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: 900,
      letterSpacing: "-0.03em",
      color: "var(--foreground)",
      textShadow: "2px 2px 0 rgba(0,0,0,0.06)",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 600,
      letterSpacing: "0.04em",
    },
  },
  {
    id: "clean",
    name: "Clean",
    category: "minimal",
    time: {
      fontFamily: "inherit",
      fontWeight: 300,
      letterSpacing: "-0.02em",
      color: "var(--muted-foreground)",
      textShadow: "none",
    },
    date: {
      color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
      fontWeight: 400,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    },
  },
  {
    id: "brutalist",
    name: "Brutalist",
    category: "minimal",
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 900,
      letterSpacing: "0.06em",
      color: "var(--foreground)",
      textShadow: "none",
      textTransform: "uppercase",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "var(--muted-foreground)",
      fontWeight: 700,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },

  // ─── Decorative ───
  {
    id: "handwritten",
    name: "Handwritten",
    category: "decorative",
    time: {
      fontFamily: "'Caveat', cursive",
      fontWeight: 700,
      letterSpacing: "0.01em",
      color: "#4A3728",
      textShadow: "none",
    },
    date: {
      fontFamily: "'Caveat', cursive",
      color: "#8B7355",
      fontWeight: 600,
      letterSpacing: "0.04em",
    },
  },
  {
    id: "calligraphy",
    name: "Calligraphy",
    category: "decorative",
    time: {
      fontFamily: "'Dancing Script', cursive",
      fontWeight: 400,
      letterSpacing: "0.02em",
      color: "var(--foreground)",
      textShadow: "0 1px 2px rgba(0,0,0,0.08)",
    },
    date: {
      fontFamily: "'Dancing Script', cursive",
      color: "var(--muted-foreground)",
      fontWeight: 400,
      letterSpacing: "0.06em",
    },
  },
  {
    id: "vaporwave",
    name: "Vaporwave",
    category: "decorative",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.12em",
      color: "transparent",
      gradient: { from: "#FF71CE", to: "#B967FF", direction: "90deg" },
      textShadow: "none",
    },
    date: {
      color: "#B967FF",
      fontWeight: 500,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    category: "decorative",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.03em",
      color: "#f97316",
      gradient: { from: "#f97316", to: "#ec4899", direction: "135deg" },
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
  },

  // ─── Animated ───
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    category: "animated",
    needsDarkBg: true,
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 700,
      letterSpacing: "0.04em",
      color: "#00fff9",
      textShadow: "0 0 10px #00fff9, 0 0 40px #00fff9, 2px 0 #ff00de, -2px 0 #00fff9",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "#00fff999",
      fontWeight: 400,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      textShadow: "0 0 5px #00fff960",
    },
    animation: "clock-glitch 3s ease-in-out infinite",
  },
  {
    id: "neon-pulse",
    name: "Neon Pulse",
    category: "animated",
    needsDarkBg: true,
    time: {
      fontFamily: "inherit",
      fontWeight: 800,
      letterSpacing: "0.02em",
      color: "#E879F9",
      textShadow: "0 0 8px #E879F9, 0 0 24px rgba(232,121,249,0.4), 0 0 48px rgba(232,121,249,0.2)",
    },
    date: {
      color: "#E879F999",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
    animation: "clock-neon-pulse 2s ease-in-out infinite",
  },
  {
    id: "shimmer",
    name: "Shimmer",
    category: "animated",
    time: {
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.01em",
      color: "transparent",
      gradient: { from: "#9333ea", to: "#ec4899", direction: "90deg" },
      textShadow: "none",
    },
    date: {
      color: "var(--muted-foreground)",
      fontWeight: 500,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
    },
    animation: "clock-shimmer 3s linear infinite",
  },
  {
    id: "terminal",
    name: "Terminal",
    category: "animated",
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

  // ─── Fun ───
  {
    id: "playful",
    name: "Playful",
    category: "fun",
    time: {
      fontFamily: "'Caveat', cursive",
      fontWeight: 700,
      letterSpacing: "0.01em",
      color: "transparent",
      gradient: { from: "#F472B6", to: "#818CF8", direction: "90deg" },
      textShadow: "none",
    },
    date: {
      fontFamily: "'Caveat', cursive",
      color: "#818CF8",
      fontWeight: 600,
      letterSpacing: "0.04em",
    },
    animation: "clock-bounce 2s ease-in-out infinite",
  },
  {
    id: "retro",
    name: "Retro",
    category: "fun",
    time: {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: 700,
      letterSpacing: "0.08em",
      color: "#FBBF24",
      textShadow: "3px 3px 0 #92400E, 4px 4px 0 rgba(0,0,0,0.15)",
    },
    date: {
      fontFamily: "'Courier New', Courier, monospace",
      color: "#FBBF24",
      fontWeight: 400,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      textShadow: "2px 2px 0 #92400E",
    },
  },
  {
    id: "dreamy",
    name: "Dreamy",
    category: "fun",
    time: {
      fontFamily: "'Dancing Script', cursive",
      fontWeight: 400,
      letterSpacing: "0.02em",
      color: "transparent",
      gradient: { from: "#C084FC", to: "#67E8F9", direction: "135deg" },
      textShadow: "none",
    },
    date: {
      fontFamily: "'Dancing Script', cursive",
      color: "#C084FC",
      fontWeight: 400,
      letterSpacing: "0.06em",
    },
    animation: "clock-float 4s ease-in-out infinite",
  },
] as const;

export function getClockPresetsByCategory(category: ClockCategory): readonly ClockTheme[] {
  return CLOCK_PRESETS.filter((p) => p.category === category);
}

export function getClockPreset(id: string): ClockTheme | undefined {
  return CLOCK_PRESETS.find((p) => p.id === id);
}
