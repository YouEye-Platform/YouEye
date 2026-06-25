/**
 * Smooth Wavy Background
 *
 * Multiple layers of wavy lines flowing in different directions.
 * Creates a calm, serene atmosphere with overlapping sine waves.
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

export function SmoothWavy({
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

    // Define wave layers
    const layers = [
      { freq: 0.003, amp: 60, speed: 0.5, yOffset: 0.3 },
      { freq: 0.005, amp: 40, speed: 0.7, yOffset: 0.5 },
      { freq: 0.004, amp: 50, speed: 0.3, yOffset: 0.7 },
      { freq: 0.006, amp: 35, speed: 0.9, yOffset: 0.4 },
      { freq: 0.002, amp: 70, speed: 0.4, yOffset: 0.6 },
    ];

    const animate = () => {
      const { width, height } = canvas;
      const time = Date.now() * 0.001 * customization.speed;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      const layerCount = Math.min(layers.length, Math.ceil(5 * customization.scale));

      for (let l = 0; l < layerCount; l++) {
        const layer = layers[l];
        const color = colors[l % colors.length];
        const baseY = height * layer.yOffset;

        ctx.beginPath();
        ctx.lineWidth = 2;
        const alpha = 0.25 * customization.intensity;
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;

        for (let x = 0; x <= width; x += 3) {
          const wave1 =
            Math.sin(x * layer.freq + time * layer.speed) *
            layer.amp *
            customization.intensity;
          const wave2 =
            Math.sin(x * layer.freq * 1.5 + time * layer.speed * 0.7 + l) *
            layer.amp *
            0.5;
          const wave3 =
            Math.cos(x * layer.freq * 0.5 + time * layer.speed * 1.2) *
            layer.amp *
            0.3;

          // Mouse distortion
          const dx = x - mouseRef.current.x;
          const dy = baseY + wave1 + wave2 + wave3 - mouseRef.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const push =
            dist < 150 ? (1 - dist / 150) * 30 * customization.reactivity : 0;
          const pushDir = dy > 0 ? 1 : -1;

          const y = baseY + wave1 + wave2 + wave3 + push * pushDir;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Fill below the wave for a layered look
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        const fillAlpha = 0.05 * customization.intensity;
        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${fillAlpha})`;
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
