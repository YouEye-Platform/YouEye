/** Supported interface languages. Add catalogues and a registry entry together. */
import languages from "../../../shared/languages.json";
export { languages };
export const locales = languages.map(language => language.code);
export type Locale = string;
export const defaultLocale = "en";
export const localeDisplayNames = Object.fromEntries(languages.map(language => [language.code, language]));
export const localeNames = Object.fromEntries(languages.map(language => [language.code,
  language.native === language.english ? language.native : `${language.english} — ${language.native}`]));
export function resolveLocale(value: unknown): Locale {
  return resolvePreferredLocale(value, null);
}
export function resolvePreferredLocale(user: unknown, system: unknown): Locale {
  for (const value of [user, system]) {
    if (typeof value !== "string") continue;
    // Exact regional catalogues win; an unsupported regional variant may use its base.
    const code = value.toLowerCase();
    const exact = locales.find(locale => locale.toLowerCase() === code);
    if (exact) return exact;
    const base = locales.find(locale => locale.toLowerCase() === code.split("-")[0]);
    if (base) return base;
  }
  return defaultLocale;
}
export function localeDirection(locale: string): "ltr" | "rtl" {
  return languages.find(language => language.code === locale)?.direction === "rtl" ? "rtl" : "ltr";
}
