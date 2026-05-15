/**
 * Flowing Dots Background
 *
 * Dots that flow in organic patterns driven by simplex-like noise.
 * Creates a fluid, natural movement effect.
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

/** Simple hash-based noise (avoids external dependency) */
function pseudoNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 113.5) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smooth interpolation
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = pseudoNoise(ix, iy, seed);
  const n10 = pseudoNoise(ix + 1, iy, seed);
  const n01 = pseudoNoise(ix, iy + 1, seed);
  const n11 = pseudoNoise(ix + 1, iy + 1, seed);

  const nx0 = n00 + sx * (n10 - n00);
  const nx1 = n01 + sx * (n11 - n01);
  return nx0 + sy * (nx1 - nx0);
}

interface FlowDot {
  x: number;
  y: number;
  size: number;
  colorIdx: number;
  seed: number;
}

export function FlowingDots({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const dotsRef = useRef<FlowDot[]>([]);

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

    // Initialize dots
    const dotCount = Math.floor(150 * customization.scale);
    if (dotsRef.current.length !== dotCount) {
      dotsRef.current = Array.from({ length: dotCount }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: 1.5 + Math.random() * 3,
        colorIdx: Math.floor(Math.random() * 6),
        seed: Math.random() * 100,
      }));
    }

    const animate = () => {
      const { width, height } = canvas;
      const time = Date.now() * 0.001 * customization.speed;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      for (const dot of dotsRef.current) {
        // Flow direction from noise field
        const noiseScale = 0.003 * customization.scale;
        const angle =
          smoothNoise(dot.x * noiseScale, dot.y * noiseScale, time * 0.1 + dot.seed) *
          Math.PI *
          4;

        const speed = 0.8 * customization.speed;
        dot.x += Math.cos(angle) * speed;
        dot.y += Math.sin(angle) * speed;

        // Mouse repulsion
        const dx = dot.x - mouseRef.current.x;
        const dy = dot.y - mouseRef.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120 * customization.reactivity && dist > 0) {
          const force = (1 - dist / (120 * customization.reactivity)) * 2;
          dot.x += (dx / dist) * force;
          dot.y += (dy / dist) * force;
        }

        // Wrap around
        if (dot.x < -10) dot.x = width + 10;
        if (dot.x > width + 10) dot.x = -10;
        if (dot.y < -10) dot.y = height + 10;
        if (dot.y > height + 10) dot.y = -10;

        // Draw
        const color = colors[dot.colorIdx % colors.length];
        const pulse = Math.sin(time * 2 + dot.seed) * 0.3 + 0.7;
        const alpha = 0.4 * pulse * customization.intensity;

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.size * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fill();
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
