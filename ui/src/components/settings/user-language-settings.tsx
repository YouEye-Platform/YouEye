"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

const LANGUAGES = [
  { code: "en", native: "English", english: "English" },
  { code: "ru", native: "Русский", english: "Russian" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "fr", native: "Français", english: "French" },
];

interface UserLanguageSettingsProps {
  currentLanguage: string | null;
}

export function UserLanguageSettings({ currentLanguage }: UserLanguageSettingsProps) {
  const t = useTranslations("settings.language");
  const router = useRouter();
  const [userLang, setUserLang] = useState(currentLanguage);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const handleChange = async (code: string | null) => {
    setSaving(true);
    setStatus("idle");
    try {
      const res = await fetch("/api/v1/user/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      if (res.ok) {
        setUserLang(code);
        setStatus("saved");
        router.refresh();
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div>
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      <div className="space-y-3 max-w-lg mt-6">
        <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {t("userLanguage")}
        </label>

        <button
          onClick={() => handleChange(null)}
          disabled={saving}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
            userLang === null
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border hover:border-border/80 text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>{t("systemDefault")}</span>
          {userLang === null && <span className="text-primary font-semibold">✓</span>}
        </button>

        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => handleChange(lang.code)}
            disabled={saving}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
              userLang === lang.code
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border hover:border-border/80 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="font-medium">{lang.native}</span>
              {lang.native !== lang.english && (
                <span className="text-muted-foreground">({lang.english})</span>
              )}
            </div>
            {userLang === lang.code && <span className="text-primary font-semibold">✓</span>}
          </button>
        ))}

        {status === "saved" && (
          <p className="text-sm text-green-600">{t("saved")}</p>
        )}
        {status === "error" && (
          <p className="text-sm text-destructive">{t("error")}</p>
        )}
      </div>
    </div>
  );
}
