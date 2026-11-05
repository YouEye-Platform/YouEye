import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { LanguageClient } from "../src/components/settings-shell/language-client";

for (const [locale, heading, hint] of [
  ["en", "Your language", "Only affects your view."],
  ["ru", "Ваш язык", "Влияет только на ваш интерфейс."],
  ["es", "Tu idioma", "Solo afecta a tu interfaz."],
  ["de", "Deine Sprache", "Gilt nur für deine Ansicht."],
  ["fr", "Votre langue", "Concerne uniquement votre interface."],
]) {
  test(`language picker renders actual ${locale} messages`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, {
      locale, messages, timeZone: "UTC", now: new Date("2026-01-01T00:00:00Z"),
      children: createElement(LanguageClient, { isAdmin: false }),
    }));
    assert.ok(html.includes(heading));
    assert.ok(html.includes(hint));
    assert.doesNotMatch(html, /MISSING_MESSAGE|languageSettings\./);
    if (locale !== "en") assert.ok(!html.includes("Your language"));
  });
}
