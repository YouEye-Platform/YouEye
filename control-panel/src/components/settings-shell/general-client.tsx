"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Download, Loader2, RotateCcw } from "lucide-react";
import type { SiteNameStyle } from "@/lib/wordart-presets";
import { languages as LANGUAGES } from "@/i18n/config";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/settings-shell/page-header";
import { TitlePreview } from "@/components/settings-shell/title-preview";

// CP admin write pattern — CSRF token from the CP-guaranteed proxy.
async function csrfHeaders(): Promise<HeadersInit> {
  const r = await fetch("/settings/api/auth/csrf");
  const b = await r.json().catch(() => ({}));
  return { "Content-Type": "application/json", "X-CSRF-Token": b.csrfToken ?? "" };
}

interface SystemInfo {
  hostname: string;
  os: string;
  uptime: string;
  primary_ip: string;
}
interface TlsStatus {
  mode: string;
  hasExternalCert: boolean;
}

const joinDot = (parts: Array<string | false | undefined | null>) => parts.filter(Boolean).join(" · ");

/** `release`: the installed release's version and its details line (`<version> · <short git tree>`). */
export function GeneralClient({ release }: { release?: { version: string; details: string } }) {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.general");

  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [siteName, setSiteName] = useState("");
  const [branding, setBranding] = useState<{ site_name: string; site_name_style: SiteNameStyle | null } | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [caddyRunning, setCaddyRunning] = useState(true);
  const [tls, setTls] = useState<TlsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // All admin-gated reads. `/api/settings*` only resolves to CP under the
    // `/settings/api/*` prefix from the root-domain Settings surface; domain/tls/
    // health reach CP directly. Each piece degrades to an honest placeholder on
    // failure (never a fabricated value), and logs — see pitfalls #23 / #28.
    const [settingsR, sysR, domainR, tlsR, brandingR] = await Promise.allSettled([
      fetch("/settings/api/settings"),
      fetch("/settings/api/settings/system"),
      fetch("/api/domain"),
      fetch("/api/tls/status"),
      fetch("/api/ui/branding", { cache: "no-store" }),
    ]);

    if (brandingR.status === "fulfilled" && brandingR.value.ok) {
      const b = await brandingR.value.json().catch(() => null);
      if (b?.site_name) setBranding({ site_name: b.site_name, site_name_style: b.site_name_style ?? null });
    } else {
      console.error("[General] branding load failed", brandingR);
    }

    if (settingsR.status === "fulfilled" && settingsR.value.ok) {
      const s = await settingsR.value.json().catch(() => null);
      if (s?.siteName) setSiteName(s.siteName);
    } else {
      console.error("[General] settings load failed", settingsR);
    }

    if (sysR.status === "fulfilled" && sysR.value.ok) {
      setSys(await sysR.value.json().catch(() => null));
    } else {
      console.error("[General] system info load failed", sysR);
    }

    if (domainR.status === "fulfilled" && domainR.value.ok) {
      const d = await domainR.value.json().catch(() => null);
      setDomain(d?.domain ?? null);
      setCaddyRunning(d?.caddyRunning ?? false);
    } else {
      console.error("[General] domain load failed", domainR);
    }

    if (tlsR.status === "fulfilled" && tlsR.value.ok) {
      setTls(await tlsR.value.json().catch(() => null));
    } else {
      console.error("[General] tls load failed", tlsR);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  let reach: string;
  if (!caddyRunning) reach = translateInterface("m44f6ecc7f607");
  else if (!domain) reach = translateInterface("m638d8490ddb8");
  else if (!tls) reach = translateInterface("mc94c04650f15");
  else if (tls.hasExternalCert && tls.mode !== "internal") reach = translateInterface("m15df04d604c1");
  else reach = translateInterface("m01571f8c68af");

  const name = branding?.site_name || siteName || t("unnamed");
  const ip = sys?.primary_ip && sys.primary_ip !== "unknown" ? sys.primary_ip : "";
  const machine = sys ? joinDot([sys.hostname, sys.os]) : "";

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      {loading ? (
        <div className="flex justify-center py-16" role="status" aria-busy="true">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : (
        <div className="settings-sections">
          <section className="settings-section" aria-labelledby="general-server">
            <h2 id="general-server" className="settings-section-title">{translateInterface("m524e9b6937a1")}</h2>
            <dl className="settings-group">
              <Fact label={t("name")} hint={machine}>{name}</Fact>
              <Fact label={t("address")} hint={reach}>{domain || translateInterface("meeac8dc98811")}</Fact>
              <Fact label={translateInterface("m0302a467885a")} action={ip ? <CopyButton value={ip} /> : undefined}>{ip || t("unavailable")}</Fact>
              <Fact
                label={t("version")}
                hint={release?.details}
                action={<Link href="/settings/system" className="settings-link">{t("updates")}</Link>}
              >
                {release?.version || "—"}
              </Fact>
              <Fact label={translateInterface("md63ab4711473")}>{sys?.uptime || t("unavailable")}</Fact>
            </dl>
          </section>

          <section className="settings-section" aria-labelledby="general-title">
            <h2 id="general-title" className="settings-section-title">{t("serverTitle")}</h2>
            <div className="settings-group">
              <TitlePreview name={name} style={branding?.site_name_style ?? null} withIcon />
              <div className="settings-item">
                <span className="settings-item-text">
                  <span className="settings-item-hint">{t("serverTitleHint")}</span>
                </span>
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings/general/title">{t("customise")}</Link>
                </Button>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="general-preferences">
            <h2 id="general-preferences" className="settings-section-title">{t("forEveryone")}</h2>
            <div className="settings-group">
              <DefaultLanguage />
              <UsageStatistics />
            </div>
          </section>

          <ul className="settings-group">
            <li>
              <Link href="/settings/general/licenses" className="settings-row">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{translateInterface("m1a1b83db3be8")}</span>
                  <span className="block text-[13px] text-muted-foreground">{t("licensesHint")}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** One fact about the server: what it is, its value, and at most one thing to do with it. */
function Fact({ label, hint, action, children }: { label: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="settings-item">
      <dt className="settings-item-text">
        <span className="settings-item-label">{label}</span>
        {hint && <span className="settings-item-hint">{hint}</span>}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span className="min-w-0 text-end text-sm tabular-nums text-foreground [overflow-wrap:anywhere]">{children}</span>
        {action}
      </dd>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const translateInterface = useTranslations("interface");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="settings-link"
      onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }).catch(() => {})}
    >
      <span aria-live="polite">{copied ? translateInterface("m8d525e5f158b") : translateInterface("me21f935f11d7")}</span>
    </button>
  );
}

/** The language of the sign-in screen, and of everyone who has not chosen their own (moved here from Language). */
function DefaultLanguage() {
  const languageSettings = useTranslations("languageSettings");
  const t = useTranslations("settingsYou.general");
  const [language, setLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/api/setup/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setLanguage(data?.language ?? "en"))
      .catch(() => setLanguage("en"));
  }, []);

  async function choose(next: string) {
    if (saving || next === language) return;
    setSaving(true);
    setNote("");
    try {
      const res = await fetch("/api/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) throw new Error("save");
      setLanguage(next);
      // Signal other same-origin views. They re-read their own authenticated locale.
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("youeye-language");
        channel.postMessage({ type: "changed" });
        channel.close();
      }
      window.location.reload();
    } catch {
      setNote(languageSettings("saveFailed"));
      setSaving(false);
    }
  }

  return (
    <div className="settings-item">
      <label htmlFor="settings-default-language" className="settings-item-text">
        <span className="settings-item-label">{languageSettings("defaultLanguage")}</span>
        <span className="settings-item-hint">{t("defaultLanguageHint")}</span>
        {note && <span className="settings-item-hint text-destructive" role="alert">{note}</span>}
      </label>
      <div className="w-full min-w-0 sm:w-56">
        <select
          id="settings-default-language"
          className="settings-select"
          value={language ?? ""}
          disabled={language === null || saving}
          onChange={(event) => void choose(event.target.value)}
        >
          {language === null && <option value="">{t("loading")}</option>}
          {LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>
              {item.native}{item.native !== item.english ? ` (${item.english})` : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Local usage statistics (moved here from Privacy): they stay on this server unless an admin exports them. */
function UsageStatistics() {
  const translateInterface = useTranslations("interface");
  const t = useTranslations("settingsYou.general");

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/settings/api/telemetry/settings");
      if (r.ok) {
        const d = await r.json().catch(() => null);
        setEnabled(!!d?.enabled);
      } else {
        console.error("[General] telemetry settings failed", r.status);
        setNote(translateInterface("meeb789252476"));
      }
    } catch (e) {
      console.error("[General] telemetry settings error", e);
      setNote(translateInterface("meeb789252476"));
    }
  }, [translateInterface]);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(v: boolean) {
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/settings/api/telemetry/settings", {
        method: "PATCH",
        headers: await csrfHeaders(),
        body: JSON.stringify({ enabled: v }),
      });
      if (r.ok) setEnabled(v);
      else {
        console.error("[General] telemetry PATCH failed", r.status);
        setNote(translateInterface("m8ea70d8144ca"));
      }
    } catch (e) {
      console.error("[General] telemetry PATCH error", e);
      setNote(translateInterface("m8ea70d8144ca"));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    window.location.href = "/settings/api/telemetry/export";
  }

  async function reset() {
    if (!confirm(translateInterface("mf5d2da5295f5"))) return;
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/settings/api/telemetry/export", { method: "DELETE", headers: await csrfHeaders() });
      if (r.ok) setNote(translateInterface("m53977ab6afbd"));
      else {
        console.error("[General] telemetry reset failed", r.status);
        setNote(translateInterface("mf2beb37f601a"));
      }
    } catch (e) {
      console.error("[General] telemetry reset error", e);
      setNote(translateInterface("mf2beb37f601a"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="settings-item">
        <span className="settings-item-text">
          <span className="settings-item-label">{translateInterface("m929b7eeb9c21")}</span>
          <span className="settings-item-hint">{t("statisticsHint")}</span>
        </span>
        {enabled === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Switch checked={enabled} disabled={busy} onCheckedChange={toggle} aria-label={translateInterface("m929b7eeb9c21")} />
        )}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pb-3">
        <Button size="sm" variant="outline" onClick={download}>
          <Download className="size-3.5" aria-hidden="true" />{translateInterface("m6c68ad180780")}
        </Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={reset}>
          <RotateCcw className="size-3.5" aria-hidden="true" />{t("resetStatistics")}
        </Button>
        {note && <span className="min-w-0 text-[13px] text-muted-foreground" role="status">{note}</span>}
      </div>
    </div>
  );
}
