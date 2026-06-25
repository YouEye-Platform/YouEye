/**
 * Icon Configuration — shared type (mirrors UI's icon-config.ts)
 */

export interface IconConfig {
  mode: "letter" | "lucide" | "emoji" | "upload";
  letter?: string;
  lucideIcon?: string;
  lucideColor?: string;
  emoji?: string;
  uploadUrl?: string;
  background: {
    type: "solid" | "gradient" | "transparent";
    color?: string;
    gradient?: { from: string; to: string };
  };
  shape: "circle" | "rounded-square" | "square";
}

export const DEFAULT_ICON_CONFIG: IconConfig = {
  mode: "letter",
  letter: undefined,
  background: {
    type: "solid",
    color: "#8B5CF6",
  },
  shape: "rounded-square",
};
