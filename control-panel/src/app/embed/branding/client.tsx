"use client";

import { useEffect, useState, useCallback } from "react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";

interface BrandingData {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  logo_url: string | null;
  favicon_url: string | null;
  accent_color: string;
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

export function BrandingEmbedClient() {
  const [siteName, setSiteName] = useState("YouEye");
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBranding = useCallback(async () => {
    try {
      const res = await fetch("/api/ui/branding");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: BrandingData = await res.json();
      setSiteName(data.site_name);
      setAccentColor(data.accent_color ?? "#8B5CF6");
      if (data.site_name_style) setStyle(data.site_name_style);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load branding");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_name: siteName, site_name_style: style, accent_color: accentColor }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    </div>
  );
}
