'use client';

/**
 * SetupIcon — Icon picker step in the setup wizard.
 *
 * Four modes: Letter (from wordart), Emoji, Lucide icon, Upload.
 * Canvas-based preview with shape + background controls.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowRight, ArrowLeft, Circle, Square, RectangleHorizontal, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SiteNameStyle } from '@/lib/wordart-presets';
import type { IconConfig } from '@/lib/icon-config';
import { DEFAULT_ICON_CONFIG } from '@/lib/icon-config';
import { useTranslations } from 'next-intl';

interface Props {
  siteName: string;
  siteNameStyle: SiteNameStyle;
  iconConfig: IconConfig;
  setIconConfig: (c: IconConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

// ─── Emoji presets ─────────────────────────────────────────────

const EMOJI_GRID = [
  '🏠', '🚀', '💻', '⭐', '🔥', '💎', '🎯', '🏆',
  '🌈', '⚡', '🎨', '🎮', '🛡️', '🌐', '🔑', '📡',
  '💡', '🎵', '🌸', '☕', '🧊', '🦊', '🐱', '🐶',
];

// ─── Canvas render ─────────────────────────────────────────────

function renderIcon(
  canvas: HTMLCanvasElement,
  config: IconConfig,
  siteName: string,
  style: SiteNameStyle,
  size: number
) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = size;
  canvas.height = size;
  ctx.clearRect(0, 0, size, size);

  const { background, shape } = config;

  // Clip to shape
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === 'rounded-square') {
    ctx.roundRect(0, 0, size, size, size * 0.2);
  } else {
    ctx.rect(0, 0, size, size);
  }
  ctx.closePath();

  // Fill background
  if (background.type !== 'transparent') {
    if (background.type === 'gradient' && background.gradient) {
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, background.gradient.from);
      grad.addColorStop(1, background.gradient.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = background.color || '#8B5CF6';
    }
    ctx.fill();
  }

  // Clip content
  ctx.save();
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === 'rounded-square') {
    ctx.roundRect(0, 0, size, size, size * 0.2);
  } else {
    ctx.rect(0, 0, size, size);
  }
  ctx.clip();

  // Draw content
  if (config.mode === 'letter') {
    const letter = config.letter || siteName?.[0] || 'Y';
    const fontFamily = style?.fontFamily || 'sans-serif';
    const fontWeight = style?.fontWeight || 700;
    const fontSize = Math.round(size * 0.55);
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (style?.gradient?.enabled) {
      const grad = ctx.createLinearGradient(0, 0, size, 0);
      grad.addColorStop(0, style.gradient.from);
      grad.addColorStop(1, style.gradient.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = style?.color || '#ffffff';
    }

    const display = style?.textTransform === 'uppercase'
      ? letter.toUpperCase()
      : style?.textTransform === 'lowercase'
        ? letter.toLowerCase()
        : letter;
    ctx.fillText(display, size / 2, size / 2 + 2);
  } else if (config.mode === 'emoji' && config.emoji) {
    const fontSize = Math.round(size * 0.6);
    ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(config.emoji, size / 2, size / 2 + 2);
  }

  ctx.restore();
}

// ─── Maskable preview ─────────────────────────────────────────

/**
 * Render a maskable icon preview: the icon shrunk to 80% with 10% padding
 * (safe zone), then masked with a circle or squircle to show how Android/iOS
 * adaptive icons will crop it.
 */
