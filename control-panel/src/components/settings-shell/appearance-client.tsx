"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Monitor, Moon, Palette, RotateCcw, Save, Sun } from "lucide-react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { uiSettingsApi } from "./api-base";
import { applyThemeMode, broadcastThemeMode, type ThemeMode } from "@/lib/theme";
import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import { notifyAppearanceSaved } from "@youeye/branding/appearance-events";
import { useRef as useInterfaceTranslationRef } from "react";

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

interface AppearanceClientProps {
  isAdmin: boolean;
}

interface Theme {
  id: string;
  name: string;
  colors?: Record<string, string>;
  isPreset?: boolean;
}

interface Branding {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  accent_color?: string | null;
  logo_url?: string | null;
  favicon_url?: string | null;
}

function tabClass(active: boolean) {
  return `border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground"
  }`;
}

function swatchColors(theme: Theme) {
  return Object.values(theme.colors || {}).slice(0, 5);
}

function BrandingTabs({ isAdmin }: { isAdmin: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [tab, setTab] = useState<"my-wordart" | "server-branding">("my-wordart");
  const [branding, setBranding] = useState<Branding | null>(null);
  const [myStyle, setMyStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [hasPersonalTitle, setHasPersonalTitle] = useState(false);
  const [serverStyle, setServerStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [siteName, setSiteName] = useState("YouEye");
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [brandingReady, setBrandingReady] = useState(false);

  const load = useCallback(async () => {
    const [brandingRes, wordartRes] = await Promise.all([
      fetch("/api/ui/branding", { cache: "no-store" }),
      fetch(uiSettingsApi("wordart"), { cache: "no-store" }),
    ]);
    if (!brandingRes.ok || !wordartRes.ok) throw new Error(interfaceTranslationRef.current("m73e43c9933f5"));
    const nextBranding = await brandingRes.json();
    const wordart = wordartRes.ok ? await wordartRes.json() : null;
    if (nextBranding) {
      setBranding(nextBranding);
      setSiteName(nextBranding.site_name || "YouEye");
      setAccentColor(nextBranding.accent_color || "#8B5CF6");
      const style = nextBranding.site_name_style || DEFAULT_STYLE;
      setServerStyle(style);
      setMyStyle(wordart?.wordart || style);
      setHasPersonalTitle(wordart?.wordart != null);
      setBrandingReady(true);
    }
  }, []);

  useEffect(() => { load().catch(() => setStatus(interfaceTranslationRef.current("mfbc0355a01b6"))); }, [load]);

  async function saveMyWordArt() {
    if (!brandingReady || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("wordart"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordart: { ...myStyle, mytitle: myStyle.mytitle || initialDesign(branding?.site_name || "YouEye") } }),
      });
      if (res.ok) {
        const saved = await res.json();
        setMyStyle(saved.wordart);
        setHasPersonalTitle(true);
        notifyAppearanceSaved();
      }
      setStatus(res.ok ? translateInterface("mb5c120b316c2") : translateInterface("m53ad6f999b1f"));
    } catch {
      setStatus(translateInterface("mdeef0ac7e1a7"));
    } finally {
      setSaving(false);
    }
  }

  async function resetMyWordArt() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(uiSettingsApi("wordart"), { method: "DELETE" });
      if (res.ok) {
        // Read the saved server appearance, never an unsaved administrator draft.
        notifyAppearanceSaved();
        await load();
      }
      setStatus(res.ok ? translateInterface("mdaee7606b339") : translateInterface("m089cb45b70a0"));
    } catch {
      setStatus(translateInterface("mee741ad8f51f"));
    } finally {
      setSaving(false);
    }
  }

  async function saveServerBranding() {
    if (!brandingReady || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: siteName,
          site_name_style: { ...serverStyle, mytitle: serverStyle.mytitle || initialDesign(siteName) },
          expected_revision: branding?.site_name_style?.mytitleRevision ?? null,
          accent_color: accentColor,
          logo_url: branding?.logo_url ?? null,
          favicon_url: branding?.favicon_url ?? null,
        }),
      });
      setStatus(res.ok ? translateInterface("mb5c120b316c2") : res.status === 409 ? translateInterface("m17101f149928") : translateInterface("m53ad6f999b1f"));
      if (res.ok) {
        notifyAppearanceSaved();
        await load();
      }
    } catch {
      setStatus(translateInterface("m123b50166680"));
    } finally {
      setSaving(false);
    }
  }

  if (!brandingReady) {
    return (
      <section className="space-y-3" aria-busy={!status}>
        <p role={status ? "alert" : "status"}>{status || translateInterface("m4d6ed05cad3d")}</p>
        {status && <Button variant="outline" onClick={() => {
          setStatus("");
          load().catch(() => setStatus(translateInterface("mfbc0355a01b6")));
        }}>{translateInterface("md8b8392e2c54")}</Button>}
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex gap-1 border-b">
        <button className={tabClass(tab === "my-wordart")} onClick={() => setTab("my-wordart")}>{translateInterface("mf10711672771")}</button>
        {isAdmin && <button className={tabClass(tab === "server-branding")} onClick={() => setTab("server-branding")}>{translateInterface("m6c567bcc7589")}</button>}
      </div>

      {tab === "my-wordart" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold">{translateInterface("mf10711672771")}</h3>
            <p className="text-sm text-muted-foreground">{translateInterface("m2573d00b8bb9")}{hasPersonalTitle ? translateInterface("mef1b9738c762") : translateInterface("me0eb9f44c2d0")}</p>
          </div>
          <WordArtPickerInline siteName={branding?.site_name || "YouEye"} style={myStyle} setStyle={setMyStyle} />
          <div className="studio-save-bar flex gap-3">
            <Button onClick={saveMyWordArt} disabled={saving || !brandingReady} size="sm"><Save className="h-4 w-4" /> {translateInterface("m1509f561f241")}</Button>
            <Button onClick={resetMyWordArt} disabled={saving || !brandingReady} variant="outline" size="sm"><RotateCcw className="h-4 w-4" /> {translateInterface("m0fbea84dff55")}</Button>
          </div>

        </div>
      )}

      {tab === "server-branding" && isAdmin && (
        <div className="space-y-5">
          <div>
            <h3 className="text-base font-semibold">{translateInterface("m1713ce3d42f1")}</h3>
            <p className="text-sm text-muted-foreground">{translateInterface("m91c7731241e9")}</p>
          </div>
          <TitleStudio design={serverStyle.mytitle || initialDesign(siteName)} onChange={(design) => {
            setSiteName(design.name);
            setServerStyle((style) => ({ ...style, mytitle: design }));
          }} />
          <label className="flex items-center justify-between gap-4 rounded-xl border p-4 text-sm">
            <span><span className="block font-medium">{translateInterface("ma607f90a3d24")}</span><span className="text-muted-foreground">{translateInterface("m3a165ba8b440")}</span></span>
            <Switch checked={serverStyle.showHeaderLogo === true} onCheckedChange={(showHeaderLogo) => setServerStyle((style) => ({ ...style, showHeaderLogo }))} />
          </label>
          <div className="studio-save-bar"><Button onClick={saveServerBranding} disabled={saving || !brandingReady}><Save className="h-4 w-4" />{saving ? translateInterface("m23e39291d613") : translateInterface("mdec2db9309ac")}</Button><span role="status" className="text-sm">{status}</span></div>
        </div>
      )}

      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </section>
  );
}

