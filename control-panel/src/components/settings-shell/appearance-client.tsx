"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, Loader2, Monitor, Moon, Palette, Pencil, Plus, RotateCcw, Save, Sun, Upload } from "lucide-react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import WordArtGalleryEmbed from "@/components/embed/WordArtGalleryEmbed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { uiSettingsApi } from "./api-base";

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

interface DrawerApp {
  id: string;
  name: string;
  original_name?: string;
  icon: string | null;
  custom_icon_url?: string | null;
  visible: boolean;
  status: string | null;
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
  const [tab, setTab] = useState<"my-wordart" | "server-branding">("my-wordart");
  const [branding, setBranding] = useState<Branding | null>(null);
  const [myStyle, setMyStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [serverStyle, setServerStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [siteName, setSiteName] = useState("YouEye");
  const [accentColor, setAccentColor] = useState("#8B5CF6");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [brandingRes, wordartRes] = await Promise.all([
      fetch("/api/ui/branding"),
      fetch(uiSettingsApi("wordart")),
    ]);
    const nextBranding = brandingRes.ok ? await brandingRes.json() : null;
    const wordart = wordartRes.ok ? await wordartRes.json() : null;
    if (nextBranding) {
      setBranding(nextBranding);
      setSiteName(nextBranding.site_name || "YouEye");
      setAccentColor(nextBranding.accent_color || "#8B5CF6");
      const style = nextBranding.site_name_style || DEFAULT_STYLE;
      setServerStyle(style);
      setMyStyle(wordart?.wordart || style);
    }
  }, []);

  useEffect(() => { load().catch(() => setStatus("Could not load branding.")); }, [load]);

  async function saveMyWordArt() {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("wordart"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordart: myStyle }),
      });
      setStatus(res.ok ? "Saved" : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function resetMyWordArt() {
    setSaving(true);
    try {
      const res = await fetch(uiSettingsApi("wordart"), { method: "DELETE" });
      if (res.ok) setMyStyle(serverStyle);
      setStatus(res.ok ? "Reset" : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveServerBranding() {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: siteName,
          site_name_style: serverStyle,
          accent_color: accentColor,
          logo_url: branding?.logo_url ?? null,
          favicon_url: branding?.favicon_url ?? null,
        }),
      });
      setStatus(res.ok ? "Saved" : "Save failed");
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  }

  async function uploadAsset(type: "logo" | "favicon", file: File) {
    const formData = new FormData();
    formData.append("type", type);
    formData.append("file", file);
    const res = await fetch("/api/ui/branding/upload", { method: "POST", body: formData });
    if (!res.ok) {
      setStatus("Upload failed");
      return;
    }
    const data = await res.json();
    setBranding((current) => current ? { ...current, [`${type}_url`]: data.url } as Branding : current);
    setStatus("Uploaded");
  }

  return (
    <section className="space-y-6">
      <div className="flex gap-1 border-b">
        <button className={tabClass(tab === "my-wordart")} onClick={() => setTab("my-wordart")}>My WordArt</button>
        {isAdmin && <button className={tabClass(tab === "server-branding")} onClick={() => setTab("server-branding")}>Server Branding</button>}
      </div>

      {tab === "my-wordart" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold">My WordArt</h3>
            <p className="text-sm text-muted-foreground">Customize the site name style on your dashboard. This only affects your view.</p>
          </div>
          <WordArtPickerInline siteName={siteName} style={myStyle} setStyle={setMyStyle} />
          <div className="flex gap-3">
            <Button onClick={saveMyWordArt} disabled={saving} size="sm"><Save className="h-4 w-4" /> Save</Button>
            <Button onClick={resetMyWordArt} disabled={saving} variant="outline" size="sm"><RotateCcw className="h-4 w-4" /> Reset to Default</Button>
          </div>
          <div className="border-t pt-4">
            <WordArtGalleryEmbed siteName={siteName} currentStyle={myStyle} onApply={setMyStyle} />
          </div>
        </div>
      )}

      {tab === "server-branding" && isAdmin && (
        <div className="space-y-5">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Site Name</span>
            <input value={siteName} onChange={(event) => setSiteName(event.target.value)} className="w-full max-w-lg rounded-md border bg-background px-3 py-2" />
          </label>
          <WordArtPickerInline siteName={siteName} style={serverStyle} setStyle={setServerStyle} />
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Accent Color</span>
            <div className="flex items-center gap-3">
              <input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} className="h-10 w-10 cursor-pointer rounded border" />
              <span className="font-mono text-sm text-muted-foreground">{accentColor}</span>
            </div>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["logo", "favicon"] as const).map((type) => (
              <div key={type} className="space-y-2 rounded-lg border p-4">
                <p className="text-sm font-medium capitalize">{type}</p>
                <div className="flex items-center gap-3">
                  {branding?.[`${type}_url` as keyof Branding] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={String(branding[`${type}_url` as keyof Branding])} alt={type} className="h-10 w-10 rounded border object-contain" />
                  )}
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
                    <Upload className="h-4 w-4" />
                    Upload
                    <input type="file" accept="image/*,.ico,.svg" className="hidden" onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadAsset(type, file);
                    }} />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <Button onClick={saveServerBranding} disabled={saving}><Save className="h-4 w-4" /> Save Server Branding</Button>
        </div>
      )}

      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </section>
  );
}

