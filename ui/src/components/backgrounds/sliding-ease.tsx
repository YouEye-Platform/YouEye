/**
 * Sliding Ease Background
 *
 * Smooth sliding bars with easing transitions between random target widths.
 * Creates an organic, breathing feel as bars expand and contract.
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

interface BarState {
  current: number;
  target: number;
  nextChange: number;
}

export function SlidingEase({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const barsRef = useRef<BarState[]>([]);

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

    // Easing function (ease in-out cubic)
    const ease = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const barHeight = Math.max(6, Math.floor(12 * customization.scale));
    const gap = Math.max(2, Math.floor(4 * customization.scale));
    const totalBar = barHeight + gap;

    const animate = () => {
      const { width, height } = canvas;
      const time = Date.now() * 0.001;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      const barCount = Math.ceil(height / totalBar);

      // Initialize bars if needed
      if (barsRef.current.length !== barCount) {
        barsRef.current = Array.from({ length: barCount }, () => ({
          current: Math.random() * 0.5 + 0.1,
          target: Math.random() * 0.7 + 0.1,
          nextChange: time + Math.random() * 3,
        }));
      }

      for (let i = 0; i < barCount; i++) {
        const bar = barsRef.current[i];
        const y = i * totalBar;

        // Update targets periodically
        if (time > bar.nextChange) {
          bar.current = bar.target;
          bar.target = Math.random() * 0.7 + 0.1;
          bar.nextChange = time + (2 + Math.random() * 3) / customization.speed;
        }

        // Ease toward target
        const progress = Math.min(
          1,
          (time - (bar.nextChange - (2 + Math.random() * 3) / customization.speed)) /
            ((2 + Math.random() * 3) / customization.speed)
        );
        const eased = ease(Math.max(0, Math.min(1, progress)));
        const widthFactor = bar.current + (bar.target - bar.current) * eased;

        // Mouse interaction
        const dy = y - mouseRef.current.y;
        const dist = Math.abs(dy);
        const mouseFactor =
          dist < 100 * customization.reactivity
            ? (1 - dist / (100 * customization.reactivity)) * 0.2
            : 0;

        const barWidth =
          (widthFactor + mouseFactor) * width * customization.intensity;

        const colorIdx = i % colors.length;
        const color = colors[colorIdx];
        const alpha = (0.35 + mouseFactor) * customization.intensity;

        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fillRect(0, y, Math.max(0, barWidth), barHeight);
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
