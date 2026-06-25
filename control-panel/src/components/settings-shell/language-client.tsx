"use client";

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { uiSettingsApi } from "./api-base";
import { Card } from "@/components/ui/card";

const LANGUAGES = [
  { code: "en", native: "English", english: "English" },
  { code: "ru", native: "Русский", english: "Russian" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "fr", native: "Français", english: "French" },
];

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
  const [language, setLanguage] = useState<string | null>(null);
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [showServerPicker, setShowServerPicker] = useState(false);

  useEffect(() => {
    fetch(uiSettingsApi("language"))
      .then((r) => r.json())
      .then((data) => setLanguage(data.language ?? null))
      .catch(() => setStatus("Could not load language."));
    if (isAdmin) {
      fetch("/api/setup/config")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setSystemLanguage(data?.language ?? "en"))
        .catch(() => {});
    }
  }, [isAdmin]);

  async function chooseUser(next: string | null) {
    setSaving(true);
    const res = await fetch(uiSettingsApi("language"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: next }),
    });
    if (res.ok) setLanguage(next);
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
  }

  async function chooseSystem(next: string) {
    setSaving(true);
    const res = await fetch("/api/setup/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: next }),
    });
    if (res.ok) {
      setSystemLanguage(next);
      setShowServerPicker(false);
      fetch("/api/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      }).catch(() => {});
    }
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
  }

  // Date/time formats are derived from the active locale (honest — they follow the
  // language; we do NOT store editable per-format overrides, which have no backend yet).
  const activeLocale = language || systemLanguage || "en";
  const formats = useMemo(() => {
    try {
      const sample = new Date(2026, 5, 12, 14, 5);
      const dateExample = new Intl.DateTimeFormat(activeLocale, { dateStyle: "long" }).format(sample);
      const hour12 = new Intl.DateTimeFormat(activeLocale, { hour: "numeric" }).resolvedOptions().hour12;
      return { dateExample, timeFormat: hour12 ? "12-hour" : "24-hour" };
    } catch {
      return { dateExample: "—", timeFormat: "—" };
    }
  }, [activeLocale]);

  const serverLangLabel = useMemo(() => {
    const match = LANGUAGES.find((l) => l.code === (systemLanguage || "en"));
    return match ? `${match.native}${match.native !== match.english ? ` (${match.english})` : ""}` : systemLanguage || "—";
  }, [systemLanguage]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Language</h1>
        <p className="mt-1 text-sm text-muted-foreground">Language and formats — yours, and the server default</p>
      </div>

      {/* Your language */}
      <Card className="gap-0 py-0">
        <div className="space-y-4 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">Your language</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Only affects your view.</p>
          </div>

          <div className="space-y-2.5">
            <LanguageOption active={language === null} disabled={saving} onClick={() => chooseUser(null)}>
              <span className="font-medium">System default</span>
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
            <p className="text-[13px] font-medium text-muted-foreground">Date &amp; time formats follow your language</p>
            <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted-foreground">
              <span>
                Dates: <span className="text-foreground">{formats.dateExample}</span>
              </span>
              <span>
                Time: <span className="text-foreground">{formats.timeFormat}</span>
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
              Server default
              <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Admin
              </span>
            </h2>

            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Default language</p>
                <p className="text-[13px] text-muted-foreground">
                  {serverLangLabel} — used on the login screen and for new people until they pick their own
                </p>
              </div>
              <button
                onClick={() => setShowServerPicker((v) => !v)}
                className="shrink-0 text-[13px] font-medium text-primary hover:underline"
              >
                {showServerPicker ? "Close" : "Change"}
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
