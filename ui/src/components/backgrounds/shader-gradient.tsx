/**
 * Shader Gradient Background
 *
 * 3D-style animated gradient with noise, creating an organic,
 * shifting color landscape that reacts to cursor position.
 *
 * Performance: renders at 1/8 resolution and caps at 30fps
 * to avoid CPU overload from per-pixel trig computation.
 */
"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  COLOR_PRESETS,
  DEFAULT_CUSTOMIZATION,
  hexToRgb,
  interpolateColor,
  type AnimatedBackgroundProps,
} from "./index";

export function ShaderGradient({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Use lower resolution for performance (8x downscale)
    const SCALE = 8;
    const TARGET_FPS = 30;
    const FRAME_INTERVAL = 1000 / TARGET_FPS;
    let lastFrameTime = 0;
    let imageData: ImageData | null = null;

    const resize = () => {
      canvas.width = Math.ceil(canvas.offsetWidth / SCALE);
      canvas.height = Math.ceil(canvas.offsetHeight / SCALE);
      canvas.style.imageRendering = "auto";
      // Invalidate cached imageData on resize
      imageData = null;
    };
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", handleMouseMove);

    const preset = COLOR_PRESETS[colorPreset];
    const rgbColors = preset.colors.map(hexToRgb);

    const baseTint = isDark
      ? { r: 10, g: 10, b: 20 }
      : { r: 245, g: 245, b: 250 };

    const animate = (timestamp: number) => {
      animationRef.current = requestAnimationFrame(animate);

      // Frame throttle to TARGET_FPS
      const elapsed = timestamp - lastFrameTime;
      if (elapsed < FRAME_INTERVAL) return;
      lastFrameTime = timestamp - (elapsed % FRAME_INTERVAL);

      const { width, height } = canvas;
      if (width === 0 || height === 0) return;

      // Reuse ImageData to reduce GC pressure
      if (!imageData || imageData.width !== width || imageData.height !== height) {
        imageData = ctx.createImageData(width, height);
      }
      const data = imageData.data;

      const time = Date.now() * 0.001 * customization.speed;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const nx = x / width;
          const ny = y / height;

          const mdx = nx - mouseRef.current.x;
          const mdy = ny - mouseRef.current.y;
          const mDist = Math.sqrt(mdx * mdx + mdy * mdy);

          const n1 = Math.sin(nx * 6 + time) * Math.cos(ny * 4 + time * 0.7);
          const n2 = Math.sin(nx * 3 + ny * 5 + time * 0.5) * 0.5;
          const n3 =
            Math.cos(nx * 8 - time * 0.3) *
            Math.sin(ny * 7 + time * 0.9) *
            0.3;

          const mouseInfluence =
            Math.max(0, 1 - mDist * 2) * customization.reactivity;
          const value =
            (n1 + n2 + n3 + mouseInfluence) * customization.intensity;

          const t = (value + 1) * 0.5;
          const idx1 = Math.floor(t * (rgbColors.length - 1));
          const idx2 = Math.min(idx1 + 1, rgbColors.length - 1);
          const localT = (t * (rgbColors.length - 1)) % 1;

          const gradColor = interpolateColor(
            rgbColors[idx1],
            rgbColors[idx2],
            localT
          );

          const blendFactor = isDark ? 0.4 : 0.6;
          const finalColor = interpolateColor(
            baseTint,
            gradColor,
            blendFactor + t * 0.3
          );

          const pi = (y * width + x) * 4;
          data[pi] = finalColor.r;
          data[pi + 1] = finalColor.g;
          data[pi + 2] = finalColor.b;
          data[pi + 3] = 255;
        }
      }

      ctx.putImageData(imageData, 0, 0);
    };

    animationRef.current = requestAnimationFrame(animate);

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
