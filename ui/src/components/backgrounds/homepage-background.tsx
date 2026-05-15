/**
 * Homepage Background
 *
 * Renders the appropriate background based on user preference:
 * - solid: Single CSS color
 * - animated: One of the 10 canvas-based animations
 * - image: User-uploaded image (future)
 *
 * Sits behind widgets at z-0 position.
 */
"use client";

import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import {
  ANIMATED_BACKGROUNDS,
  COLOR_PRESETS,
  DEFAULT_CUSTOMIZATION,
  getPresetBackground,
  type AnimatedBackgroundStyle,
  type ColorPreset,
  type BackgroundCustomization,
} from "./index";
import { BackgroundErrorBoundary } from "./background-error-boundary";

export interface BackgroundConfig {
  type: "solid" | "animated" | "image";
  settings: {
    solidColor?: string;
    animatedStyle?: AnimatedBackgroundStyle;
    animatedPreset?: ColorPreset;
    customization?: BackgroundCustomization;
    imageUrl?: string;
    disableAnimations?: boolean;
  };
}

export const DEFAULT_BACKGROUND: BackgroundConfig = {
  type: "animated",
  settings: {
    animatedStyle: "smooth-wavy",
    animatedPreset: "sunset",
    customization: DEFAULT_CUSTOMIZATION,
  },
};

interface HomepageBackgroundProps {
  config: BackgroundConfig;
}

export function HomepageBackground({ config }: HomepageBackgroundProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    // Respect OS-level reduce motion preference
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motionQuery.matches) {
      setReduceMotion(true);
      return;
    }

    // Detect low-powered devices
    const cores = navigator.hardwareConcurrency || 2;
    if (cores <= 2) {
      setReduceMotion(true);
    }
  }, []);

  // User manual toggle or auto-detected
  const shouldDisableAnimations =
    config.settings.disableAnimations || reduceMotion;

  const content = useMemo(() => {
    switch (config.type) {
      case "solid": {
        const color =
          config.settings.solidColor ?? (isDark ? "#111827" : "#f9fafb");
        // Support gradient CSS strings (e.g. "linear-gradient(...)") as solid backgrounds
        const isGradient = color.startsWith("linear-gradient") || color.startsWith("radial-gradient");
        return (
          <div
            className="absolute inset-0 w-full h-full"
            style={isGradient ? { background: color } : { backgroundColor: color }}
          />
        );
      }

      case "animated": {
        // If animations are disabled, fall back to the preset's solid background color
        if (shouldDisableAnimations) {
          const presetKey = config.settings.animatedPreset ?? "purple";
          const preset = COLOR_PRESETS[presetKey];
          const bg = getPresetBackground(preset, isDark);
          return (
            <div
              className="absolute inset-0 w-full h-full"
              style={{ backgroundColor: bg }}
            />
          );
        }

        const style = config.settings.animatedStyle ?? "flowing-lines";
        const bg = ANIMATED_BACKGROUNDS[style];
        if (!bg) return null;

        const Component = bg.component;
        const preset = config.settings.animatedPreset ?? "purple";
        const customization =
          config.settings.customization ?? DEFAULT_CUSTOMIZATION;

        return (
          <BackgroundErrorBoundary>
            <Component
              colorPreset={preset}
              customization={customization}
              isDark={isDark}
            />
          </BackgroundErrorBoundary>
        );
      }

      case "image": {
        const url = config.settings.imageUrl;
        if (!url) return null;
        return (
          <div
            className="absolute inset-0 w-full h-full bg-cover bg-center"
            style={{ backgroundImage: `url(${url})` }}
          />
        );
      }

      default:
        return null;
    }
  }, [config, isDark, shouldDisableAnimations]);

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      {content}
      {/* Subtle gradient overlay for readability on top of background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: isDark
            ? "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.3) 100%)"
            : "radial-gradient(ellipse at center, transparent 30%, rgba(255,255,255,0.2) 100%)",
        }}
      />
    </div>
  );
}
