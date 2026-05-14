/**
 * Icon Creator — settings page component
 *
 * 4-tab icon picker (letter, Lucide icons, emoji, upload) with
 * shape/background controls and accent color. Used inside the
 * Reconfigure section of the settings page.
 *
 * Mirrors the embed branding client's icon creator but uses
 * shadcn styling. Canvas rendering for preview and export.
 */

'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Upload, Loader2, X } from 'lucide-react';
import type { IconConfig } from '@/lib/icon-config';
import { DEFAULT_ICON_CONFIG } from '@/lib/icon-config';
import type { SiteNameStyle } from '@/lib/wordart-presets';
import * as LucideIcons from 'lucide-react';
import type { ComponentType } from 'react';

// ─── Lucide icons registry ────────────────────────────────────

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const LUCIDE_SKIP = new Set([
  'default', 'createLucideIcon', 'icons', 'Icon', 'LucideIcon', 'createElement',
]);

const LUCIDE_ENTRIES: Array<{
  name: string;
  component: ComponentType<{ className?: string; style?: React.CSSProperties }>;
}> = [];

for (const [name, comp] of Object.entries(LucideIcons)) {
  if (LUCIDE_SKIP.has(name)) continue;
  if (typeof comp !== 'object' && typeof comp !== 'function') continue;
  if (name[0] !== name[0].toUpperCase() || name.startsWith('Lucide')) continue;
  LUCIDE_ENTRIES.push({
    name: pascalToKebab(name),
    component: comp as ComponentType<{ className?: string; style?: React.CSSProperties }>,
  });
}
LUCIDE_ENTRIES.sort((a, b) => a.name.localeCompare(b.name));

// ─── Emoji categories ─────────────────────────────────────────

const EMOJI_CATEGORIES = [
  { name: 'Smileys', emojis: [
    '\u{1F600}','\u{1F603}','\u{1F604}','\u{1F601}','\u{1F606}','\u{1F605}','\u{1F923}','\u{1F602}','\u{1F642}','\u{1F60A}',
    '\u{1F607}','\u{1F970}','\u{1F60D}','\u{1F929}','\u{1F618}','\u{1F60B}','\u{1F61B}','\u{1F61C}','\u{1F92A}','\u{1F60E}',
    '\u{1F913}','\u{1F9D0}','\u{1F920}','\u{1F973}','\u{1F917}','\u{1F608}','\u{1F47B}','\u{1F480}','\u{1F916}','\u{1F47D}',
  ]},
  { name: 'Animals', emojis: [
    '\u{1F436}','\u{1F431}','\u{1F42D}','\u{1F439}','\u{1F430}','\u{1F98A}','\u{1F43B}','\u{1F43C}','\u{1F428}','\u{1F42F}',
    '\u{1F981}','\u{1F42E}','\u{1F437}','\u{1F438}','\u{1F435}','\u{1F412}','\u{1F427}','\u{1F426}','\u{1F985}','\u{1F989}',
    '\u{1F987}','\u{1F43A}','\u{1F434}','\u{1F984}','\u{1F41D}','\u{1F98B}','\u{1F422}','\u{1F419}','\u{1F420}','\u{1F42C}',
  ]},
  { name: 'Food', emojis: [
    '\u{1F34E}','\u{1F34A}','\u{1F34B}','\u{1F34C}','\u{1F349}','\u{1F347}','\u{1F353}','\u{1F352}','\u{1F351}','\u{1F34D}',
    '\u{1F355}','\u{1F354}','\u{1F32D}','\u{1F32E}','\u{1F32F}','\u{1F37F}','\u2615','\u{1F375}','\u{1F36A}','\u{1F370}',
  ]},
  { name: 'Activities', emojis: [
    '\u26BD','\u{1F3C0}','\u{1F3C8}','\u26BE','\u{1F3BE}','\u{1F3B1}','\u{1F3AE}','\u{1F3B2}','\u{1F3AF}','\u{1F3AD}',
    '\u{1F3A8}','\u{1F3AC}','\u{1F3A4}','\u{1F3A7}','\u{1F3B5}','\u{1F3B6}','\u{1F3B8}','\u{1F3B9}','\u{1F3BA}','\u{1F3BB}',
  ]},
  { name: 'Travel', emojis: [
    '\u{1F697}','\u{1F680}','\u{1F6F8}','\u{1F681}','\u2708\uFE0F','\u{1F6A2}','\u{1F3E0}','\u{1F3D4}\uFE0F','\u{1F30B}',
    '\u{1F3D6}\uFE0F','\u{1F30D}','\u{1F30E}','\u{1F30F}','\u{1F305}','\u{1F304}','\u{1F306}','\u{1F307}','\u{1F30C}',
  ]},
  { name: 'Objects', emojis: [
    '\u{1F4BB}','\u{1F5A5}\uFE0F','\u{1F4F1}','\u{1F4F7}','\u{1F4FA}','\u{1F52D}','\u{1F52C}','\u{1F9EA}','\u{1F48E}',
    '\u{1F511}','\u{1F527}','\u{1F528}','\u{1F6E0}\uFE0F','\u{1F52E}','\u2699\uFE0F','\u{1F4E6}','\u{1F4DA}','\u{1F4D6}',
  ]},
  { name: 'Symbols', emojis: [
    '\u2764\uFE0F','\u{1F9E1}','\u{1F49B}','\u{1F49A}','\u{1F499}','\u{1F49C}','\u{1F5A4}','\u2B50','\u{1F31F}','\u2728',
    '\u{1F4AB}','\u26A1','\u{1F525}','\u{1F4A5}','\u2744\uFE0F','\u{1F30A}','\u{1F308}','\u{1F3B5}','\u{1F514}','\u{1F6A9}',
  ]},
];

