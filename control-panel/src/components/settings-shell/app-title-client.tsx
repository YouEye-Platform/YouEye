"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import WordArtPickerInline from "@/components/setup/WordArtPickerInline";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { uiSettingsApi } from "./api-base";
import { PageHeader } from "./page-header";

const DEFAULT_APP_WORDART: SiteNameStyle = {
  fontFamily: "Montserrat",
  fontSize: "1.5rem",
  fontWeight: 800,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

/**
 * The title studio for one app, on its own page (it used to fill the app's Branding tab). `user` draws your title
 * for the app, `server` the default everyone sees until they draw their own (admins).
 */
export function AppTitleStudio({ appId, scope }: { appId: string; scope: "user" | "server" }) {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsApps");

  const [style, setStyle] = useState<SiteNameStyle>(DEFAULT_APP_WORDART);
  const [appName, setAppName] = useState("");
  const [nameChanged, setNameChanged] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const isUser = scope === "user";
  const endpoint = uiSettingsApi(`apps/branding/${scope}/${encodeURIComponent(appId)}`);
  const back = `/settings/apps/${encodeURIComponent(appId)}#${isUser ? "name-and-icon" : "default-look"}`;

  const load = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) { setState("missing"); return; }
    const data = await res.json();
    setStyle(data.brandingWordart ?? DEFAULT_APP_WORDART);
    setAppName(data.customName ?? data.originalName ?? appId);
    setNameChanged(false);
    setState("ready");
  }, [appId, endpoint]);

  useEffect(() => { load().catch(() => setState("missing")); }, [load]);

  // The studio's name field is your name for the app, as before; the app's other choices are left alone.
  async function save() {
    setSaving(true);
    const payload: Record<string, unknown> = { brandingWordart: style };
    if (isUser && nameChanged && style.mytitle) payload.customName = style.mytitle.name.trim() || null;
    const res = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setStatus(res?.ok ? translateInterface("mb5c120b316c2") : translateInterface("m53ad6f999b1f"));
    setSaving(false);
  }

  const backLink = (
    <Link href={back} className="inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11">
      {t("title.back", { app: appName || appId })}
    </Link>
  );

  if (state === "loading") return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (state === "missing") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Button variant="outline" asChild><Link href="/settings/apps">{t("backToApps")}</Link></Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={isUser ? t("title.heading", { app: appName }) : t("title.defaultHeading", { app: appName })}
        description={isUser ? t("title.description") : t("title.defaultDescription")}
      />
      <WordArtPickerInline
        subject="app"
        siteName={appName}
        style={style}
        setStyle={(next) => {
          if (next.mytitle && next.mytitle.name !== (style.mytitle?.name ?? appName)) setNameChanged(true);
          setStyle(next);
        }}
      />
      <div className="studio-save-bar flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{translateInterface("m1509f561f241")}</Button>
        {backLink}
        {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}