function ThemeSettings() {
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
      .catch(() => setStatus("Could not load themes."))
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
    setStatus(res.ok ? "Theme saved" : "Theme save failed");
  }

  async function selectMode(nextMode: string) {
    setMode(nextMode);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    });
    setStatus(res.ok ? "Mode saved" : "Mode save failed");
  }

  const modes = [
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "system", label: "System", icon: Monitor },
  ];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Color Theme</h3>
          <p className="text-sm text-muted-foreground">Choose a color palette for the interface.</p>
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
        <h3 className="text-base font-semibold">Mode</h3>
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

function AppDrawerSettings({ isAdmin }: { isAdmin: boolean }) {
  const [apps, setApps] = useState<DrawerApp[]>([]);
  const [editing, setEditing] = useState<DrawerApp | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(uiSettingsApi("apps/drawer"));
    if (!res.ok) {
      setStatus("Could not load apps.");
      return;
    }
    const data = await res.json();
    setApps((data.apps || []).sort((a: DrawerApp, b: DrawerApp) => a.name.localeCompare(b.name)));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patchApp(appId: string, body: Record<string, unknown>) {
    setSaving(true);
    const res = await fetch(uiSettingsApi(`apps/drawer/${encodeURIComponent(appId)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
    await load();
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-base font-semibold">App Drawer</h3>
        <p className="text-sm text-muted-foreground">Customize the apps shown in the universal header drawer.</p>
      </div>
      {apps.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No apps installed yet. Install apps from the marketplace to customize your drawer.</p>
      ) : (
        <div className="space-y-1.5">
          {apps.map((app) => (
            <div key={app.id} className={`flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 ${!app.visible ? "opacity-50" : ""}`}>
              <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-accent text-sm">
                {app.custom_icon_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={app.custom_icon_url} alt="" className="h-8 w-8 rounded-lg object-cover" />
                ) : app.icon?.startsWith("emoji:") ? <span>{app.icon.slice(6)}</span> : <span className="text-xs font-medium">{app.name[0]?.toUpperCase()}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{app.name}</p>
                <p className="text-xs text-muted-foreground">{app.status || "unknown"}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => patchApp(app.id, { visible: !app.visible })} title={app.visible ? "Hide from drawer" : "Show in drawer"}>
                {app.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(app)} title="Edit display name">
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="rounded-lg border p-4">
          <p className="mb-3 text-sm font-medium">Edit {editing.original_name || editing.name}</p>
          <div className="flex flex-wrap gap-2">
            <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} className="min-w-64 flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
            <Button disabled={saving} onClick={() => patchApp(editing.id, { customName: editing.name })}>Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            {isAdmin && <Button variant="outline" onClick={() => patchApp(editing.id, { customName: editing.name, setAsDefault: true })}>Set as server default</Button>}
          </div>
        </div>
      )}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </section>
  );
}

export function AppearanceClient({ isAdmin }: AppearanceClientProps) {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Appearance</h1>
        <p className="mt-1 text-sm text-muted-foreground">Make this server yours — wordmark, themes, and wallpaper</p>
      </div>
      <BrandingTabs isAdmin={isAdmin} />
      <ThemeSettings />
      <AppDrawerSettings isAdmin={isAdmin} />
    </div>
  );
}
