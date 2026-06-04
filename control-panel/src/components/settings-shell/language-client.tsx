"use client";

import { useEffect, useState } from "react";
import { uiSettingsApi } from "./api-base";

const LANGUAGES = [
  { code: null, label: "System default" },
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

export function LanguageClient() {
  const [language, setLanguage] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetch(uiSettingsApi("language"))
      .then((r) => r.json())
      .then((data) => setLanguage(data.language ?? null))
      .catch(() => setStatus("Could not load language."));
  }, []);

  async function choose(next: string | null) {
    setLanguage(next);
    const res = await fetch(uiSettingsApi("language"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: next }),
    });
    setStatus(res.ok ? "Saved" : "Save failed");
  }

  return (
    <div className="max-w-lg space-y-3">
      {LANGUAGES.map((item) => (
        <button
          key={item.code ?? "system"}
          onClick={() => choose(item.code)}
          className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-sm ${language === item.code ? "border-primary bg-primary/5" : "hover:bg-accent/50"}`}
        >
          <span>{item.label}</span>
          {language === item.code && <span className="font-semibold text-primary">Selected</span>}
        </button>
      ))}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
