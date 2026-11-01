"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createBrandingTranslator,
  normalizeBrandingLocale,
  type BrandingLocale,
  type BrandingTranslator,
} from "./messages";

export {
  brandingLocales,
  createBrandingTranslator,
  normalizeBrandingLocale,
  type BrandingArguments,
  type BrandingLocale,
  type BrandingMessageKey,
  type BrandingTranslator,
} from "./messages";

const BrandingLocaleContext = createContext<{
  locale: BrandingLocale;
  t: BrandingTranslator;
}>({ locale: "en", t: createBrandingTranslator("en") });

/**
 * Pass the host's authenticated, resolved interface locale. Update this prop
 * in place (do not key/remount the provider) to preserve drafts, locks and undo.
 * No browser preference, cookie, process global or next-intl dependency is used.
 */
export function BrandingLocaleProvider({ locale, children }: {
  locale: string;
  children: ReactNode;
}) {
  const language = normalizeBrandingLocale(locale);
  const value = useMemo(
    () => ({ locale: language, t: createBrandingTranslator(language) }),
    [language],
  );
  return <BrandingLocaleContext.Provider value={value}>{children}</BrandingLocaleContext.Provider>;
}

export function useBrandingLocale(): BrandingLocale {
  return useContext(BrandingLocaleContext).locale;
}

export function useBrandingTranslations(): BrandingTranslator {
  return useContext(BrandingLocaleContext).t;
}