const BG_PRESETS = [
  '#8B5CF6', '#EC4899', '#3B82F6', '#10B981', '#F59E0B',
  '#EF4444', '#6366F1', '#14B8A6', '#1E293B', '#111827',
];

const GRADIENT_PRESETS = [
  { from: '#8B5CF6', to: '#EC4899', name: 'Purple Pink' },
  { from: '#3B82F6', to: '#8B5CF6', name: 'Blue Purple' },
  { from: '#10B981', to: '#3B82F6', name: 'Teal Blue' },
  { from: '#F59E0B', to: '#EF4444', name: 'Amber Red' },
  { from: '#EC4899', to: '#F59E0B', name: 'Pink Amber' },
  { from: '#6366F1', to: '#EC4899', name: 'Indigo Pink' },
  { from: '#14B8A6', to: '#6366F1', name: 'Teal Indigo' },
  { from: '#1E293B', to: '#6366F1', name: 'Slate Indigo' },
];

// ─── Canvas icon rendering ────────────────────────────────────

function renderIconCanvas(
  canvas: HTMLCanvasElement,
  config: IconConfig,
  siteName: string,
  style: SiteNameStyle,
  size: number,
) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = size;
  canvas.height = size;
  ctx.clearRect(0, 0, size, size);

  const { background, shape } = config;

  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === 'rounded-square') {
    ctx.roundRect(0, 0, size, size, size * 0.2);
  } else {
    ctx.rect(0, 0, size, size);
  }
  ctx.closePath();

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
  } else if (config.mode === 'lucide') {
    ctx.fillStyle = config.lucideColor || '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u2B21', size / 2, size / 2);
  }

  ctx.restore();
}

