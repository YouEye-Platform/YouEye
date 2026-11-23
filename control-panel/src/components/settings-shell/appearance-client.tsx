"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Monitor, Moon, Sun } from "lucide-react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { Button } from "@/components/ui/button";
import { applyThemeMode, broadcastThemeMode, type ThemeMode } from "@/lib/theme";
import { resolveTitle } from "@youeye/branding/appearance";
import { notifyAppearanceSaved } from "@youeye/branding/appearance-events";
import { PageHeader } from "./page-header";
import { TitlePreview } from "./title-preview";
import { uiSettingsApi } from "./api-base";

interface Theme {
  id: string;
  name: string;
  colors?: Record<string, string>;
  isPreset?: boolean;
}

function swatchColors(theme: Theme) {
  return Object.values(theme.colors || {}).slice(0, 4);
}

/** Light or dark, then the colour theme: the everyday choices, first on the page. Both save as you choose. */
function ModeAndTheme() {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.appearance");

  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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
        setMode(active.mode || "system");
      })
      .catch(() => setStatus(translateInterface("mda137f32b86e")))
      .finally(() => setLoading(false));
  }, [translateInterface]);

  async function selectTheme(themeId: string) {
    if (themeId === activeId) return;
    setActiveId(themeId);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId }),
    }).catch(() => null);
    setStatus(res?.ok ? translateInterface("mf172e79132fc") : translateInterface("m6530c2cf3950"));
  }

  async function selectMode(nextMode: string) {
    if (nextMode === mode) return;
    setMode(nextMode);
    // Apply at once so this page re-themes on click, and tell the header so it stays in sync; the PUT persists it.
    applyThemeMode(nextMode as ThemeMode);
    broadcastThemeMode(nextMode as ThemeMode);
    const res = await fetch(uiSettingsApi("themes/active"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    }).catch(() => null);
    setStatus(res?.ok ? translateInterface("ma263d21422c0") : translateInterface("m8eaeda81ecca"));
  }

  const modes = [
    { id: "light", label: translateInterface("mdbcd5e7bb7a0"), icon: Sun },
    { id: "dark", label: translateInterface("m60acc53f13a5"), icon: Moon },
    { id: "system", label: translateInterface("m6725e7bbcd28"), icon: Monitor },
  ];

  return (
    <>
      <section className="settings-section" aria-labelledby="appearance-mode">
        <h2 id="appearance-mode" className="settings-section-title">{t("mode")}</h2>
        <div role="radiogroup" aria-labelledby="appearance-mode" className="settings-segments sm:max-w-md">
          {modes.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={mode === item.id} onClick={() => void selectMode(item.id)} className="settings-segment">
              <item.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
        {mode === "system" && <p className="settings-section-hint">{t("modeSystemHint")}</p>}
      </section>

      <section className="settings-section" aria-labelledby="appearance-theme">
        <h2 id="appearance-theme" className="settings-section-title">{t("theme")}</h2>
        <p className="settings-section-hint">{t("themeHint")}</p>
        {loading ? (
          <div className="settings-group flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" /></div>
        ) : themes.length > 0 ? (
          <div className="settings-group"><div role="radiogroup" aria-labelledby="appearance-theme" className="settings-swatches">
            {themes.map((theme) => {
              const colors = swatchColors(theme);
              const active = activeId === theme.id;
              return (
                <button key={theme.id} type="button" role="radio" aria-checked={active} title={theme.name} onClick={() => void selectTheme(theme.id)} className="settings-swatch">
                  <span className="settings-swatch-dot" aria-hidden="true">
                    {(colors.length > 0 ? colors : ["var(--muted)"]).map((color, index) => <span key={index} style={{ backgroundColor: color }} />)}
                    {active && <span className="absolute inset-0 grid place-items-center bg-black/25 text-white"><Check className="size-4" strokeWidth={3} /></span>}
                  </span>
                  <span className="settings-swatch-name">{theme.name}</span>
                </button>
              );
            })}
          </div></div>
        ) : null}
        <p role="status" className="settings-note empty:hidden">{status}</p>
      </section>
    </>
  );
}

interface Branding {
  site_name: string;
  site_name_style: SiteNameStyle | null;
}

/** The title you see in the header: a preview, and the studio one step away on its own page. */
function YourTitle() {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.appearance");

  const [title, setTitle] = useState<{ name: string; style: SiteNameStyle | null; own: boolean } | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [brandingRes, wordartRes] = await Promise.all([
      fetch("/api/ui/branding", { cache: "no-store" }),
      fetch(uiSettingsApi("wordart"), { cache: "no-store" }),
    ]);
    if (!brandingRes.ok || !wordartRes.ok) throw new Error("load");
    const branding: Branding = await brandingRes.json();
    const personal: SiteNameStyle | null = (await wordartRes.json())?.wordart ?? null;
    const shared = { site_name: branding?.site_name || "YouEye", site_name_style: branding?.site_name_style ?? null };
    const resolved = resolveTitle<SiteNameStyle, SiteNameStyle>(shared, personal);
    setTitle({ name: resolved.name, style: resolved.style, own: personal != null });
  }, []);

  const loadOrReport = useCallback(() => {
    setFailed(false);
    setStatus("");
    load().catch(() => { setFailed(true); setStatus(translateInterface("mfbc0355a01b6")); });
  }, [load, translateInterface]);

  useEffect(() => { loadOrReport(); }, [loadOrReport]);

  async function followServerTitle() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("wordart"), { method: "DELETE" });
      if (res.ok) {
        notifyAppearanceSaved();
        await load();
      }
      setStatus(res.ok ? translateInterface("mdaee7606b339") : translateInterface("m089cb45b70a0"));
    } catch {
      setStatus(translateInterface("mee741ad8f51f"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="settings-section-title">{t("yourTitle")}</h2>
      <div className="settings-group">
        {title ? (
          <TitlePreview name={title.name} style={title.style} />
        ) : (
          <div className="settings-title-preview" aria-busy={!failed}>
            {failed
              ? <Button variant="outline" size="sm" onClick={loadOrReport}>{translateInterface("md8b8392e2c54")}</Button>
              : <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>
        )}
        <div className="settings-item">
          <span className="settings-item-text">
            <span className="settings-item-label">{title?.own ? t("titleOwn") : t("titleServer")}</span>
            <span className="settings-item-hint">{t("titleHint")}</span>
          </span>
          <span className="settings-item-actions">
            {title?.own && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void followServerTitle()}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {t("useServerTitle")}
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/appearance/title">{t("customise")}</Link>
            </Button>
          </span>
        </div>
      </div>
      <p role="status" className="settings-note empty:hidden">{status}</p>
    </section>
  );
}

export function AppearanceClient() {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.appearance");

  return (
    <div>
      <PageHeader title={translateInterface("m3907fa7f8072")} description={t("description")} />
      <div className="settings-sections">
        <ModeAndTheme />
        <YourTitle />
      </div>
    </div>
  );
}
