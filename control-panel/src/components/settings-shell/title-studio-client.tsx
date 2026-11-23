"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TitleStudio, initialDesign } from "@youeye/branding/studio";
import { notifyAppearanceSaved } from "@youeye/branding/appearance-events";
import { PageHeader } from "./page-header";
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

interface Branding {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  accent_color?: string | null;
  logo_url?: string | null;
  favicon_url?: string | null;
}

/**
 * The title studio on its own page. "personal" edits the title only you see (/settings/appearance/title); "server"
 * edits the server's name and title for everyone (/settings/general/title, admins). The shell gives the way back.
 */
export function TitleStudioClient({ mode }: { mode: "personal" | "server" }) {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.title");

  const [branding, setBranding] = useState<Branding | null>(null);
  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [siteName, setSiteName] = useState("YouEye");
  const [hasPersonalTitle, setHasPersonalTitle] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const brandingRes = await fetch("/api/ui/branding", { cache: "no-store" });
    if (!brandingRes.ok) throw new Error(translateInterface("m73e43c9933f5"));
    const nextBranding: Branding | null = await brandingRes.json();
    if (!nextBranding) throw new Error(translateInterface("m73e43c9933f5"));
    const serverStyle = nextBranding.site_name_style || DEFAULT_STYLE;
    if (mode === "personal") {
      const wordartRes = await fetch(uiSettingsApi("wordart"), { cache: "no-store" });
      if (!wordartRes.ok) throw new Error(translateInterface("m73e43c9933f5"));
      const wordart = await wordartRes.json();
      setStyle(wordart?.wordart || serverStyle);
      setHasPersonalTitle(wordart?.wordart != null);
    } else {
      setStyle(serverStyle);
    }
    setBranding(nextBranding);
    setSiteName(nextBranding.site_name || "YouEye");
    setReady(true);
  }, [mode, translateInterface]);

  const loadOrReport = useCallback(() => {
    setFailed(false);
    setStatus("");
    load().catch(() => { setFailed(true); setStatus(translateInterface("mfbc0355a01b6")); });
  }, [load, translateInterface]);

  useEffect(() => { loadOrReport(); }, [loadOrReport]);

  async function savePersonal() {
    if (!ready || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("wordart"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wordart: { ...style, mytitle: style.mytitle || initialDesign(branding?.site_name || "YouEye") } }),
      });
      if (res.ok) {
        const saved = await res.json();
        setStyle(saved.wordart);
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

  async function followServerTitle() {
    if (saving) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("wordart"), { method: "DELETE" });
      if (res.ok) {
        // Read the saved server appearance, never an unsaved draft.
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

  async function saveServer() {
    if (!ready || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/ui/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: siteName,
          site_name_style: { ...style, mytitle: style.mytitle || initialDesign(siteName) },
          expected_revision: branding?.site_name_style?.mytitleRevision ?? null,
          accent_color: branding?.accent_color || "#8B5CF6",
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

  const header = mode === "personal"
    ? <PageHeader title={t("personalTitle")} description={hasPersonalTitle ? t("personalOwn") : t("personalFollowing")} />
    : <PageHeader title={t("serverTitle")} description={t("serverDescription")} />;

  if (!ready) {
    return (
      <div>
        {header}
        <div className="space-y-3" aria-busy={!failed}>
          {failed ? <p role="alert">{status}</p> : <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{translateInterface("m4d6ed05cad3d")}</p>}
          {failed && <Button variant="outline" onClick={loadOrReport}>{translateInterface("md8b8392e2c54")}</Button>}
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {mode === "personal" ? (
          <TitleStudio
            subject="you"
            design={style.mytitle || initialDesign(branding?.site_name || "YouEye")}
            onChange={(mytitle) => setStyle((current) => ({ ...current, mytitle }))}
          />
        ) : (
          <>
            <TitleStudio
              subject="server"
              design={style.mytitle || initialDesign(siteName)}
              onChange={(design) => {
                setSiteName(design.name);
                setStyle((current) => ({ ...current, mytitle: design }));
              }}
            />
            <div className="settings-group max-w-[46rem]">
              <label className="settings-item">
                <span className="settings-item-text">
                  <span className="settings-item-label">{translateInterface("ma607f90a3d24")}</span>
                  <span className="settings-item-hint">{translateInterface("m3a165ba8b440")}</span>
                </span>
                <Switch checked={style.showHeaderLogo === true} onCheckedChange={(showHeaderLogo) => setStyle((current) => ({ ...current, showHeaderLogo }))} />
              </label>
            </div>
          </>
        )}

        <div className="studio-save-bar flex-wrap">
          <Button onClick={mode === "personal" ? savePersonal : saveServer} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            {mode === "personal" ? t("savePersonal") : t("saveServer")}
          </Button>
          {mode === "personal" && hasPersonalTitle && (
            <Button onClick={followServerTitle} disabled={saving} variant="outline">
              <RotateCcw className="size-4" aria-hidden="true" />{t("useServerTitle")}
            </Button>
          )}
          <span role="status" className="min-w-0 text-sm text-muted-foreground">{status}</span>
        </div>
      </div>
    </div>
  );
}
