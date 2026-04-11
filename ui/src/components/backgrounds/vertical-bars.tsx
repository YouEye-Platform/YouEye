/**
 * Vertical Bars Background
 *
 * Animated vertical bars with undulating heights driven by sine/noise patterns.
 * Bars shimmer through the color palette over time.
 */
"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  COLOR_PRESETS,
  DEFAULT_CUSTOMIZATION,
  hexToRgb,
  getPresetBackground,
  type AnimatedBackgroundProps,
} from "./index";

export function VerticalBars({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", handleMouseMove);

    const preset = COLOR_PRESETS[colorPreset];
    const colors = preset.colors.map(hexToRgb);

    const animate = () => {
      const { width, height } = canvas;
      const time = Date.now() * 0.001 * customization.speed;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      const barWidth = Math.max(4, Math.floor(8 * customization.scale));
      const gap = Math.max(2, Math.floor(4 * customization.scale));
      const totalBar = barWidth + gap;
      const barCount = Math.ceil(width / totalBar);

      for (let i = 0; i < barCount; i++) {
        const x = i * totalBar;

        // Height driven by sine waves
        const h1 = Math.sin(i * 0.1 + time) * 0.3;
        const h2 = Math.sin(i * 0.05 + time * 0.7) * 0.2;
        const h3 = Math.cos(i * 0.08 + time * 1.2) * 0.15;

        // Mouse interaction
        const dx = x - mouseRef.current.x;
        const dist = Math.abs(dx);
        const mouseFactor =
          dist < 150 * customization.reactivity
            ? (1 - dist / (150 * customization.reactivity)) * 0.3
            : 0;

        const heightFactor =
          (0.3 + h1 + h2 + h3 + mouseFactor) * customization.intensity;
        const barHeight = Math.max(10, heightFactor * height);

        const colorIdx = Math.floor((i + time * 2) % colors.length);
        const color = colors[colorIdx];
        const alpha = (0.4 + mouseFactor) * customization.intensity;

        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [colorPreset, customization, isDark, handleMouseMove]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className ?? ""}`}
      style={{ pointerEvents: "all" }}
    />
  );
}
