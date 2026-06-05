"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { uiSettingsApi } from "./api-base";

const LANGUAGES = [
  { code: "en", native: "English", english: "English" },
  { code: "ru", native: "Русский", english: "Russian" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "fr", native: "Français", english: "French" },
];

function tabClass(active: boolean) {
  return `border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground"
  }`;
}

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
      className={`flex w-full cursor-pointer items-center justify-between rounded-lg border px-4 py-3 text-sm transition-colors ${
        active
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
      }`}
    >
      {children}
      {active && <Check className="h-4 w-4 text-primary" />}
    </button>
  );
}

export function LanguageClient({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<"my-language" | "system-language">("my-language");
  const [language, setLanguage] = useState<string | null>(null);
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch(uiSettingsApi("language"))
      .then((r) => r.json())
      .then((data) => setLanguage(data.language ?? null))
      .catch(() => setStatus("Could not load language."));
    if (isAdmin) {
      fetch("/api/setup/config")
        .then((r) => r.ok ? r.json() : null)
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
    if (res.ok) setSystemLanguage(next);
    if (res.ok) {
      fetch("/api/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      }).catch(() => {});
    }
    setStatus(res.ok ? "Saved" : "Save failed");
    setSaving(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b">
        <button onClick={() => setTab("my-language")} className={tabClass(tab === "my-language")}>My Language</button>
        {isAdmin && <button onClick={() => setTab("system-language")} className={tabClass(tab === "system-language")}>System Language</button>}
      </div>

      {tab === "my-language" && (
        <div>
          <div>
            <h2 className="text-xl font-semibold">Language</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose your preferred language.</p>
          </div>
          <div className="mt-6 max-w-lg space-y-3">
            <label className="text-sm font-medium text-muted-foreground">User language</label>
            <LanguageOption active={language === null} disabled={saving} onClick={() => chooseUser(null)}>System default</LanguageOption>
            {LANGUAGES.map((item) => (
              <LanguageOption key={item.code} active={language === item.code} disabled={saving} onClick={() => chooseUser(item.code)}>
                <div className="flex items-center gap-3">
                  <span className="font-medium">{item.native}</span>
                  {item.native !== item.english && <span className="text-muted-foreground">({item.english})</span>}
                </div>
              </LanguageOption>
            ))}
          </div>
        </div>
      )}

      {tab === "system-language" && isAdmin && (
        <div>
          <div>
            <h2 className="text-xl font-semibold">System Language</h2>
            <p className="mt-1 text-sm text-muted-foreground">Set the default language for the instance.</p>
          </div>
          <div className="mt-6 max-w-lg space-y-3">
            {LANGUAGES.map((item) => (
              <LanguageOption key={item.code} active={systemLanguage === item.code} disabled={saving} onClick={() => chooseSystem(item.code)}>
                <div className="flex items-center gap-3">
                  <span className="font-medium">{item.native}</span>
                  {item.native !== item.english && <span className="text-muted-foreground">({item.english})</span>}
                </div>
              </LanguageOption>
            ))}
          </div>
        </div>
      )}

      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
