import test from "node:test";
import assert from "node:assert/strict";
import { mergeMessages } from "../../shared/message-catalog";
import { languages, localeDirection, resolvePreferredLocale } from "../src/i18n/config";

test("nested fallback preserves translated siblings and does not mutate catalogues", () => {
  const english = { form: { save: "Save", cancel: "Cancel" }, welcome: "Hello, {name}" };
  const translated = { form: { save: "Speichern" } };
  assert.deepEqual(mergeMessages(english, translated), {
    form: { save: "Speichern", cancel: "Cancel" }, welcome: "Hello, {name}",
  });
  assert.equal(english.form.save, "Save");
  assert.deepEqual(translated, { form: { save: "Speichern" } });
});

test("regional fallback and malformed preferences preserve the instance language", () => {
  assert.equal(resolvePreferredLocale("FR-ca", "de"), "fr");
  assert.equal(resolvePreferredLocale("xx-ZZ", "es"), "es");
  assert.equal(resolvePreferredLocale("../../de", "ru"), "ru");
  assert.equal(resolvePreferredLocale({ code: "fr" }, null), "en");
  for (const language of languages) {
    assert.equal(resolvePreferredLocale(language.code, "en"), language.code);
    assert.equal(localeDirection(language.code), language.direction);
  }
});