async function renderLucideToBlob(
  config: IconConfig,
  siteName: string,
  style: SiteNameStyle,
  size: number = 512,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  renderIconCanvas(canvas, config, siteName, style, size);

  if (config.mode === 'lucide' && config.lucideIcon) {
    const ctx = canvas.getContext('2d')!;
    const iconSize = Math.round(size * 0.5);
    const iconEl = document.querySelector(`[data-lucide-preview="${config.lucideIcon}"]`);
    if (iconEl) {
      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="${config.lucideColor || '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconEl.innerHTML}</svg>`;
      const img = new Image();
      const svgBlob = new Blob([svgStr], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      await new Promise<void>((resolve) => {
        img.onload = () => {
          const offset = (size - iconSize) / 2;
          ctx.drawImage(img, offset, offset, iconSize, iconSize);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        img.src = url;
      });
    }
  }

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// ─── Component ────────────────────────────────────────────────

interface IconCreatorProps {
  siteName: string;
  style: SiteNameStyle;
  iconConfig: IconConfig;
  onIconConfigChange: (config: IconConfig) => void;
  accentColor: string;
  onAccentColorChange: (color: string) => void;
}

export function IconCreator({
  siteName,
  style,
  iconConfig,
  onIconConfigChange,
  accentColor,
  onAccentColorChange,
}: IconCreatorProps) {
  const [iconTab, setIconTab] = useState<'letter' | 'icons' | 'emoji' | 'upload'>(() => {
    const modeToTab: Record<string, 'letter' | 'icons' | 'emoji' | 'upload'> = {
      letter: 'letter', lucide: 'icons', emoji: 'emoji', upload: 'upload',
    };
    return modeToTab[iconConfig.mode] || 'letter';
  });
  const [iconSearch, setIconSearch] = useState('');
  const [emojiCat, setEmojiCat] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(
    iconConfig.mode === 'upload' && iconConfig.uploadUrl ? iconConfig.uploadUrl : null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const iconCanvasRef = useRef<HTMLCanvasElement>(null);

  // Redraw icon preview
  useEffect(() => {
    if (iconCanvasRef.current) {
      renderIconCanvas(iconCanvasRef.current, iconConfig, siteName, style, 128);
    }
  }, [iconConfig, siteName, style]);

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return LUCIDE_ENTRIES.slice(0, 200);
    const q = iconSearch.toLowerCase();
    return LUCIDE_ENTRIES.filter(i => i.name.includes(q)).slice(0, 200);
  }, [iconSearch]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'favicon');
      const res = await fetch('/api/ui/branding/upload', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        onIconConfigChange({ ...iconConfig, mode: 'upload', uploadUrl: data.url });
      }
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  }, [iconConfig, onIconConfigChange]);

  const setTab = (tab: typeof iconTab) => {
    setIconTab(tab);
    const modeMap: Record<string, IconConfig['mode']> = { letter: 'letter', icons: 'lucide', emoji: 'emoji', upload: 'upload' };
    onIconConfigChange({ ...iconConfig, mode: modeMap[tab] });
  };

  return (
    <div className="space-y-4">
      <Label>Server Icon</Label>

      {/* Preview + tabs */}
      <div className="flex gap-4 items-start">
        <div className="flex flex-col items-center gap-1 flex-shrink-0">
          <canvas
            ref={iconCanvasRef}
            width={128}
            height={128}
            className="rounded-xl shadow-md"
            style={{ width: 64, height: 64 }}
          />
          <span className="text-[9px] text-muted-foreground">preview</span>
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap gap-1 mb-2">
            {([
              { tab: 'letter' as const, label: 'Aa' },
              { tab: 'icons' as const, label: 'Icons' },
              { tab: 'emoji' as const, label: 'Emoji' },
              { tab: 'upload' as const, label: 'Upload' },
            ]).map(({ tab, label }) => (
              <Button
                key={tab}
                variant={iconTab === tab ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setTab(tab)}
              >
                {label}
              </Button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Used as favicon across UI, Control Panel, and Authentik login.
          </p>
        </div>
      </div>

      {/* Letter tab */}
      {iconTab === 'letter' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Custom letter:</span>
            <Input
              value={iconConfig.letter || ''}
              onChange={e => onIconConfigChange({ ...iconConfig, letter: e.target.value.slice(0, 2) })}
              placeholder={siteName?.[0] || 'Y'}
              maxLength={2}
              className="w-12 h-8 text-center text-sm"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Uses your WordArt font and color. Updates automatically when WordArt changes.
          </p>
        </div>
      )}

      {/* Icons (Lucide) tab */}
      {iconTab === 'icons' && (
        <div className="space-y-2">
          <Input
            placeholder="Search 1700+ icons..."
            value={iconSearch}
            onChange={e => setIconSearch(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Icon color:</span>
            <input
              type="color"
              value={iconConfig.lucideColor || '#ffffff'}
              onChange={e => onIconConfigChange({ ...iconConfig, lucideColor: e.target.value })}
              className="w-6 h-6 rounded border cursor-pointer"
            />
            <span className="text-[10px] text-muted-foreground font-mono">{iconConfig.lucideColor || '#ffffff'}</span>
          </div>
          <div className="grid grid-cols-8 gap-0.5 max-h-[220px] overflow-y-auto p-0.5">
            {filteredIcons.map(entry => {
              const Icon = entry.component;
              const isActive = iconConfig.mode === 'lucide' && iconConfig.lucideIcon === entry.name;
              return (
                <button
                  key={entry.name}
                  title={entry.name}
                  onClick={() => onIconConfigChange({ ...iconConfig, mode: 'lucide', lucideIcon: entry.name })}
                  className={`aspect-square flex items-center justify-center rounded-md cursor-pointer transition-colors ${
                    isActive ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-muted'
                  }`}
                >
                  <Icon style={{ width: 16, height: 16 }} />
                </button>
              );
            })}
          </div>
          {filteredIcons.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No icons match &quot;{iconSearch}&quot;
            </p>
          )}
          {/* Hidden SVG for canvas rendering */}
          {iconConfig.lucideIcon && (() => {
            const entry = LUCIDE_ENTRIES.find(e => e.name === iconConfig.lucideIcon);
            if (!entry) return null;
            const LIcon = entry.component;
            return (
              <div style={{ display: 'none' }}>
                <LIcon style={{ width: 24, height: 24 }} data-lucide-preview={iconConfig.lucideIcon} />
              </div>
            );
          })()}
        </div>
      )}

      {/* Emoji tab */}
      {iconTab === 'emoji' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {EMOJI_CATEGORIES.map((cat, i) => (
              <Button
                key={cat.name}
                variant={emojiCat === i ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => setEmojiCat(i)}
              >
                {cat.name}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-0.5 max-h-[200px] overflow-y-auto">
            {EMOJI_CATEGORIES[emojiCat].emojis.map(emoji => {
              const isActive = iconConfig.mode === 'emoji' && iconConfig.emoji === emoji;
              return (
                <button
                  key={emoji}
                  onClick={() => onIconConfigChange({ ...iconConfig, mode: 'emoji', emoji })}
                  className={`w-8 h-8 text-lg rounded flex items-center justify-center cursor-pointer transition-colors ${
                    isActive ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-muted'
                  }`}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Upload tab */}
      {iconTab === 'upload' && (
        <div className="flex flex-col items-center gap-3 py-3">
          {uploadPreview || iconConfig.uploadUrl ? (
            <div className="relative">
              <img
                src={uploadPreview ?? iconConfig.uploadUrl!}
                alt="Icon preview"
                className="w-16 h-16 rounded-xl object-cover border"
              />
              <button
                onClick={() => { setUploadPreview(null); onIconConfigChange({ ...iconConfig, uploadUrl: undefined }); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-xs cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="w-16 h-16 rounded-xl border-2 border-dashed flex items-center justify-center text-muted-foreground text-2xl">
              +
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon" onChange={handleFileUpload} className="hidden" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
            {uploading ? 'Uploading...' : 'Choose Image'}
          </Button>
          <p className="text-[10px] text-muted-foreground">PNG, JPEG, WebP, SVG, ICO</p>
        </div>
      )}

      {/* Shape + background controls (not for upload) */}
      {iconTab !== 'upload' && (
        <div className="border-t pt-3 space-y-3">
          {/* Shape */}
          <div>
            <span className="text-xs text-muted-foreground block mb-1.5">Shape</span>
            <div className="flex gap-1">
              {([
                { id: 'rounded-square' as const, label: 'Rounded' },
                { id: 'circle' as const, label: 'Circle' },
                { id: 'square' as const, label: 'Square' },
              ]).map(({ id, label }) => (
                <Button
                  key={id}
                  variant={iconConfig.shape === id ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onIconConfigChange({ ...iconConfig, shape: id })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {/* Background type */}
          <div>
            <span className="text-xs text-muted-foreground block mb-1.5">Background</span>
            <div className="flex gap-1 mb-2">
              {(['solid', 'gradient', 'transparent'] as const).map(type => (
                <Button
                  key={type}
                  variant={iconConfig.background.type === type ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs capitalize"
                  onClick={() => onIconConfigChange({
                    ...iconConfig,
                    background: {
                      ...iconConfig.background, type,
                      color: type === 'solid' ? (iconConfig.background.color || '#8B5CF6') : iconConfig.background.color,
                      gradient: type === 'gradient' ? (iconConfig.background.gradient || { from: '#8B5CF6', to: '#EC4899' }) : iconConfig.background.gradient,
                    },
                  })}
                >
                  {type}
                </Button>
              ))}
            </div>

            {/* Solid presets */}
            {iconConfig.background.type === 'solid' && (
              <div className="flex gap-1 flex-wrap">
                {BG_PRESETS.map(color => (
                  <button
                    key={color}
                    onClick={() => onIconConfigChange({ ...iconConfig, background: { type: 'solid', color } })}
                    className={`w-6 h-6 rounded-md cursor-pointer ${
                      iconConfig.background.color === color ? 'ring-2 ring-primary ring-offset-1' : ''
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <input type="color" value={iconConfig.background.color || '#8B5CF6'}
                  onChange={e => onIconConfigChange({ ...iconConfig, background: { type: 'solid', color: e.target.value } })}
                  className="w-6 h-6 rounded-md border cursor-pointer"
                  title="Custom color"
                />
              </div>
            )}

            {/* Gradient presets */}
            {iconConfig.background.type === 'gradient' && (
              <div className="space-y-2">
                <div className="flex gap-1 flex-wrap">
                  {GRADIENT_PRESETS.map(g => (
                    <button key={g.name} title={g.name}
                      onClick={() => onIconConfigChange({ ...iconConfig, background: { type: 'gradient', gradient: { from: g.from, to: g.to } } })}
                      className={`w-6 h-6 rounded-md cursor-pointer ${
                        iconConfig.background.gradient?.from === g.from && iconConfig.background.gradient?.to === g.to ? 'ring-2 ring-primary ring-offset-1' : ''
                      }`}
                      style={{ background: `linear-gradient(135deg, ${g.from}, ${g.to})` }}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={iconConfig.background.gradient?.from || '#8B5CF6'}
                      onChange={e => onIconConfigChange({ ...iconConfig, background: { ...iconConfig.background, type: 'gradient', gradient: { from: e.target.value, to: iconConfig.background.gradient?.to || '#EC4899' } } })}
                      className="w-5 h-5 rounded border cursor-pointer"
                    />
                    <span className="text-[9px] text-muted-foreground">From</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={iconConfig.background.gradient?.to || '#EC4899'}
                      onChange={e => onIconConfigChange({ ...iconConfig, background: { ...iconConfig.background, type: 'gradient', gradient: { from: iconConfig.background.gradient?.from || '#8B5CF6', to: e.target.value } } })}
                      className="w-5 h-5 rounded border cursor-pointer"
                    />
                    <span className="text-[9px] text-muted-foreground">To</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Accent Color */}
      <div className="border-t pt-3">
        <Label className="text-sm mb-2 block">Accent Color</Label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={accentColor}
            onChange={(e) => onAccentColorChange(e.target.value)}
            className="w-10 h-10 rounded-md border cursor-pointer"
          />
          <span className="text-sm text-muted-foreground font-mono">{accentColor}</span>
        </div>
      </div>
    </div>
  );
}

// Re-export rendering functions for use by settings page save handler
export { renderIconCanvas, renderLucideToBlob, DEFAULT_ICON_CONFIG };
