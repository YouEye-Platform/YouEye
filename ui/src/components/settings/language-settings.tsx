/**
 * Language Settings Component
 *
 * User section: personal language override (saved to userSettings JSONB).
 * Admin section: system-wide default language (saved to youeye.yaml via bridge).
 */

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Globe, Check } from "lucide-react";

const LANGUAGES = [
  { code: "en", native: "English", english: "English" },
  { code: "ru", native: "Русский", english: "Russian" },
  { code: "es", native: "Español", english: "Spanish" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "fr", native: "Français", english: "French" },
];

interface LanguageSettingsProps {
  isAdmin: boolean;
  currentUserLanguage: string | null;
  currentSystemLanguage: string | null;
}

export function LanguageSettings({
  isAdmin,
  currentUserLanguage,
  currentSystemLanguage,
}: LanguageSettingsProps) {
  const t = useTranslations("settings.language");
  const router = useRouter();
  const [userLang, setUserLang] = useState(currentUserLanguage);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const [systemLang, setSystemLang] = useState<string | null>(currentSystemLanguage);
  const [systemSaving, setSystemSaving] = useState(false);
  const [systemStatus, setSystemStatus] = useState<"idle" | "saved" | "error">("idle");

  // Save user language preference
  const handleUserLanguageChange = async (code: string | null) => {
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
        // Refresh to apply the new locale
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

  // Save system language (admin only) — triggers full propagation
  const handleSystemLanguageChange = async (code: string) => {
    setSystemSaving(true);
    setSystemStatus("idle");

    try {
      // First update via existing config endpoint
      const configRes = await fetch("/api/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });

      if (!configRes.ok) {
        setSystemStatus("error");
        return;
      }

      setSystemLang(code);
      setSystemStatus("saved");

      // Trigger full language propagation (Authentik + apps) via bridge
      // This is non-blocking — apps update in the background
      fetch("/api/admin/user/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: code }),
      }).catch(() => {
        // Propagation failure is non-fatal — system language is already updated
      });

      router.refresh();
    } catch {
      setSystemStatus("error");
    } finally {
      setSystemSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* User Language */}
      <div>
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      <div className="space-y-3 max-w-lg">
        <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Globe className="w-4 h-4" />
          {t("userLanguage")}
        </label>

        {/* System default option */}
        <button
          onClick={() => handleUserLanguageChange(null)}
          disabled={saving}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
            userLang === null
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border hover:border-border/80 text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>{t("systemDefault")}</span>
          {userLang === null && <Check className="w-4 h-4 text-primary" />}
        </button>

        {/* Language options */}
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => handleUserLanguageChange(lang.code)}
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
            {userLang === lang.code && <Check className="w-4 h-4 text-primary" />}
          </button>
        ))}

        {status === "saved" && (
          <p className="text-sm text-green-600">{t("saved")}</p>
        )}
        {status === "error" && (
          <p className="text-sm text-destructive">{t("error")}</p>
        )}
      </div>

      {/* Admin: System Language */}
      {isAdmin && (
        <>
          <div className="border-t pt-8">
            <h3 className="text-lg font-semibold">{t("systemLanguage")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {t("systemLanguageDescription")}
            </p>
          </div>

          <div className="space-y-3 max-w-lg">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleSystemLanguageChange(lang.code)}
                disabled={systemSaving}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
                  systemLang === lang.code
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
                {systemLang === lang.code && <Check className="w-4 h-4 text-primary" />}
              </button>
            ))}

            {systemStatus === "saved" && (
              <p className="text-sm text-green-600">{t("saved")}</p>
            )}
            {systemStatus === "error" && (
              <p className="text-sm text-destructive">{t("error")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
