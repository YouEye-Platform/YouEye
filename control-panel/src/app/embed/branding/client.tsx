"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import WordArtGalleryEmbed from "@/components/embed/WordArtGalleryEmbed";
import type { IconConfig } from "@/lib/icon-config";
import { DEFAULT_ICON_CONFIG } from "@/lib/icon-config";
import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";

interface BrandingData {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  logo_url: string | null;
  favicon_url: string | null;
  accent_color: string;
  icon_config: IconConfig | null;
}

const DEFAULT_STYLE: SiteNameStyle = {
  fontFamily: "Inter",
  fontSize: "1.5rem",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

// ─── Lucide icons registry ────────────────────────────────────
function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const LUCIDE_SKIP = new Set([
  "default", "createLucideIcon", "icons", "Icon", "LucideIcon", "createElement",
]);

const LUCIDE_ENTRIES: Array<{
  name: string;
  component: ComponentType<{ className?: string; style?: React.CSSProperties }>;
}> = [];

for (const [name, comp] of Object.entries(LucideIcons)) {
  if (LUCIDE_SKIP.has(name)) continue;
  if (typeof comp !== "object" && typeof comp !== "function") continue;
  if (name[0] !== name[0].toUpperCase() || name.startsWith("Lucide")) continue;
  LUCIDE_ENTRIES.push({
    name: pascalToKebab(name),
    component: comp as ComponentType<{ className?: string; style?: React.CSSProperties }>,
  });
}
LUCIDE_ENTRIES.sort((a, b) => a.name.localeCompare(b.name));

// ─── Emoji categories ─────────────────────────────────────────
const EMOJI_CATEGORIES = [
  { name: "Smileys & Faces", emojis: [
    "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😊","😇","🥰","😍","🤩","😘",
    "😋","😛","😜","🤪","😎","🤓","🧐","🤠","🥳","🤗","😈","👻","💀","🤖","👽",
    "🎃","😺","😸","😻","😼","🙀","😿","😹","🫠","🥹","🫡","🤭","🫣","🤥","🫥",
  ]},
  { name: "People & Hands", emojis: [
    "👋","🤚","🖐️","✋","🖖","🫱","🫲","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘",
    "🤙","👈","👉","👆","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶",
    "👐","🤲","🤝","🙏","💪","🦵","🦶","👀","👁️","🧠","🦷","👃","👂","💅","🤳",
  ]},
  { name: "Animals & Nature", emojis: [
    "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵",
    "🙈","🙉","🙊","🐒","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴",
    "🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪰","🪲","🦂","🕷️","🦎","🐍","🐢",
    "🐙","🐠","🐟","🐬","🐳","🦈","🐊","🦩","🦚","🦜","🌸","🌺","🌻","🌹","🌷",
    "🌲","🌳","🌴","🌵","🍀","🌿","☘️","🍃","🍂","🍁","🌾","🪻","🪴","🪹","🪺",
  ]},
  { name: "Food & Drink", emojis: [
    "🍎","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝",
    "🍅","🥑","🍆","🥦","🥬","🥒","🌶️","🫑","🌽","🥕","🧄","🧅","🥔","🍠","🥐",
    "🍕","🍔","🌭","🌮","🌯","🥪","🍟","🥗","🍝","🍜","🍲","🍣","🍤","🍩","🍪",
    "🎂","🍰","🧁","🍫","🍬","🍭","🍮","🍯","🍿","☕","🍵","🧃","🧋","🍺","🍷",
  ]},
  { name: "Activities & Sports", emojis: [
    "⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🪀","🏓","🏸","🏒","🥊",
    "🎿","⛷️","🏂","🪂","🏋️","🤸","🤺","⛹️","🏄","🏊","🚴","🧘","🏇","🎮","🕹️",
    "🎲","🧩","♟️","🎯","🎳","🎭","🎨","🎬","🎤","🎧","🎼","🎵","🎶","🎸","🎹",
    "🥁","🎺","🎻","🪕","🎪","🎡","🎢","🎠","🏆","🥇","🥈","🥉","🏅","🎖️","🎗️",
  ]},
  { name: "Travel & Places", emojis: [
    "🚗","🚕","🚙","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🏍️","🛵","🚲",
    "🛴","🚂","🚃","🚄","🚅","🚆","🚇","🚈","🚝","🚞","🚋","🚍","✈️","🛩️","🚀",
    "🛸","🚁","🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","🏠","🏡","🏢","🏣","🏤","🏥",
    "🏦","🏨","🏩","🏪","🏫","🏬","🏭","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🏰",
    "🌅","🌄","🌆","🌇","🌌","🏔️","⛰️","🌋","🗻","🏕️","🏖️","🏜️","🏝️","🌍","🌎",
  ]},
  { name: "Objects & Tools", emojis: [
    "💻","🖥️","🖨️","⌨️","🖱️","💾","💿","📱","📲","☎️","📞","📟","📠","📺","📷",
    "📸","📹","🎥","📽️","🎞️","📡","🔭","🔬","🧪","🧫","🧬","💉","🩸","💊","🩹",
    "🔑","🗝️","🔐","🔒","🔓","🔧","🔨","⛏️","🛠️","🗡️","⚔️","🛡️","🔮","📿","🧿",
    "💎","🪙","💰","💳","🧲","⚙️","🔩","🪛","🪚","🪜","🧰","📦","📫","📬","📮",
  ]},
  { name: "Symbols & Shapes", emojis: [
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💗","💖","💝","💘","💕","💞",
    "💓","💟","❣️","💔","♥️","♠️","♦️","♣️","🔴","🟠","🟡","🟢","🔵","🟣","⚫",
    "⚪","🟤","🔶","🔷","🔸","🔹","🔺","🔻","💠","🔘","⭐","🌟","✨","💫","⚡",
    "🔥","💥","❄️","🌊","🎵","🎶","🔔","🔕","📢","📣","💬","💭","🏳️","🏴","🚩",
  ]},
  { name: "Flags & Signs", emojis: [
    "🏁","🚩","🎌","🏴‍☠️","🏳️‍🌈","🏳️‍⚧️","♻️","⚠️","🚸","⛔","🚫","🚳","🚭","🚯","🚱",
    "🔞","📵","❌","⭕","🛑","💯","💢","♨️","🚷","📛","🔰","⚜️","🔱","〽️","✅",
    "☑️","✔️","❎","➕","➖","➗","✖️","🔃","🔄","🔙","🔚","🔛","🔜","🔝","⏸️",
  ]},
  { name: "Tech & Science", emojis: [
    "🔋","🪫","🔌","💡","🔦","🕯️","🧯","🗑️","🛢️","💸","💵","💴","💶","💷","🪪",
    "📊","📈","📉","🗂️","📁","📂","📅","📆","🗓️","📇","📋","📌","📍","📎","🖇️",
    "📏","📐","✂️","🗃️","🗄️","🗑️","🔏","🔐","🔒","🔓","🖊️","🖋️","✒️","📝","✏️",
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
  size: number
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
    // Draw a placeholder icon symbol — real SVG rendered via renderLucideToBlob
    ctx.fillStyle = config.lucideColor || '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⬡', size / 2, size / 2);
  }

  ctx.restore();
}

async function renderLucideToBlob(
  config: IconConfig,
  siteName: string,
  style: SiteNameStyle,
  size: number = 512
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

export function BrandingEmbedClient() {
  const [siteName, setSiteName] = useState("YouEye");
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [iconConfig, setIconConfig] = useState<IconConfig>(DEFAULT_ICON_CONFIG);
  const [iconTab, setIconTab] = useState<'letter' | 'icons' | 'emoji' | 'upload'>('letter');
  const [iconSearch, setIconSearch] = useState('');
  const [emojiSearch, setEmojiSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const iconCanvasRef = useRef<HTMLCanvasElement>(null);

  const loadBranding = useCallback(async () => {
    try {
      const res = await fetch("/api/ui/branding");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: BrandingData = await res.json();
      setSiteName(data.site_name);
      setAccentColor(data.accent_color ?? "#8B5CF6");
      if (data.site_name_style) setStyle(data.site_name_style);
      if (data.icon_config) {
        setIconConfig(data.icon_config);
        const modeToTab: Record<string, typeof iconTab> = {
          letter: 'letter', lucide: 'icons', emoji: 'emoji', upload: 'upload',
        };
        setIconTab(modeToTab[data.icon_config.mode] || 'letter');
        if (data.icon_config.mode === 'upload' && data.icon_config.uploadUrl) {
          setUploadPreview(data.icon_config.uploadUrl);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load branding");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  // Redraw icon preview
  useEffect(() => {
    if (iconCanvasRef.current) {
      renderIconCanvas(iconCanvasRef.current, iconConfig, siteName, style, 128);
    }
  }, [iconConfig, siteName, style]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: siteName,
          site_name_style: style,
          accent_color: accentColor,
          icon_config: iconConfig,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // For non-letter modes, render client-side and upload blob
      if (iconConfig.mode !== 'letter') {
        try {
          let blob: Blob | null;
          if (iconConfig.mode === 'lucide') {
            blob = await renderLucideToBlob(iconConfig, siteName, style, 512);
          } else {
            const offscreen = document.createElement('canvas');
            renderIconCanvas(offscreen, iconConfig, siteName, style, 512);
            blob = await new Promise<Blob | null>(resolve =>
              offscreen.toBlob(resolve, 'image/png')
            );
          }
          if (blob) {
            const formData = new FormData();
            formData.append('icon_config', JSON.stringify(iconConfig));
            formData.append('icon_blob', blob, 'icon.png');
            await fetch('/api/ui/branding/icon', {
              method: 'POST',
              body: formData,
            });
          }
        } catch (err) {
          console.warn('Icon upload failed:', err);
        }
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setStyle(DEFAULT_STYLE);
    setSiteName("YouEye");
    setAccentColor("#8B5CF6");
    setIconConfig(DEFAULT_ICON_CONFIG);
    setIconTab('letter');
    setUploadPreview(null);
    setIconSearch('');
    setEmojiSearch('');
  };

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return LUCIDE_ENTRIES.slice(0, 200);
    const q = iconSearch.toLowerCase();
    return LUCIDE_ENTRIES.filter(i => i.name.includes(q)).slice(0, 200);
  }, [iconSearch]);

  const filteredEmojis = useMemo(() => {
    if (!emojiSearch.trim()) return EMOJI_CATEGORIES;
    const q = emojiSearch.toLowerCase();
    return EMOJI_CATEGORIES.map(cat => ({
      ...cat,
      emojis: cat.name.toLowerCase().includes(q) ? cat.emojis : [],
    })).filter(cat => cat.emojis.length > 0);
  }, [emojiSearch]);

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
        setIconConfig(prev => ({ ...prev, mode: 'upload', uploadUrl: data.url }));
      }
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div className="embed-card">
          <div className="embed-skeleton" style={{ height: 20, width: "40%", marginBottom: 16 }} />
          <div className="embed-skeleton" style={{ height: 40, width: "100%", marginBottom: 12 }} />
          <div className="embed-skeleton" style={{ height: 200, width: "100%" }} />
        </div>
      </div>
    );
  }

  if (error && !saving) {
    return (
      <div className="embed-error">
        <p>{error}</p>
        <button className="embed-btn" style={{ marginTop: 12 }} onClick={() => { setError(null); loadBranding(); }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Site Name */}
      <div className="embed-card">
        <div className="embed-card-title">Site Name</div>
        <input
          type="text"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
          placeholder="YouEye"
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid var(--embed-border)",
            background: "var(--embed-bg, transparent)",
            color: "var(--embed-text)",
            fontSize: 14,
            outline: "none",
          }}
        />
      </div>

      {/* WordArt Picker */}
      <div className="embed-card">
        <div className="embed-card-title">Site Name Style</div>
        <WordArtPickerInline siteName={siteName} style={style} setStyle={setStyle} />
      </div>

      {/* Accent Color */}
      <div className="embed-card">
        <div className="embed-card-title">Accent Color</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            style={{ width: 40, height: 40, borderRadius: 6, border: "1px solid var(--embed-border)", cursor: "pointer" }}
          />
          <span className="embed-mono embed-muted">{accentColor}</span>
        </div>
      </div>

      {/* Server Icon Creator */}
      <div className="embed-card">
        <div className="embed-card-title">Server Icon</div>

        {/* Preview + tabs row */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <canvas
              ref={iconCanvasRef}
              width={128}
              height={128}
              style={{ width: 64, height: 64, borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }}
            />
            <span className="embed-muted" style={{ fontSize: 9 }}>preview</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              {([
                { tab: 'letter' as const, label: 'Aa' },
                { tab: 'icons' as const, label: 'Icons' },
                { tab: 'emoji' as const, label: 'Emoji' },
                { tab: 'upload' as const, label: 'Upload' },
              ]).map(({ tab, label }) => (
                <button
                  key={tab}
                  className="embed-btn"
                  onClick={() => {
                    setIconTab(tab);
                    const modeMap: Record<string, IconConfig['mode']> = { letter: 'letter', icons: 'lucide', emoji: 'emoji', upload: 'upload' };
                    setIconConfig({ ...iconConfig, mode: modeMap[tab] });
                  }}
                  style={{
                    background: iconTab === tab ? "var(--embed-primary)" : undefined,
                    color: iconTab === tab ? "#fff" : undefined,
                    borderColor: iconTab === tab ? "var(--embed-primary)" : undefined,
                    fontSize: 11, padding: "4px 10px",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="embed-muted" style={{ fontSize: 10, margin: 0 }}>
              Used as favicon across UI, Control Panel, and Authentik login.
            </p>
          </div>
        </div>

        {/* Letter tab */}
        {iconTab === 'letter' && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="embed-muted" style={{ fontSize: 11 }}>Custom letter:</span>
              <input
                type="text"
                value={iconConfig.letter || ''}
                onChange={e => setIconConfig({ ...iconConfig, letter: e.target.value.slice(0, 2) })}
                placeholder={siteName?.[0] || 'Y'}
                maxLength={2}
                style={{
                  width: 40, textAlign: "center", padding: "4px 6px", borderRadius: 6,
                  border: "1px solid var(--embed-border)", background: "var(--embed-bg, transparent)",
                  color: "var(--embed-text)", fontSize: 13,
                }}
              />
            </div>
            <p className="embed-muted" style={{ fontSize: 10, marginTop: 6 }}>
              Uses your WordArt font and color. Updates automatically when WordArt changes.
            </p>
          </div>
        )}

        {/* Icons (Lucide) tab */}
        {iconTab === 'icons' && (
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Search 1700+ icons..."
              value={iconSearch}
              onChange={e => setIconSearch(e.target.value)}
              style={{
                width: "100%", padding: "6px 10px", borderRadius: 6, fontSize: 12, marginBottom: 8,
                border: "1px solid var(--embed-border)", background: "var(--embed-bg, transparent)",
                color: "var(--embed-text)", outline: "none",
              }}
            />
            {/* Icon color picker */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span className="embed-muted" style={{ fontSize: 11 }}>Icon color:</span>
              <input
                type="color"
                value={iconConfig.lucideColor || '#ffffff'}
                onChange={e => setIconConfig({ ...iconConfig, lucideColor: e.target.value })}
                style={{ width: 24, height: 24, borderRadius: 4, border: "1px solid var(--embed-border)", cursor: "pointer" }}
              />
              <span className="embed-mono embed-muted" style={{ fontSize: 10 }}>{iconConfig.lucideColor || '#ffffff'}</span>
            </div>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2,
              maxHeight: 220, overflowY: "auto", padding: 2,
            }}>
              {filteredIcons.map(entry => {
                const Icon = entry.component;
                const isActive = iconConfig.mode === 'lucide' && iconConfig.lucideIcon === entry.name;
                return (
                  <button
                    key={entry.name}
                    title={entry.name}
                    onClick={() => setIconConfig({ ...iconConfig, mode: 'lucide', lucideIcon: entry.name })}
                    style={{
                      width: '100%', aspectRatio: '1', display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: 6, cursor: "pointer",
                      border: isActive ? "2px solid var(--embed-primary)" : "1px solid transparent",
                      background: isActive ? "var(--embed-primary-light, rgba(139,92,246,0.15))" : "transparent",
                      color: "var(--embed-text)",
                    }}
                  >
                    <Icon style={{ width: 16, height: 16 }} />
                  </button>
                );
              })}
            </div>
            {filteredIcons.length === 0 && (
              <p className="embed-muted" style={{ fontSize: 11, textAlign: "center", padding: 16 }}>
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
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Search emoji by category..."
              value={emojiSearch}
              onChange={e => setEmojiSearch(e.target.value)}
              style={{
                width: "100%", padding: "6px 10px", borderRadius: 6, fontSize: 12, marginBottom: 8,
                border: "1px solid var(--embed-border)", background: "var(--embed-bg, transparent)",
                color: "var(--embed-text)", outline: "none",
              }}
            />
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {filteredEmojis.map(cat => (
                <div key={cat.name} style={{ marginBottom: 10 }}>
                  <p className="embed-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px 0" }}>
                    {cat.name}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                    {cat.emojis.map(emoji => {
                      const isActive = iconConfig.mode === 'emoji' && iconConfig.emoji === emoji;
                      return (
                        <button
                          key={emoji}
                          onClick={() => setIconConfig({ ...iconConfig, mode: 'emoji', emoji })}
                          style={{
                            width: 30, height: 30, fontSize: 16, borderRadius: 4, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            border: isActive ? "2px solid var(--embed-primary)" : "1px solid transparent",
                            background: isActive ? "var(--embed-primary-light, rgba(139,92,246,0.1))" : "transparent",
                          }}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload tab */}
        {iconTab === 'upload' && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0", marginBottom: 12 }}>
            {uploadPreview || iconConfig.uploadUrl ? (
              <div style={{ position: "relative" }}>
                <img
                  src={uploadPreview ?? iconConfig.uploadUrl!}
                  alt="Icon preview"
                  style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover", border: "1px solid var(--embed-border)" }}
                />
                <button
                  onClick={() => { setUploadPreview(null); setIconConfig({ ...iconConfig, uploadUrl: undefined }); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  style={{
                    position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%",
                    background: "#ef4444", color: "#fff", border: "none", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11,
                  }}
                >
                  ×
                </button>
              </div>
            ) : (
              <div style={{
                width: 64, height: 64, borderRadius: 12, border: "2px dashed var(--embed-border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--embed-muted-text, #888)", fontSize: 24,
              }}>
                +
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon" onChange={handleFileUpload} style={{ display: "none" }} />
            <button
              className="embed-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{ fontSize: 12, padding: "5px 14px" }}
            >
              {uploading ? 'Uploading...' : 'Choose Image'}
            </button>
            <p className="embed-muted" style={{ fontSize: 10, margin: 0 }}>PNG, JPEG, WebP, SVG, ICO — max 100KB</p>
          </div>
        )}

        {/* Style controls (shape + background) — not shown for upload */}
        {iconTab !== 'upload' && (
          <div style={{ borderTop: "1px solid var(--embed-border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Shape */}
            <div>
              <span className="embed-muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Shape</span>
              <div style={{ display: "flex", gap: 4 }}>
                {([
                  { id: 'rounded-square' as const, label: 'Rounded' },
                  { id: 'circle' as const, label: 'Circle' },
                  { id: 'square' as const, label: 'Square' },
                ]).map(({ id, label }) => (
                  <button key={id} className="embed-btn"
                    onClick={() => setIconConfig({ ...iconConfig, shape: id })}
                    style={{
                      fontSize: 11, padding: "3px 10px",
                      background: iconConfig.shape === id ? "var(--embed-primary)" : undefined,
                      color: iconConfig.shape === id ? "#fff" : undefined,
                      borderColor: iconConfig.shape === id ? "var(--embed-primary)" : undefined,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Background type */}
            <div>
              <span className="embed-muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Background</span>
              <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                {(['solid', 'gradient', 'transparent'] as const).map(type => (
                  <button key={type} className="embed-btn"
                    onClick={() => setIconConfig({
                      ...iconConfig,
                      background: {
                        ...iconConfig.background, type,
                        color: type === 'solid' ? (iconConfig.background.color || '#8B5CF6') : iconConfig.background.color,
                        gradient: type === 'gradient' ? (iconConfig.background.gradient || { from: '#8B5CF6', to: '#EC4899' }) : iconConfig.background.gradient,
                      },
                    })}
                    style={{
                      fontSize: 11, padding: "3px 10px", textTransform: "capitalize",
                      background: iconConfig.background.type === type ? "var(--embed-primary)" : undefined,
                      color: iconConfig.background.type === type ? "#fff" : undefined,
                      borderColor: iconConfig.background.type === type ? "var(--embed-primary)" : undefined,
                    }}
                  >
                    {type}
                  </button>
                ))}
              </div>

              {/* Solid color presets */}
              {iconConfig.background.type === 'solid' && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {BG_PRESETS.map(color => (
                    <button key={color}
                      onClick={() => setIconConfig({ ...iconConfig, background: { type: 'solid', color } })}
                      style={{
                        width: 24, height: 24, borderRadius: 6, backgroundColor: color, cursor: "pointer",
                        border: iconConfig.background.color === color ? "2px solid var(--embed-primary)" : "2px solid transparent",
                      }}
                    />
                  ))}
                  <input type="color" value={iconConfig.background.color || '#8B5CF6'}
                    onChange={e => setIconConfig({ ...iconConfig, background: { type: 'solid', color: e.target.value } })}
                    style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid var(--embed-border)", cursor: "pointer" }}
                    title="Custom color"
                  />
                </div>
              )}

              {/* Gradient presets */}
              {iconConfig.background.type === 'gradient' && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {GRADIENT_PRESETS.map(g => (
                      <button key={g.name} title={g.name}
                        onClick={() => setIconConfig({ ...iconConfig, background: { type: 'gradient', gradient: { from: g.from, to: g.to } } })}
                        style={{
                          width: 24, height: 24, borderRadius: 6, cursor: "pointer",
                          background: `linear-gradient(135deg, ${g.from}, ${g.to})`,
                          border: iconConfig.background.gradient?.from === g.from && iconConfig.background.gradient?.to === g.to
                            ? "2px solid var(--embed-primary)" : "2px solid transparent",
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="color" value={iconConfig.background.gradient?.from || '#8B5CF6'}
                        onChange={e => setIconConfig({ ...iconConfig, background: { ...iconConfig.background, type: 'gradient', gradient: { from: e.target.value, to: iconConfig.background.gradient?.to || '#EC4899' } } })}
                        style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid var(--embed-border)", cursor: "pointer" }}
                      />
                      <span className="embed-muted" style={{ fontSize: 9 }}>From</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="color" value={iconConfig.background.gradient?.to || '#EC4899'}
                        onChange={e => setIconConfig({ ...iconConfig, background: { ...iconConfig.background, type: 'gradient', gradient: { from: iconConfig.background.gradient?.from || '#8B5CF6', to: e.target.value } } })}
                        style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid var(--embed-border)", cursor: "pointer" }}
                      />
                      <span className="embed-muted" style={{ fontSize: 9 }}>To</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="embed-btn" onClick={handleSave} disabled={saving}
          style={{ background: "var(--embed-primary)", color: "#fff", borderColor: "var(--embed-primary)" }}>
          {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
        </button>
        <button className="embed-btn" onClick={handleReset}>
          Reset Defaults
        </button>
      </div>

      {/* Server Presets Gallery */}
      <div className="embed-card">
        <WordArtGalleryEmbed
          siteName={siteName}
          currentStyle={style}
          onApply={(s) => setStyle(s)}
        />
      </div>
    </div>
  );
}
