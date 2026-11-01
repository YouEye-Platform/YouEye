import { createTranslator } from "next-intl";
import { getUserSettings, getSystemLanguage } from "@/lib/db/queries/settings";
import { resolvePreferredLocale } from "./config";
import { mergeMessages } from "../../../shared/message-catalog";
import english from "../../messages/en.json";

/** The caller must supply its already authenticated/authorized acting user. */
export async function getUserTranslator(userId: string) {
  const [settings, systemLanguage] = await Promise.all([
    getUserSettings(userId),
    getSystemLanguage(),
  ]);
  const locale = resolvePreferredLocale(settings.language, systemLanguage);
  const selected = (await import(`../../messages/${locale}.json`)).default;
  return {
    locale,
    t: createTranslator({ locale, messages: { interface: mergeMessages(english, selected).interface as Record<string, string> }, namespace: "interface" }),
  };
}
