/**
 * Per-App Branding Tab
 *
 * Two sub-tabs:
 * - "My Branding" (all users) — user override for this app's header
 * - "Server Default" (admin only) — admin-set default branding for this app
 *
 * Each sub-tab has: Header Display Mode toggle, WordArt picker, preset gallery.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import WordArtPicker from "@/components/wordart/WordArtPicker";
import { WordArtGallery } from "./wordart-gallery";
import { Save, Loader2, Check, RotateCcw, Server, Type, Image, LayoutList } from "lucide-react";

interface AppBrandingTabProps {
  appId: string;
  appName: string;
  isAdmin: boolean;
}

type DisplayMode = "logo-text" | "text-only" | "logo-only";

const DISPLAY_MODES: { id: DisplayMode; label: string; icon: typeof Type }[] = [
  { id: "logo-text", label: "Logo + Text", icon: LayoutList },
  { id: "text-only", label: "Text Only", icon: Type },
  { id: "logo-only", label: "Logo Only", icon: Image },
];

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

function BrandingEditor({
  appId,
  appName,
  scope,
  serverDefault,
  serverDisplayMode,
}: {
  appId: string;
  appName: string;
  scope: "user" | "server";
  serverDefault: SiteNameStyle;
  serverDisplayMode: DisplayMode;
}) {
  const [style, setStyle] = useState<SiteNameStyle>(serverDefault);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(serverDisplayMode);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);

  const apiBase = scope === "user"
    ? `/api/v1/user/apps/${appId}/branding`
    : `/api/v1/admin/apps/${appId}/branding`;

  const presetsBase = scope === "user"
    ? `/api/v1/user/apps/${appId}/wordart/presets`
    : `/api/v1/admin/apps/${appId}/wordart/presets`;

  const loadBranding = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) return;
      const data = await res.json();
      if (scope === "user") {
        // For user: the API returns resolved branding (user override > admin default)
        // We want to show user's own override if set, otherwise the admin default
        if (data.brandingWordart) setStyle(data.brandingWordart);
        if (data.headerDisplayMode) setDisplayMode(data.headerDisplayMode);
      } else {
        // For admin: show admin default directly
        if (data.brandingWordart) setStyle(data.brandingWordart);
        if (data.headerDisplayMode) setDisplayMode(data.headerDisplayMode);
      }
    } catch { /* use defaults */ }
    setLoaded(true);
  }, [apiBase, scope]);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandingWordart: style,
          headerDisplayMode: displayMode,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally { setSaving(false); }
  };

  const handleReset = async () => {
    if (scope === "user") {
      setSaving(true);
      try {
        const res = await fetch(apiBase, { method: "DELETE" });
        if (res.ok) {
          setStyle(serverDefault);
          setDisplayMode(serverDisplayMode);
          setPickerKey((k) => k + 1);
        }
      } finally { setSaving(false); }
    } else {
      // Admin reset: clear admin branding
      setSaving(true);
      try {
        const res = await fetch(apiBase, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandingWordart: null,
            headerDisplayMode: "logo-text",
          }),
        });
        if (res.ok) {
          setStyle(DEFAULT_STYLE);
          setDisplayMode("logo-text");
          setPickerKey((k) => k + 1);
        }
      } finally { setSaving(false); }
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Display Mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Header Display Mode</label>
        <div className="flex gap-2">
          {DISPLAY_MODES.map((mode) => {
            const Icon = mode.icon;
            return (
              <button
                key={mode.id}
                onClick={() => setDisplayMode(mode.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors ${
                  displayMode === mode.id
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-muted hover:border-muted-foreground/30 text-muted-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* WordArt Picker — only if display mode includes text */}
      {displayMode !== "logo-only" && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Title WordArt</label>
          <WordArtPicker
            key={pickerKey}
            siteName={appName}
            value={style}
            onChange={setStyle}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? "Saved!" : "Save"}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw className="w-4 h-4" />
          {scope === "user" ? "Reset to Server Default" : "Clear Branding"}
        </button>
      </div>

      {/* Preset Gallery */}
      {displayMode !== "logo-only" && (
        <WordArtGallery
          siteName={appName}
          serverDefault={serverDefault}
          currentStyle={style}
          onApply={(s) => { setStyle(s); setPickerKey((k) => k + 1); }}
          onSave={async () => {}}
          scope={scope}
          appId={appId}
        />
      )}
    </div>
  );
}

export function AppBrandingTab({ appId, appName, isAdmin }: AppBrandingTabProps) {
  const [tab, setTab] = useState<"my-branding" | "server-default">("my-branding");
  const [adminDefault, setAdminDefault] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [adminDisplayMode, setAdminDisplayMode] = useState<DisplayMode>("logo-text");
  const [loaded, setLoaded] = useState(false);

  // Load admin defaults for both sub-tabs
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/user/apps/${appId}/branding`);
        if (res.ok) {
          const data = await res.json();
          if (data.adminBrandingWordart) setAdminDefault(data.adminBrandingWordart);
          if (data.adminHeaderDisplayMode) setAdminDisplayMode(data.adminHeaderDisplayMode as DisplayMode);
        }
      } catch { /* defaults */ }
      setLoaded(true);
    })();
  }, [appId]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setTab("my-branding")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "my-branding"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          My Branding
        </button>
        {isAdmin && (
          <button
            onClick={() => setTab("server-default")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === "server-default"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            Server Default
          </button>
        )}
      </div>

      {tab === "my-branding" && (
        <BrandingEditor
          appId={appId}
          appName={appName}
          scope="user"
          serverDefault={adminDefault}
          serverDisplayMode={adminDisplayMode}
        />
      )}

      {tab === "server-default" && isAdmin && (
        <BrandingEditor
          appId={appId}
          appName={appName}
          scope="server"
          serverDefault={DEFAULT_STYLE}
          serverDisplayMode="logo-text"
        />
      )}
    </div>
  );
}
