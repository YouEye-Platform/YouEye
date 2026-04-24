/**
 * Icon Configuration — shared type for the server icon/favicon system.
 *
 * The icon is server-wide (admin sets it). Used as favicon for UI, CP, and Authentik.
 * In "letter" mode the icon auto-derives from the current wordart style.
 */

export interface IconConfig {
  mode: "letter" | "lucide" | "emoji" | "upload";

  /** Letter mode — first char of site name (or custom) rendered with wordart style */
  letter?: string;

  /** Lucide icon name (kebab-case, e.g. "server") */
  lucideIcon?: string;
  lucideColor?: string;

  /** Emoji character (e.g. "🎬") */
  emoji?: string;

  /** Upload mode — path to uploaded file */
  uploadUrl?: string;

  /** Background style */
  background: {
    type: "solid" | "gradient" | "transparent";
    color?: string;
    gradient?: { from: string; to: string };
  };

  /** Outer shape */
  shape: "circle" | "rounded-square" | "square";
}

export const DEFAULT_ICON_CONFIG: IconConfig = {
  mode: "letter",
  letter: undefined, // auto from site name
  background: {
    type: "solid",
    color: "#8B5CF6",
  },
  shape: "rounded-square",
};

/** Sizes to render for favicon/PWA/apple-touch */
export const ICON_SIZES = [16, 32, 48, 180, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];
