/**
 * Flowing Lines Background
 *
 * Horizontal wavy lines that flow with mouse interaction.
 * Uses sine waves with noise offsets and ripple effects from cursor.
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

export function FlowingLines({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const rippleRef = useRef<{ x: number; y: number; time: number }[]>([]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const handleClick = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    rippleRef.current.push({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      time: Date.now(),
    });
    if (rippleRef.current.length > 5) rippleRef.current.shift();
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
    canvas.addEventListener("click", handleClick);

    const preset = COLOR_PRESETS[colorPreset];
    const colors = preset.colors.map(hexToRgb);

    const animate = () => {
      const { width, height } = canvas;
      const time = Date.now() * 0.001 * customization.speed;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      const lineCount = Math.floor(12 * customization.scale);
      const spacing = height / (lineCount + 1);

      for (let i = 0; i < lineCount; i++) {
        const yBase = spacing * (i + 1);
        const color = colors[i % colors.length];
        const alpha = customization.intensity * 0.3;
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let x = 0; x <= width; x += 4) {
          const noise1 = Math.sin(x * 0.003 + time + i * 0.7) * 40;
          const noise2 = Math.sin(x * 0.007 + time * 1.3 + i) * 20;
          const noise3 = Math.cos(x * 0.002 + time * 0.5 + i * 0.3) * 30;

          // Mouse interaction
          const dx = x - mouseRef.current.x;
          const dy = yBase + noise1 + noise2 + noise3 - mouseRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const push = dist < 150 ? (1 - dist / 150) * 50 * customization.reactivity : 0;
          const pushDir = dy > 0 ? 1 : -1;

          // Ripple effects
          let rippleOffset = 0;
          for (const ripple of rippleRef.current) {
            const elapsed = (Date.now() - ripple.time) * 0.001;
            if (elapsed < 2) {
              const rdx = x - ripple.x;
              const rdy = yBase - ripple.y;
              const rdist = Math.sqrt(rdx * rdx + rdy * rdy);
              const wave = Math.sin(rdist * 0.05 - elapsed * 6) * 20;
              const falloff = Math.max(0, 1 - elapsed / 2) * Math.max(0, 1 - rdist / 400);
              rippleOffset += wave * falloff;
            }
          }

          const y = yBase + noise1 + noise2 + noise3 + push * pushDir + rippleOffset;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
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
      canvas.removeEventListener("click", handleClick);
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [colorPreset, customization, isDark, handleMouseMove, handleClick]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className ?? ""}`}
      style={{ pointerEvents: "all" }}
    />
  );
}
