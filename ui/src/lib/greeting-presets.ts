/**
 * WordArt Greeting Presets
 *
 * 17 curated styles for the greeting widget, organized by category.
 * Each preset defines typography, colors, shadows, and optional animations.
 * Self-hosted fonts: Caveat, Dancing Script, Playfair Display (in /public/fonts/).
 */

export interface GreetingPreset {
  readonly id: string;
  readonly name: string;
  readonly category: GreetingCategory;
  readonly css: GreetingPresetCSS;
  readonly animation?: string;
  /** Label shown in the cursor-blink terminal format */
  readonly terminalFormat?: boolean;
}

export interface GreetingPresetCSS {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: number;
  readonly letterSpacing: string;
  readonly textTransform: string;
  readonly color: string;
  readonly gradient?: {
    readonly from: string;
    readonly to: string;
    readonly direction: string;
  };
  readonly textShadow: string;
  readonly background?: string;
  readonly borderRadius?: string;
  readonly padding?: string;
  readonly border?: string;
  readonly backdropFilter?: string;
  readonly WebkitBackgroundClip?: string;
  readonly WebkitTextFillColor?: string;
  readonly backgroundSize?: string;
}

export type GreetingCategory = "classic" | "animated" | "decorative" | "minimal" | "fun";

export const GREETING_CATEGORIES: readonly { readonly id: GreetingCategory; readonly label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "minimal", label: "Minimal" },
  { id: "decorative", label: "Decorative" },
  { id: "animated", label: "Animated" },
  { id: "fun", label: "Fun" },
] as const;

