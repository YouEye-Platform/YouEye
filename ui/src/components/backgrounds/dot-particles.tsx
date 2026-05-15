/**
 * Dot Particles Background
 *
 * Click or tap to create particle bursts. Particles fly outward with gravity
 * and fade out. Ambient floating particles add atmosphere.
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

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  colorIdx: number;
}

export function DotParticles({
  colorPreset,
  customization = DEFAULT_CUSTOMIZATION,
  isDark = true,
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const ambientRef = useRef<Particle[]>([]);

  const spawnBurst = useCallback(
    (x: number, y: number) => {
      const count = Math.floor(20 * customization.intensity);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        const speed = (2 + Math.random() * 4) * customization.speed;
        particlesRef.current.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          maxLife: 1,
          size: 2 + Math.random() * 4,
          colorIdx: Math.floor(Math.random() * 6),
        });
      }
    },
    [customization]
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      spawnBurst(e.clientX - rect.left, e.clientY - rect.top);
    },
    [spawnBurst]
  );

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
    canvas.addEventListener("click", handleClick);

    const preset = COLOR_PRESETS[colorPreset];
    const colors = preset.colors.map(hexToRgb);

    // Spawn ambient particles
    if (ambientRef.current.length === 0) {
      const count = Math.floor(30 * customization.scale);
      for (let i = 0; i < count; i++) {
        ambientRef.current.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          life: 1,
          maxLife: 1,
          size: 1 + Math.random() * 3,
          colorIdx: Math.floor(Math.random() * 6),
        });
      }
    }

    const animate = () => {
      const { width, height } = canvas;
      const bgColor = getPresetBackground(preset, isDark);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      const dt = 0.016 * customization.speed;

      // Update + draw burst particles
      particlesRef.current = particlesRef.current.filter((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05; // gravity
        p.vx *= 0.99; // friction
        p.life -= dt * 0.5;

        if (p.life <= 0) return false;

        const color = colors[p.colorIdx % colors.length];
        const alpha = p.life * customization.intensity;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fill();
        return true;
      });

      // Update + draw ambient
      const time = Date.now() * 0.001;
      for (const p of ambientRef.current) {
        p.x += Math.sin(time + p.y * 0.01) * 0.3 * customization.speed;
        p.y += Math.cos(time + p.x * 0.01) * 0.3 * customization.speed;

        // Wrap around edges
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        const pulse = Math.sin(time * 2 + p.x * 0.01) * 0.3 + 0.7;
        const color = colors[p.colorIdx % colors.length];
        const alpha = 0.2 * pulse * customization.intensity;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
        ctx.fill();
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("click", handleClick);
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [colorPreset, customization, isDark, handleClick]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className ?? ""}`}
      style={{ pointerEvents: "all" }}
    />
  );
}
