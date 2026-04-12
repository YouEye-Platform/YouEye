/**
 * Branding Settings (Admin Only)
 *
 * WordArt picker + logo/favicon upload + accent color.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import WordArtPicker from "@/components/wordart/WordArtPicker";
import { Upload, RotateCcw, Save, Loader2, Check, X } from "lucide-react";

const DEFAULT_STYLE: SiteNameStyle = {
  fontFamily: "Inter", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0.02em",
  color: "#ffffff", gradient: null, textShadow: "none", textTransform: "none",
};

export function BrandingSettings() {
  const [siteName, setSiteName] = useState("YouEye");
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadBranding = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/branding");
      if (!res.ok) return;
      const data = await res.json();
      setSiteName(data.site_name);
      setAccentColor(data.accent_color ?? "#8B5CF6");
      setLogoUrl(data.logo_url);
      setFaviconUrl(data.favicon_url);
      if (data.site_name_style) setStyle(data.site_name_style);
    } catch { /* defaults */ }
    setLoaded(true);
  }, []);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  const handleStyleChange = useCallback((newStyle: SiteNameStyle) => {
    setStyle(newStyle);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/v1/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_name: siteName, site_name_style: style, accent_color: accentColor }),
      });
      // Sync to Authentik login page
      fetch("/api/admin/authentik/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => {});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const handleReset = () => {
    setStyle(DEFAULT_STYLE);
    setSiteName("YouEye");
    setAccentColor("#8B5CF6");
  };

  const handleFileUpload = async (type: "logo" | "favicon", file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("type", type);
    const res = await fetch("/api/v1/branding/upload", { method: "POST", body: formData });
    if (res.ok) {
      const data = await res.json();
      if (type === "logo") setLogoUrl(data.url);
      else setFaviconUrl(data.url);
    }
  };

  return (
    <div className="space-y-6">
      {/* Site Name */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Site Name</label>
        <input
          type="text" value={siteName} onChange={e => setSiteName(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder="YouEye"
        />
      </div>

      {/* WordArt Picker */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Site Name Style</label>
        {loaded ? (
          <WordArtPicker siteName={siteName} initialStyle={style} onChange={handleStyleChange} compact />
        ) : (
          <div className="flex items-center justify-center h-32 rounded-md border border-dashed">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Accent Color */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Accent Color</label>
        <div className="flex items-center gap-3">
          <input type="color" value={accentColor} onChange={e => setAccentColor(e.target.value)}
            className="w-10 h-10 rounded border cursor-pointer" />
          <span className="text-sm text-muted-foreground font-mono">{accentColor}</span>
        </div>
      </div>

      {/* Logo Upload */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Logo</label>
        <div className="flex items-center gap-3">
          {logoUrl && <img src={logoUrl} alt="Logo" className="w-10 h-10 object-contain rounded border" />}
          <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors">
            <Upload className="h-4 w-4" />
            Upload
            <input type="file" accept="image/png,image/svg+xml" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload("logo", f); }} />
          </label>
          {logoUrl && (
            <button onClick={() => setLogoUrl(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Favicon Upload */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Favicon</label>
        <div className="flex items-center gap-3">
          {faviconUrl && <img src={faviconUrl} alt="Favicon" className="w-6 h-6 object-contain rounded border" />}
          <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors">
            <Upload className="h-4 w-4" />
            Upload
            <input type="file" accept="image/x-icon,image/png" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload("favicon", f); }} />
          </label>
          {faviconUrl && (
            <button onClick={() => setFaviconUrl(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <button onClick={handleSave} disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? "Saved!" : "Save Changes"}
        </button>
        <button onClick={handleReset}
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>
    </div>
  );
}