export const GREETING_PRESETS: readonly GreetingPreset[] = [
  // ─── Classic ───
  {
    id: "default",
    name: "Default",
    category: "classic",
    css: {
      fontFamily: "'Dancing Script', cursive",
      fontSize: "2.5rem",
      fontWeight: 500,
      letterSpacing: "0.01em",
      textTransform: "none",
      color: "var(--foreground)",
      textShadow: "0 1px 3px rgba(0,0,0,0.08)",
    },
  },
  {
    id: "elegant",
    name: "Elegant",
    category: "classic",
    css: {
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: "2.25rem",
      fontWeight: 400,
      letterSpacing: "0.04em",
      textTransform: "none",
      color: "var(--foreground)",
      textShadow: "0 1px 3px rgba(0,0,0,0.1)",
    },
  },
  {
    id: "luxury",
    name: "Luxury",
    category: "classic",
    css: {
      fontFamily: "'Playfair Display', Georgia, serif",
      fontSize: "2rem",
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "transparent",
      textShadow: "none",
      gradient: { from: "#BF953F", to: "#FCF6BA", direction: "135deg" },
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
  },

  // ─── Minimal ───
  {
    id: "monochrome",
    name: "Monochrome",
    category: "minimal",
    css: {
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "2.5rem",
      fontWeight: 900,
      letterSpacing: "-0.03em",
      textTransform: "none",
      color: "var(--foreground)",
      textShadow: "2px 2px 0 rgba(0,0,0,0.06)",
    },
  },
  {
    id: "clean",
    name: "Clean",
    category: "minimal",
    css: {
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: "1.75rem",
      fontWeight: 400,
      letterSpacing: "0.02em",
      textTransform: "none",
      color: "var(--muted-foreground)",
      textShadow: "none",
    },
  },
  {
    id: "brutalist",
    name: "Brutalist",
    category: "minimal",
    css: {
      fontFamily: "'Courier New', Courier, monospace",
      fontSize: "2rem",
      fontWeight: 900,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      color: "var(--foreground)",
      textShadow: "none",
      border: "3px solid currentColor",
      padding: "0.5rem 1.25rem",
    },
  },

  // ─── Decorative ───
  {
    id: "glassmorphism",
    name: "Glass",
    category: "decorative",
    css: {
      fontFamily: "system-ui, sans-serif",
      fontSize: "2rem",
      fontWeight: 600,
      letterSpacing: "0.01em",
      textTransform: "none",
      color: "#ffffff",
      textShadow: "0 1px 2px rgba(0,0,0,0.2)",
      background: "rgba(255,255,255,0.12)",
      borderRadius: "16px",
      padding: "0.75rem 1.5rem",
      border: "1px solid rgba(255,255,255,0.18)",
      backdropFilter: "blur(12px)",
    },
  },
  {
    id: "handwritten",
    name: "Handwritten",
    category: "decorative",
    css: {
      fontFamily: "'Caveat', cursive",
      fontSize: "2.75rem",
      fontWeight: 700,
      letterSpacing: "0.01em",
      textTransform: "none",
      color: "#4A3728",
      textShadow: "none",
    },
  },
  {
    id: "calligraphy",
    name: "Calligraphy",
    category: "decorative",
    css: {
      fontFamily: "'Dancing Script', cursive",
      fontSize: "2.5rem",
      fontWeight: 400,
      letterSpacing: "0.02em",
      textTransform: "none",
      color: "var(--foreground)",
      textShadow: "0 1px 2px rgba(0,0,0,0.08)",
    },
  },
  {
    id: "vaporwave",
    name: "Vaporwave",
    category: "decorative",
    css: {
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: "2rem",
      fontWeight: 700,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color: "transparent",
      textShadow: "none",
      gradient: { from: "#FF71CE", to: "#B967FF", direction: "90deg" },
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
  },

  // ─── Animated ───
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    category: "animated",
    css: {
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: "2rem",
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      color: "#00fff9",
      textShadow: "0 0 10px #00fff9, 0 0 40px #00fff9, 2px 0 #ff00de, -2px 0 #00fff9",
    },
    animation: "wordart-glitch 3s ease-in-out infinite",
  },
  {
    id: "terminal",
    name: "Terminal",
    category: "animated",
    css: {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      fontSize: "1.5rem",
      fontWeight: 400,
      letterSpacing: "0.02em",
      textTransform: "none",
      color: "#4ADE80",
      textShadow: "0 0 5px rgba(74,222,128,0.4)",
      background: "rgba(0,0,0,0.75)",
      borderRadius: "8px",
      padding: "0.75rem 1.25rem",
      border: "1px solid rgba(74,222,128,0.2)",
    },
    terminalFormat: true,
  },
  {
    id: "neon-pulse",
    name: "Neon Pulse",
    category: "animated",
    css: {
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: "2.25rem",
      fontWeight: 800,
      letterSpacing: "0.02em",
      textTransform: "none",
      color: "#E879F9",
      textShadow: "0 0 8px #E879F9, 0 0 24px rgba(232,121,249,0.4), 0 0 48px rgba(232,121,249,0.2)",
    },
    animation: "wordart-neon-pulse 2s ease-in-out infinite",
  },
  {
    id: "shimmer",
    name: "Shimmer",
    category: "animated",
    css: {
      fontFamily: "system-ui, sans-serif",
      fontSize: "2.25rem",
      fontWeight: 700,
      letterSpacing: "0.01em",
      textTransform: "none",
      color: "transparent",
      textShadow: "none",
      gradient: { from: "#9333ea", to: "#ec4899", direction: "90deg" },
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      backgroundSize: "200% auto",
    },
    animation: "wordart-shimmer 3s linear infinite",
  },

  // ─── Fun ───
  {
    id: "playful",
    name: "Playful",
    category: "fun",
    css: {
      fontFamily: "'Caveat', cursive",
      fontSize: "2.5rem",
      fontWeight: 700,
      letterSpacing: "0.01em",
      textTransform: "none",
      color: "transparent",
      textShadow: "none",
      gradient: { from: "#F472B6", to: "#818CF8", direction: "90deg" },
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
    animation: "wordart-bounce 2s ease-in-out infinite",
  },
  {
    id: "retro",
    name: "Retro",
    category: "fun",
    css: {
      fontFamily: "'Courier New', Courier, monospace",
      fontSize: "2rem",
      fontWeight: 700,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "#FBBF24",
      textShadow: "3px 3px 0 #92400E, 4px 4px 0 rgba(0,0,0,0.15)",
    },
  },
  {
    id: "dreamy",
    name: "Dreamy",
    category: "fun",
    css: {
      fontFamily: "'Dancing Script', cursive",
      fontSize: "2.5rem",
      fontWeight: 400,
      letterSpacing: "0.02em",
      textTransform: "none",
      color: "transparent",
      textShadow: "none",
      gradient: { from: "#C084FC", to: "#67E8F9", direction: "135deg" },
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
    animation: "wordart-float 4s ease-in-out infinite",
  },
] as const;

/** Lookup a preset by ID */
export function getGreetingPreset(id: string): GreetingPreset {
  return GREETING_PRESETS.find((p) => p.id === id) ?? GREETING_PRESETS[0];
}

/** Get presets filtered by category */
export function getPresetsByCategory(category: GreetingCategory): readonly GreetingPreset[] {
  return GREETING_PRESETS.filter((p) => p.category === category);
}

// ─── Background Gradient Presets ───

export interface GradientBackgroundPreset {
  readonly id: string;
  readonly name: string;
  readonly css: string;
  readonly animated: boolean;
}

export const GRADIENT_BACKGROUND_PRESETS: readonly GradientBackgroundPreset[] = [
  {
    id: "aurora",
    name: "Aurora",
    css: "linear-gradient(135deg, #0f2027 0%, #203a43 25%, #2c5364 50%, #0f4c3a 75%, #1a3a2a 100%)",
    animated: false,
  },
  {
    id: "sunset",
    name: "Sunset",
    css: "linear-gradient(135deg, #ee9ca7 0%, #ffdde1 25%, #fcb69f 50%, #ff9a9e 75%, #fecfef 100%)",
    animated: false,
  },
  {
    id: "midnight",
    name: "Midnight",
    css: "linear-gradient(135deg, #0c0c1d 0%, #111133 40%, #1a1a4e 70%, #0c0c2d 100%)",
    animated: false,
  },
  {
    id: "forest",
    name: "Forest",
    css: "linear-gradient(160deg, #0a2e12 0%, #134e25 30%, #1a6b35 60%, #0d3f1a 100%)",
    animated: false,
  },
  {
    id: "cotton-candy",
    name: "Cotton Candy",
    css: "linear-gradient(135deg, #fad0c4 0%, #ffd1ff 30%, #c2e9fb 60%, #d4fc79 100%)",
    animated: false,
  },
] as const;
