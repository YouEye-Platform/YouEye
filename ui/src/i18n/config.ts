/**
 * i18n Configuration for YE-UI
 *
 * Defines supported locales and the default locale.
 * Language resolution order:
 *   1. User's personal language setting (userSettings.language)
 *   2. System language from youeye.yaml (via bridge)
 *   3. Fallback: "en"
 */

export const locales = ["en", "ru", "es", "de", "fr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Display names for the language selector (native name) */
export const localeDisplayNames: Record<Locale, { native: string; english: string }> = {
  en: { native: "English", english: "English" },
  ru: { native: "Русский", english: "Russian" },
  es: { native: "Español", english: "Spanish" },
  de: { native: "Deutsch", english: "German" },
  fr: { native: "Français", english: "French" },
};

/** Validate that a string is a supported locale, falling back to "en" */
export function resolveLocale(lang: string | undefined | null): Locale {
  if (lang && locales.includes(lang as Locale)) {
    return lang as Locale;
  }
  return defaultLocale;
}

/** A malformed personal value must not hide a valid instance preference. */
export function resolvePreferredLocale(user: unknown, system: unknown): Locale {
  for (const value of [user, system]) {
    if (typeof value === "string" && locales.includes(value as Locale)) return value as Locale;
  }
  return defaultLocale;
}
