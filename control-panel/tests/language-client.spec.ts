import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { LanguageClient } from "../src/components/settings-shell/language-client";

for (const locale of ["en", "ru", "es", "de", "fr"]) {
  test(`language & region renders actual ${locale} messages`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, {
      locale, messages, timeZone: "UTC", now: new Date("2026-01-01T00:00:00Z"),
      children: createElement(LanguageClient),
    }));
    assert.ok(html.includes(messages.languageSettings.personal));
    assert.ok(html.includes(messages.settingsYou.language.timezone));
    assert.ok(html.includes(messages.settingsYou.language.region));
    assert.doesNotMatch(html, /MISSING_MESSAGE|languageSettings\.|settingsYou\./);
    if (locale !== "en") assert.ok(!html.includes("Your language") && !html.includes("Time zone"));
  });
}

test("the five locales translate every settingsYou key", () => {
  const load = (locale: string) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")).settingsYou;
  const keys = (value: unknown, prefix = ""): string[] => typeof value === "string" ? [prefix]
    : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keys(child, `${prefix}.${key}`));
  const english = keys(load("en")).sort();
  for (const locale of ["ru", "es", "de", "fr"]) assert.deepEqual(keys(load(locale)).sort(), english, locale);
});
