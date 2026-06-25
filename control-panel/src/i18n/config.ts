/**
 * i18n Configuration
 *
 * Defines supported locales and the default locale for the Control Panel.
 * The active locale is resolved server-side from youeye.yaml (system language).
 * CP does not support per-user language override — it follows system language only.
 */

export const locales = ["en", "ru", "es", "de", "fr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Display names for the language selector (native name + English) */
export const localeNames: Record<Locale, string> = {
  en: "English",
  ru: "Russian — Русский",
  es: "Spanish — Español",
  de: "German — Deutsch",
  fr: "French — Français",
};

/** Validate that a string is a supported locale, falling back to "en" */
export function resolveLocale(lang: string | undefined | null): Locale {
  if (lang && locales.includes(lang as Locale)) {
    return lang as Locale;
  }
  return defaultLocale;
}