function renderMaskablePreview(
  canvas: HTMLCanvasElement,
  config: IconConfig,
  siteName: string,
  style: SiteNameStyle,
  size: number,
  maskShape: 'circle' | 'squircle'
) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = size;
  canvas.height = size;
  ctx.clearRect(0, 0, size, size);

  // Draw background fill (extends to full canvas including safe zone)
  const bgColor = config.background.color || '#8B5CF6';
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  // Draw the icon content scaled to 80% (inner safe area)
  const offscreen = document.createElement('canvas');
  offscreen.width = size;
  offscreen.height = size;
  renderIcon(offscreen, { ...config, shape: 'square' }, siteName, style, size);

  const innerSize = Math.round(size * 0.8);
  const offset = Math.round(size * 0.1);
  ctx.drawImage(offscreen, 0, 0, size, size, offset, offset, innerSize, innerSize);

  // Apply mask (clip everything outside the shape)
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  if (maskShape === 'circle') {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else {
    ctx.roundRect(0, 0, size, size, size * 0.22);
  }
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

// ─── Component ─────────────────────────────────────────────────

export default function SetupIcon({
  siteName,
  siteNameStyle,
  iconConfig,
  setIconConfig,
  onNext,
  onBack,
}: Props) {
  const t = useTranslations('setup');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCircleRef = useRef<HTMLCanvasElement>(null);
  const maskSquircleRef = useRef<HTMLCanvasElement>(null);
  const [activeTab, setActiveTab] = useState<'letter' | 'emoji'>(iconConfig.mode === 'emoji' ? 'emoji' : 'letter');
  const [showMaskable, setShowMaskable] = useState(false);

  // Redraw preview on any change
  useEffect(() => {
    if (canvasRef.current) {
      renderIcon(canvasRef.current, iconConfig, siteName, siteNameStyle, 192);
    }
    if (showMaskable) {
      if (maskCircleRef.current) {
        renderMaskablePreview(maskCircleRef.current, iconConfig, siteName, siteNameStyle, 192, 'circle');
      }
      if (maskSquircleRef.current) {
        renderMaskablePreview(maskSquircleRef.current, iconConfig, siteName, siteNameStyle, 192, 'squircle');
      }
    }
  }, [iconConfig, siteName, siteNameStyle, showMaskable]);

  const handleTabChange = useCallback((tab: 'letter' | 'emoji') => {
    setActiveTab(tab);
    setIconConfig({ ...iconConfig, mode: tab });
  }, [iconConfig, setIconConfig]);

  // Background color presets
  const bgPresets = [
    '#8B5CF6', '#EC4899', '#3B82F6', '#10B981', '#F59E0B',
    '#EF4444', '#6366F1', '#14B8A6', '#1E293B', '#111827',
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Server Icon
        </h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Choose an icon for your server. This will be used as the favicon across all YouEye apps.
        </p>
      </div>

      {/* Preview */}
      <div className="flex justify-center">
        <div className="flex items-center gap-6">
          <canvas
            ref={canvasRef}
            width={192}
            height={192}
            className="w-24 h-24 rounded-2xl shadow-lg"
          />
          <div className="flex flex-col gap-2">
            <canvas
              width={32}
              height={32}
              className="w-4 h-4"
              ref={el => { if (el) renderIcon(el, iconConfig, siteName, siteNameStyle, 32); }}
            />
            <span className="text-[9px] text-muted-foreground">tab icon</span>
          </div>
        </div>
      </div>

      {/* Maskable preview toggle */}
      <div className="text-center">
        <button
          type="button"
          onClick={() => setShowMaskable(!showMaskable)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Smartphone className="h-3.5 w-3.5" />
          {showMaskable ? 'Hide' : 'Show'} mobile app preview
        </button>
        {showMaskable && (
          <div className="mt-3 flex justify-center gap-6">
            <div className="flex flex-col items-center gap-1.5">
              <canvas
                ref={maskCircleRef}
                width={192}
                height={192}
                className="w-14 h-14"
              />
              <span className="text-[9px] text-muted-foreground">Android</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <canvas
                ref={maskSquircleRef}
                width={192}
                height={192}
                className="w-14 h-14"
              />
              <span className="text-[9px] text-muted-foreground">iOS</span>
            </div>
          </div>
        )}
      </div>

      {/* Mode tabs */}
      <div className="flex justify-center gap-2">
        <button
          type="button"
          onClick={() => handleTabChange('letter')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'letter'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted hover:bg-muted-foreground/10'
          }`}
        >
          Letter
        </button>
        <button
          type="button"
          onClick={() => handleTabChange('emoji')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'emoji'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted hover:bg-muted-foreground/10'
          }`}
        >
          Emoji
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'letter' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 justify-center">
            <label className="text-xs text-muted-foreground">Custom letter:</label>
            <Input
              value={iconConfig.letter || ''}
              onChange={e => setIconConfig({ ...iconConfig, letter: e.target.value.slice(0, 2) })}
              placeholder={siteName?.[0] || 'Y'}
              maxLength={2}
              className="h-8 text-sm w-16 text-center"
            />
          </div>
          <p className="text-[11px] text-muted-foreground text-center">
            Uses your WordArt font and color. Updates automatically when you change WordArt.
          </p>
        </div>
      )}

      {activeTab === 'emoji' && (
        <div className="flex flex-wrap justify-center gap-2 max-w-sm mx-auto">
          {EMOJI_GRID.map(emoji => (
            <button
              key={emoji}
              type="button"
              onClick={() => setIconConfig({ ...iconConfig, mode: 'emoji', emoji })}
              className={`w-10 h-10 rounded-lg text-xl flex items-center justify-center transition-all ${
                iconConfig.mode === 'emoji' && iconConfig.emoji === emoji
                  ? 'bg-primary/20 ring-2 ring-primary scale-110'
                  : 'hover:bg-accent hover:scale-105'
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Shape */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground text-center block">Shape</label>
        <div className="flex justify-center gap-2">
          {([
            { id: 'rounded-square' as const, icon: RectangleHorizontal, label: 'Rounded' },
            { id: 'circle' as const, icon: Circle, label: 'Circle' },
            { id: 'square' as const, icon: Square, label: 'Square' },
          ]).map(({ id, icon: ShapeIcon, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setIconConfig({ ...iconConfig, shape: id })}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
                iconConfig.shape === id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-accent'
              }`}
            >
              <ShapeIcon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Background color */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground text-center block">Background</label>
        <div className="flex justify-center gap-1.5 flex-wrap">
          {bgPresets.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => setIconConfig({
                ...iconConfig,
                background: { type: 'solid', color },
              })}
              className={`w-8 h-8 rounded-lg border-2 transition-all ${
                iconConfig.background.type === 'solid' && iconConfig.background.color === color
                  ? 'border-primary scale-110'
                  : 'border-transparent hover:scale-105'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
          <input
            type="color"
            value={iconConfig.background.color || '#8B5CF6'}
            onChange={e => setIconConfig({
              ...iconConfig,
              background: { type: 'solid', color: e.target.value },
            })}
            className="w-8 h-8 rounded-lg border cursor-pointer"
            title="Custom color"
          />
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4">
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button onClick={onNext} className="gap-2">
          Continue
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
