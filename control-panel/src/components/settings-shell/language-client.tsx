"use client";

import { PageHeader } from "./page-header";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { uiSettingsApi } from "./api-base";
import { useLocale, useTranslations } from "next-intl";
import { languages as LANGUAGES } from "@/i18n/config";
import { Card } from "@/components/ui/card";


function LanguageOption({
  active,
  disabled,
  children,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full cursor-pointer items-center justify-between rounded-lg border px-4 py-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
      }`}
    >
      {children}
      {active && <Check className="h-4 w-4 text-primary" />}
    </button>
  );
}

export function LanguageClient({ isAdmin }: { isAdmin: boolean }) {
  const translateInterface = useInterfaceTranslations("interface");

  const t = useTranslations("languageSettings");
  const locale = useLocale();
  const [language, setLanguage] = useState<string | null>(null);
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [showServerPicker, setShowServerPicker] = useState(false);

  useEffect(() => {
    fetch(uiSettingsApi("language"))
      .then((r) => r.json())
      .then((data) => {
        setLanguage(data.language ?? null);
        setSystemLanguage(data.systemLanguage ?? "en");
      })
      .catch(() => setStatus(t("loadFailed")));
    if (isAdmin) {
      fetch("/api/setup/config")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setSystemLanguage(data?.language ?? "en"))
        .catch(() => {});
    }
  }, [isAdmin, t]);

  function refreshLanguage() {
    // Signal other same-origin views. They re-read their own authenticated locale.
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel("youeye-language");
      channel.postMessage({ type: "changed" });
      channel.close();
    }
    window.location.reload();
  }

  async function chooseUser(next: string | null) {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(uiSettingsApi("language"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) throw new Error(translateInterface("m157dca92e425"));
      setLanguage(next);
      refreshLanguage();
    } catch { setStatus(t("saveFailed")); }
    finally { setSaving(false); }
  }

  async function chooseSystem(next: string) {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) throw new Error(translateInterface("m157dca92e425"));
      setSystemLanguage(next);
      setShowServerPicker(false);
      refreshLanguage();
    } catch { setStatus(t("saveFailed")); }
    finally { setSaving(false); }
  }

  // Date/time formats are derived from the active locale (honest — they follow the
  // language; we do NOT store editable per-format overrides, which have no backend yet).
  const activeLocale = language || systemLanguage || locale;
  const formats = useMemo(() => {
    try {
      const sample = new Date(2026, 5, 12, 14, 5);
      const dateExample = new Intl.DateTimeFormat(activeLocale, { dateStyle: "long" }).format(sample);
      const hour12 = new Intl.DateTimeFormat(activeLocale, { hour: "numeric" }).resolvedOptions().hour12;
      return { dateExample, timeFormat: hour12 ? t("hour12") : t("hour24") };
    } catch {
      return { dateExample: "—", timeFormat: "—" };
    }
  }, [activeLocale, t]);

  const serverLangLabel = useMemo(() => {
    const match = LANGUAGES.find((l) => l.code === (systemLanguage || "en"));
    return match ? `${match.native}${match.native !== match.english ? ` (${match.english})` : ""}` : systemLanguage || "—";
  }, [systemLanguage]);

  return (
    <div className="space-y-6">
      <PageHeader title={translateInterface("ma4fe65264ef7")} description={translateInterface("m7a29d43dbf1d")} />

      {/* Your language */}
      <Card className="gap-0 py-0">
        <div className="space-y-4 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">{t("personal")}</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{t("personalHint")}</p>
          </div>

          <div className="space-y-2.5">
            <LanguageOption active={language === null} disabled={saving} onClick={() => chooseUser(null)}>
              <span className="font-medium">{t("systemDefault")}</span>
            </LanguageOption>
            {LANGUAGES.map((item) => (
              <LanguageOption
                key={item.code}
                active={language === item.code}
                disabled={saving}
                onClick={() => chooseUser(item.code)}
              >
                <span className="flex items-center gap-3">
                  <span className="font-medium">{item.native}</span>
                  {item.native !== item.english && <span className="text-muted-foreground">({item.english})</span>}
                </span>
              </LanguageOption>
            ))}
          </div>

          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-[13px] font-medium text-muted-foreground">{t("formatsHint")}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted-foreground">
              <span>
                {t("dates")} <span className="text-foreground">{formats.dateExample}</span>
              </span>
              <span>
                {t("time")} <span className="text-foreground">{formats.timeFormat}</span>
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* Server default (admin) */}
      {isAdmin && (
        <Card className="gap-0 py-0">
          <div className="space-y-3 p-5">
            <h2 className="flex items-center text-[15px] font-semibold">
              {t("serverDefault")}
              <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {translateInterface("mc1c224b03cd9")}</span>
            </h2>

            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("defaultLanguage")}</p>
                <p className="text-[13px] text-muted-foreground">
                  {t("defaultHint", { language: serverLangLabel })}
                </p>
              </div>
              <button
                onClick={() => setShowServerPicker((v) => !v)}
                className="shrink-0 text-[13px] font-medium text-primary hover:underline"
              >
                {showServerPicker ? t("close") : t("change")}
              </button>
            </div>

            {showServerPicker && (
              <div className="space-y-2.5">
                {LANGUAGES.map((item) => (
                  <LanguageOption
                    key={item.code}
                    active={systemLanguage === item.code}
                    disabled={saving}
                    onClick={() => chooseSystem(item.code)}
                  >
                    <span className="flex items-center gap-3">
                      <span className="font-medium">{item.native}</span>
                      {item.native !== item.english && <span className="text-muted-foreground">({item.english})</span>}
                    </span>
                  </LanguageOption>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
