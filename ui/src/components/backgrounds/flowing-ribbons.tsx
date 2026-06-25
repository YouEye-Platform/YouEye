/**
 * Flowing Ribbons Background
 *
 * A grid mesh that deforms with wave effects, creating flowing ribbon-like
 * patterns. Points are connected to form a warping grid.
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

export function FlowingRibbons({
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

      const spacing = Math.floor(30 * customization.scale);
      const cols = Math.ceil(width / spacing) + 2;
      const rows = Math.ceil(height / spacing) + 2;

      // Calculate deformed grid points
      const points: { x: number; y: number }[][] = [];
      for (let row = 0; row < rows; row++) {
        points[row] = [];
        for (let col = 0; col < cols; col++) {
          const baseX = col * spacing;
          const baseY = row * spacing;

          // Wave deformation
          const waveX =
            Math.sin(baseY * 0.01 + time) * 15 * customization.intensity;
          const waveY =
            Math.cos(baseX * 0.01 + time * 0.8) * 15 * customization.intensity;

          // Mouse distortion
          const dx = baseX + waveX - mouseRef.current.x;
          const dy = baseY + waveY - mouseRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const pushRadius = 150 * customization.reactivity;
          let pushX = 0,
            pushY = 0;
          if (dist < pushRadius && dist > 0) {
            const force = (1 - dist / pushRadius) * 30;
            pushX = (dx / dist) * force;
            pushY = (dy / dist) * force;
          }

          points[row][col] = {
            x: baseX + waveX + pushX,
            y: baseY + waveY + pushY,
          };
        }
      }

      // Draw horizontal lines
      for (let row = 0; row < rows; row++) {
        const color = colors[row % colors.length];
        const alpha = 0.2 * customization.intensity;
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let col = 0; col < cols; col++) {
          const p = points[row][col];
          if (col === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }

      // Draw vertical lines
      for (let col = 0; col < cols; col++) {
        const color = colors[col % colors.length];
        const alpha = 0.15 * customization.intensity;
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let row = 0; row < rows; row++) {
          const p = points[row][col];
          if (row === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
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