function ThemeSettings() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [mode, setMode] = useState("system");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(uiSettingsApi("themes")).then((r) => r.json()),
      fetch(uiSettingsApi("themes/active")).then((r) => r.json()),
    ])
      .then(([allThemes, active]) => {
        setThemes(Array.isArray(allThemes) ? allThemes : []);
        setActiveId(active.id || null);
        setActiveName(active.name || null);
        setMode(active.mode || "system");
      })
      .catch(() => setStatus(interfaceTranslationRef.current("mda137f32b86e")))
      .finally(() => setLoading(false));
  }, []);

  async function selectTheme(themeId: string) {
    setActiveId(themeId);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId }),
    });
    const data = res.ok ? await res.json() : null;
    if (data?.name) setActiveName(data.name);
    setStatus(res.ok ? translateInterface("mf172e79132fc") : translateInterface("m6530c2cf3950"));
  }

  async function selectMode(nextMode: string) {
    setMode(nextMode);
    // Apply immediately so this page re-themes on click, and tell the header
    // (source-of-truth state) so it stays in sync; the PUT below persists it.
    applyThemeMode(nextMode as ThemeMode);
    broadcastThemeMode(nextMode as ThemeMode);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    });
    setStatus(res.ok ? translateInterface("ma263d21422c0") : translateInterface("m8eaeda81ecca"));
  }

  const modes = [
    { id: "light", label: translateInterface("mdbcd5e7bb7a0"), icon: Sun },
    { id: "dark", label: translateInterface("m60acc53f13a5"), icon: Moon },
    { id: "system", label: translateInterface("m6725e7bbcd28"), icon: Monitor },
  ];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{translateInterface("mb012e90c4079")}</h3>
          <p className="text-sm text-muted-foreground">{translateInterface("m31efa2e5b94d")}</p>
        </div>
        {activeName && <Badge variant="secondary" className="gap-1.5"><Palette className="h-3 w-3" />{activeName}</Badge>}
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {themes.map((theme) => (
            <button key={theme.id} onClick={() => selectTheme(theme.id)} className={`rounded-lg border p-3 text-left transition-colors hover:bg-accent/40 ${activeId === theme.id ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
              <div className="mb-2.5 flex gap-1.5">
                {swatchColors(theme).map((color, index) => <span key={`${theme.id}-${index}`} className="h-6 w-6 rounded-full border" style={{ backgroundColor: color }} />)}
              </div>
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium">{theme.name}</span>
                {activeId === theme.id && <Check className="h-4 w-4 text-primary" />}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-base font-semibold">{translateInterface("m5e23ec6a300d")}</h3>
        <div className="flex flex-wrap gap-3">
          {modes.map((item) => {
            const Icon = item.icon;
            const active = mode === item.id;
            return (
              <button key={item.id} onClick={() => selectMode(item.id)} className={`flex items-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors ${active ? "border-primary bg-primary/5" : "border-transparent bg-muted hover:bg-accent"}`}>
                <Icon className="h-5 w-5" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </section>
  );
}

export function AppearanceClient({ isAdmin }: AppearanceClientProps) {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div className="space-y-10">
      <PageHeader title={translateInterface("m3907fa7f8072")} description={translateInterface("m5650a6cd91ea")} />
      <BrandingTabs isAdmin={isAdmin} />
      <ThemeSettings />
    </div>
  );
}
