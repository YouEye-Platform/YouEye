import en from "./en.json";
import ru from "./ru.json";
import es from "./es.json";
import de from "./de.json";
import fr from "./fr.json";

export const brandingLocales = ["en", "ru", "es", "de", "fr"] as const;
export type BrandingLocale = (typeof brandingLocales)[number];
export type BrandingMessageKey = keyof typeof en;
export type BrandingMessages = Record<BrandingMessageKey, string>;
export type BrandingArguments = Record<string, string | number>;
export type BrandingTranslator = (
  key: BrandingMessageKey,
  values?: BrandingArguments,
) => string;

export const brandingCatalogs: Record<BrandingLocale, BrandingMessages> = { en, ru, es, de, fr };

/** The host resolves the person's preference; this only selects a shipped catalog. */
export function normalizeBrandingLocale(locale: string): BrandingLocale {
  const base = locale.trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return brandingLocales.find((supported) => supported === base) ?? "en";
}

/** Pure per-call factory, also usable by authenticated producers and tests. */
export function createBrandingTranslator(locale: string): BrandingTranslator {
  const language = normalizeBrandingLocale(locale);
  const messages = brandingCatalogs[language];
  const numbers = new Intl.NumberFormat(language);
  return (key, values = {}) => {
    const message = messages[key] ?? en[key];
    return message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Missing branding message argument: ${key}.${name}`);
      return typeof value === "number" ? numbers.format(value) : value;
    });
  };
}
