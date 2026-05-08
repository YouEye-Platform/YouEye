/**
 * Per-App Branding Tab
 *
 * Two sub-tabs:
 * - "My Branding" (all users) — user override for this app's header
 * - "Server Default" (admin only) — admin-set default branding for this app
 *
 * Each sub-tab has: Icon picker, Display Name, Header Display Mode, WordArt picker, preset gallery.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import WordArtPicker from "@/components/wordart/WordArtPicker";
import { WordArtGallery } from "./wordart-gallery";
import { IconPicker, type IconPickerResult } from "@/components/icon-picker";
import {
  Save,
  Loader2,
  Check,
  RotateCcw,
  Server,
  Type,
  Image,
  LayoutList,
  ChevronDown,
  ChevronRight,
  Pencil,
  Palette,
} from "lucide-react";

interface AppBrandingTabProps {
  appId: string;
  appName: string;
  appIcon: string | null;
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

/** Render an app icon value as a preview element */
function IconPreview({ icon, size = "w-10 h-10" }: { icon: string | null; size?: string }) {
  if (!icon) return <div className={`${size} rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-xs`}>?</div>;
  if (icon.startsWith("emoji:")) {
    return <div className={`${size} rounded-lg bg-muted flex items-center justify-center text-2xl`}>{icon.replace("emoji:", "")}</div>;
  }
  if (icon.startsWith("/") || icon.startsWith("http")) {
    return <img src={icon} alt="" className={`${size} rounded-lg object-cover`} />;
  }
  // Lucide icon name — just show the name as text since we can't dynamically import
  return <div className={`${size} rounded-lg bg-muted flex items-center justify-center text-muted-foreground text-[10px] text-center leading-tight px-1`}>{icon}</div>;
}

function BrandingEditor({
  appId,
  appName,
  appIcon,
  scope,
  serverDefault,
  serverDisplayMode,
}: {
  appId: string;
  appName: string;
  appIcon: string | null;
  scope: "user" | "server";
  serverDefault: SiteNameStyle;
  serverDisplayMode: DisplayMode;
}) {
  const [style, setStyle] = useState<SiteNameStyle>(serverDefault);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(serverDisplayMode);
  const [customName, setCustomName] = useState<string>("");
  const [customIconUrl, setCustomIconUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [iconOpen, setIconOpen] = useState(false);
  const [wordartOpen, setWordartOpen] = useState(true);

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
      if (data.brandingWordart) setStyle(data.brandingWordart);
      if (data.headerDisplayMode) setDisplayMode(data.headerDisplayMode);
      if (scope === "user") {
        if (data.customName) setCustomName(data.customName);
        if (data.customIconUrl) setCustomIconUrl(data.customIconUrl);
      }
    } catch { /* use defaults */ }
    setLoaded(true);
  }, [apiBase, scope]);

  useEffect(() => { loadBranding(); }, [loadBranding]);

  const handleIconSelect = (result: IconPickerResult) => {
    setCustomIconUrl(result.value);
    setIconOpen(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        brandingWordart: style,
        headerDisplayMode: displayMode,
      };
      if (scope === "user") {
        body.customName = customName || null;
        body.customIconUrl = customIconUrl;
      }
      const res = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
          setCustomName("");
          setCustomIconUrl(null);
          setPickerKey((k) => k + 1);
        }
      } finally { setSaving(false); }
    } else {
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

  const displayedName = customName || appName;
  const displayedIcon = customIconUrl || appIcon;

  return (
    <div className="space-y-6">
      {/* ─── Icon & Display Name (user scope only) ─── */}
      {scope === "user" && (
        <div className="space-y-4">
          {/* Display Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Pencil className="w-3.5 h-3.5" />
              Display Name
            </label>
            <div className="flex items-center gap-3">
              <IconPreview icon={displayedIcon} />
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={appName}
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            {customName && customName !== appName && (
              <p className="text-[11px] text-muted-foreground">
                Original name: {appName}
              </p>
            )}
          </div>

          {/* Icon Picker (collapsible) */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setIconOpen(!iconOpen)}
              className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground transition-colors"
            >
              {iconOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Palette className="w-3.5 h-3.5" />
              Custom Icon
            </button>
            {customIconUrl && (
              <div className="flex items-center gap-2">
                <IconPreview icon={customIconUrl} size="w-8 h-8" />
                <button
                  type="button"
                  onClick={() => setCustomIconUrl(null)}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  Reset to default
                </button>
              </div>
            )}
            {iconOpen && (
              <div className="border rounded-lg p-3 bg-card">
                <IconPicker
                  currentIcon={customIconUrl}
                  onSelect={handleIconSelect}
                  compact
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Header Display Mode ─── */}
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

      {/* ─── WordArt Picker (collapsible) ─── */}
      {displayMode !== "logo-only" && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setWordartOpen(!wordartOpen)}
            className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground transition-colors"
          >
            {wordartOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Title WordArt
          </button>
          {wordartOpen && (
            <WordArtPicker
              key={pickerKey}
              siteName={displayedName}
              initialStyle={style}
              onChange={setStyle}
            />
          )}
        </div>
      )}

      {/* ─── Action buttons ─── */}
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

      {/* ─── Preset Gallery ─── */}
      {displayMode !== "logo-only" && wordartOpen && (
        <WordArtGallery
          siteName={displayedName}
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

export function AppBrandingTab({ appId, appName, appIcon, isAdmin }: AppBrandingTabProps) {
  const [tab, setTab] = useState<"my-branding" | "server-default">("my-branding");
  const [adminDefault, setAdminDefault] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [adminDisplayMode, setAdminDisplayMode] = useState<DisplayMode>("logo-text");
  const [loaded, setLoaded] = useState(false);

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
          appIcon={appIcon}
          scope="user"
          serverDefault={adminDefault}
          serverDisplayMode={adminDisplayMode}
        />
      )}

      {tab === "server-default" && isAdmin && (
        <BrandingEditor
          appId={appId}
          appName={appName}
          appIcon={appIcon}
          scope="server"
          serverDefault={DEFAULT_STYLE}
          serverDisplayMode="logo-text"
        />
      )}
    </div>
  );
}
