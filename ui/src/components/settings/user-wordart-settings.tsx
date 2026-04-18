"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import WordArtPicker from "@/components/wordart/WordArtPicker";
import { WordArtGallery } from "./wordart-gallery";
import { Save, Loader2, Check, RotateCcw } from "lucide-react";

interface UserWordartSettingsProps {
  siteName: string;
  serverDefault: SiteNameStyle;
}

export function UserWordartSettings({ siteName, serverDefault }: UserWordartSettingsProps) {
  const [style, setStyle] = useState<SiteNameStyle>(serverDefault);
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);

  const loadOverride = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/user/wordart");
      if (!res.ok) return;
      const data = await res.json();
      if (data.wordart) {
        setStyle(data.wordart);
        setHasOverride(true);
      }
    } catch { /* use server default */ }
    setLoaded(true);
  }, []);

  useEffect(() => { loadOverride(); }, [loadOverride]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/user/wordart", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordart: style }),
      });
      if (res.ok) {
        setHasOverride(true);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally { setSaving(false); }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/user/wordart", { method: "DELETE" });
      if (res.ok) {
        setStyle(serverDefault);
        setHasOverride(false);
        setPickerKey((k) => k + 1);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally { setSaving(false); }
  };

  const handleApplyPreset = (presetStyle: SiteNameStyle) => {
    setStyle(presetStyle);
    setPickerKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">My WordArt</h3>
        <p className="text-sm text-muted-foreground">
          Customize the site name style on your dashboard. This only affects your view.
        </p>
      </div>

      {loaded ? (
        <WordArtPicker key={pickerKey} siteName={siteName} initialStyle={style} onChange={setStyle} compact />
      ) : (
        <div className="flex items-center justify-center h-32 rounded-md border border-dashed">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button onClick={handleSave} disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? "Saved!" : "Save"}
        </button>
        {hasOverride && (
          <button onClick={handleReset} disabled={saving}
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
            <RotateCcw className="h-4 w-4" />
            Reset to Default
          </button>
        )}
      </div>

      <div className="border-t pt-4">
        <WordArtGallery
          siteName={siteName}
          serverDefault={serverDefault}
          currentStyle={style}
          onApply={handleApplyPreset}
          onSave={async () => {}}
          scope="user"
        />
      </div>
    </div>
  );
}
