import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createTranslator } from "next-intl";

// YE-152: a translated label rendered right next to a value ("Restart and install0.6.18-alpha.1") loses the space,
// and other languages may need the value elsewhere in the sentence. Such text is one message with a placeholder.
const locales = ["en", "ru", "es", "de", "fr"];
const catalogue = (locale: string) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));

for (const locale of locales) {
  test(`settings messages carry their values as placeholders (${locale})`, () => {
    const t = createTranslator({ locale, messages: catalogue(locale), namespace: "interface", onError(error) { throw error; } });
    for (const [id, values, value] of [
      ["m0bf8bea46557", { version: "0.6.18-alpha.1" }, "0.6.18-alpha.1"], // Restart and install {version}
      ["mdcb91ff99eb6", { version: "2026-11" }, "2026-11"], // Certificate terms {version}
      ["m3211e08d269c", { version: "26.11.2" }, "v26.11.2"], // Update complete: v{version}
      ["m7f013bd610dc", { name: "Alice" }, "Alice"], // Owned by {name}
    ] as const) {
      const text = t(id, values);
      const at = text.indexOf(value);
      assert.ok(at >= 0, `${locale} ${id}: ${text}`);
      // Never glued to the word before it.
      assert.ok(at === 0 || !/\p{L}/u.test(text[at - 1]), `${locale} ${id}: ${text}`);
    }
    // Lists count their domains with the language's plural forms.
    const domains = (count: number) => t("m1da897576823", { count });
    assert.match(domains(1), /^1 \p{L}/u);
    assert.match(domains(1200), /^1[\s,.  ]?200 \p{L}/u);
  });
}

test("English domain counts are singular and plural", () => {
  const t = createTranslator({ locale: "en", messages: catalogue("en"), namespace: "interface" });
  assert.equal(t("m1da897576823", { count: 1 }), "1 domain");
  assert.equal(t("m1da897576823", { count: 2 }), "2 domains");
});

// A label call directly followed by another JSX expression. Each one left must render its own separator: an explicit
// space, a second label whose text starts with one (" · off"), or a flex gap.
const allowed = new Set([
  'apps-client.tsx: {translateInterface("m0b7c0ace70d0", {group: group.name, count: group.enabledModelCount})}{group.isDefault ? translateInterface("m2a7e0b7b2062") : ""}',
  'backup-client.tsx: {translateInterface("mb0e3669b18e7", {size: formatSize(backup.sizeBytes), count: backup.appCount})}{backup.reason === "scheduled" ? translateInterface("m336659c84a0f") : ""}',
  'backup-client.tsx: {translateInterface("me06956e5d7e6")}{stepState(driveStep)}',
  'backup-client.tsx: {translateInterface("m69b9692f78a4")}{stepState(keyStep)}',
  'backup-client.tsx: {translateInterface("m6b4fc314ae7d")}{stepState(appsStep)}',
  'network-client.tsx: {translateInterface("m1da897576823", {count: list.number ?? 0})}{list.enabled ? "" : translateInterface("m62a5b50f644f")}',
]);

test("settings-shell puts no value right after a translated label", () => {
  const dir = new URL("../src/components/settings-shell/", import.meta.url);
  const found: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith(".tsx"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const match of source.matchAll(/\{(?:translateInterface|t)\("[^"]+"(?:, \{[^{}]*\})?\)\}\{(?!" "\})[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
      found.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(found.filter(entry => !allowed.has(entry)), []);
  // Each allowed one still exists, so the list does not outlive the code.
  assert.deepEqual([...allowed].filter(entry => !found.includes(entry)), []);
  // The separators those rely on.
  for (const locale of locales) {
    const messages = catalogue(locale).interface;
    for (const id of ["m2a7e0b7b2062", "m62a5b50f644f", "m336659c84a0f"]) assert.match(messages[id], /^ /, `${locale} ${id}`);
  }
  assert.match(readFileSync(new URL("backup-client.tsx", dir), "utf8"), /gap-x-2 text-sm font-semibold">\{translateInterface\("me06956e5d7e6"\)\}/);
});
