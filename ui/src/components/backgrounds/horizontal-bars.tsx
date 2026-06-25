/**
 * Horizontal Bars Background
 *
 * Flowing horizontal bars that stretch and shift with mouse interaction.
 * Each bar oscillates independently creating a curtain-like effect.
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

export function HorizontalBars({
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

      const barHeight = Math.max(4, Math.floor(8 * customization.scale));
      const gap = Math.max(2, Math.floor(4 * customization.scale));
      const totalBar = barHeight + gap;
      const barCount = Math.ceil(height / totalBar);

      for (let i = 0; i < barCount; i++) {
        const y = i * totalBar;

        // Width oscillation
        const w1 = Math.sin(i * 0.12 + time) * 0.3;
        const w2 = Math.cos(i * 0.06 + time * 0.8) * 0.2;
        const w3 = Math.sin(i * 0.09 + time * 1.5) * 0.15;

        // Mouse interaction
        const dy = y - mouseRef.current.y;
        const dist = Math.abs(dy);
        const mouseFactor =
          dist < 120 * customization.reactivity
            ? (1 - dist / (120 * customization.reactivity)) * 0.3
            : 0;

        const widthFactor =
          (0.3 + w1 + w2 + w3 + mouseFactor) * customization.intensity;
        const barWidth = Math.max(10, widthFactor * width);

        // Offset for flowing effect
        const xOffset = Math.sin(i * 0.15 + time * 0.5) * 50;

        const colorIdx = Math.floor((i + time * 2) % colors.length);
        const color = colors[colorIdx];
        const alpha = (0.3 + mouseFactor) * customization.intensity;

        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fillRect(xOffset, y, barWidth, barHeight);
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
