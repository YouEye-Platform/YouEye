"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import WordArtGalleryEmbed from "@/components/embed/WordArtGalleryEmbed";
import type { IconConfig } from "@/lib/icon-config";
import { DEFAULT_ICON_CONFIG } from "@/lib/icon-config";

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

// ─── Emoji presets ─────────────────────────────────────────────
const EMOJI_GRID = [
  '🏠', '🚀', '💻', '⭐', '🔥', '💎', '🎯', '🏆',
  '🌈', '⚡', '🎨', '🎮', '🛡️', '🌐', '🔑', '📡',
  '💡', '🎵', '🌸', '☕', '🧊', '🦊', '🐱', '🐶',
];

const BG_PRESETS = [
  '#8B5CF6', '#EC4899', '#3B82F6', '#10B981', '#F59E0B',
  '#EF4444', '#6366F1', '#14B8A6', '#1E293B', '#111827',
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
  }

  ctx.restore();
}

export function BrandingEmbedClient() {
  const [siteName, setSiteName] = useState("YouEye");
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [iconConfig, setIconConfig] = useState<IconConfig>(DEFAULT_ICON_CONFIG);
  const [iconTab, setIconTab] = useState<'letter' | 'emoji'>('letter');
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
        setIconTab(data.icon_config.mode === 'emoji' ? 'emoji' : 'letter');
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
          const offscreen = document.createElement('canvas');
          renderIconCanvas(offscreen, iconConfig, siteName, style, 512);
          const blob = await new Promise<Blob | null>(resolve =>
            offscreen.toBlob(resolve, 'image/png')
          );
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
  };

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

      {/* Server Icon */}
      <div className="embed-card">
        <div className="embed-card-title">Server Icon</div>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {/* Preview */}
          <div style={{ flexShrink: 0 }}>
            <canvas
              ref={iconCanvasRef}
              width={128}
              height={128}
              style={{ width: 64, height: 64, borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }}
            />
          </div>

          {/* Controls */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Mode tabs */}
            <div style={{ display: "flex", gap: 4 }}>
              {(['letter', 'emoji'] as const).map(tab => (
                <button
                  key={tab}
                  className="embed-btn"
                  onClick={() => { setIconTab(tab); setIconConfig({ ...iconConfig, mode: tab }); }}
                  style={{
                    background: iconTab === tab ? "var(--embed-primary)" : undefined,
                    color: iconTab === tab ? "#fff" : undefined,
                    borderColor: iconTab === tab ? "var(--embed-primary)" : undefined,
                    fontSize: 12,
                    padding: "4px 12px",
                  }}
                >
                  {tab === 'letter' ? 'Letter' : 'Emoji'}
                </button>
              ))}
            </div>

            {/* Letter tab */}
            {iconTab === 'letter' && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="embed-muted" style={{ fontSize: 11 }}>Custom letter:</span>
                <input
                  type="text"
                  value={iconConfig.letter || ''}
                  onChange={e => setIconConfig({ ...iconConfig, letter: e.target.value.slice(0, 2) })}
                  placeholder={siteName?.[0] || 'Y'}
                  maxLength={2}
                  style={{
                    width: 40,
                    textAlign: "center",
                    padding: "4px 6px",
                    borderRadius: 6,
                    border: "1px solid var(--embed-border)",
                    background: "var(--embed-bg, transparent)",
                    color: "var(--embed-text)",
                    fontSize: 13,
                  }}
                />
              </div>
            )}

            {/* Emoji tab */}
            {iconTab === 'emoji' && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 280 }}>
                {EMOJI_GRID.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => setIconConfig({ ...iconConfig, mode: 'emoji', emoji })}
                    style={{
                      width: 32,
                      height: 32,
                      fontSize: 18,
                      borderRadius: 6,
                      border: iconConfig.mode === 'emoji' && iconConfig.emoji === emoji
                        ? "2px solid var(--embed-primary)"
                        : "1px solid transparent",
                      background: iconConfig.mode === 'emoji' && iconConfig.emoji === emoji
                        ? "var(--embed-primary-light, rgba(139,92,246,0.1))"
                        : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}

            {/* Shape */}
            <div>
              <span className="embed-muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Shape</span>
              <div style={{ display: "flex", gap: 4 }}>
                {([
                  { id: 'rounded-square' as const, label: 'Rounded' },
                  { id: 'circle' as const, label: 'Circle' },
                  { id: 'square' as const, label: 'Square' },
                ]).map(({ id, label }) => (
                  <button
                    key={id}
                    className="embed-btn"
                    onClick={() => setIconConfig({ ...iconConfig, shape: id })}
                    style={{
                      fontSize: 11,
                      padding: "3px 10px",
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

            {/* Background */}
            <div>
              <span className="embed-muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Background</span>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {BG_PRESETS.map(color => (
                  <button
                    key={color}
                    onClick={() => setIconConfig({ ...iconConfig, background: { type: 'solid', color } })}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      backgroundColor: color,
                      border: iconConfig.background.type === 'solid' && iconConfig.background.color === color
                        ? "2px solid var(--embed-primary)"
                        : "2px solid transparent",
                      cursor: "pointer",
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={iconConfig.background.color || '#8B5CF6'}
                  onChange={e => setIconConfig({ ...iconConfig, background: { type: 'solid', color: e.target.value } })}
                  style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid var(--embed-border)", cursor: "pointer" }}
                  title="Custom color"
                />
              </div>
            </div>
          </div>
        </div>
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
