// YE-163: every message key the source uses exists in every catalogue.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { checkMessageKeys } from "../../shared/i18n-message-keys.mjs";

const ts = createRequire(import.meta.url)("typescript");
const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(resolve(root, "../shared/languages.json"), "utf8"));
const realCatalogues = () => Object.fromEntries(registry.map(({ code }) =>
  [code, JSON.parse(readFileSync(resolve(root, "messages", `${code}.json`), "utf8"))]));
const checkReal = catalogues => checkMessageKeys({ root, ts, sourceDirs: [resolve(root, "src")], catalogues });

test("every message key the Control Panel uses exists in every catalogue", () => {
  const result = checkReal(realCatalogues());
  assert.deepEqual(result.missing, []);
  assert.ok(result.keys > 1000, `only ${result.keys} key uses found`);
});

test("a catalogue without a key the source uses fails (the YE-152 merge dropped \"domains\")", () => {
  const catalogues = realCatalogues();
  for (const tree of Object.values(catalogues)) delete tree.interface.m1b0ec1954eec;
  const missing = checkReal(catalogues).missing.filter(m => m.key === "interface.m1b0ec1954eec");
  assert.ok(missing.some(m => m.file === "src/app/embed/dns/client.tsx"), JSON.stringify(missing));
  assert.deepEqual(missing[0].locales.sort(), registry.map(({ code }) => code).sort());
});

test("translator calls are resolved through aliases, namespaces and scopes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "i18n-keys-"));
  try {
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "src/page.tsx"), `
      import { useTranslations as useLabels } from "next-intl";
      import { getTranslations } from "next-intl/server";
      const labelMap = { ok: "m000000000001", gone: "m0000000000ff" };
      export function Page({ on }) {
        const t = useLabels("settings");
        t("present"); t("absent"); t.rich("richAbsent"); t.has("notChecked");
        t(on ? "present" : "branchAbsent");
        t(\`names.\${on}\`); t(\`nothing.\${on}\`);
        function helper(t) { return t("fromAParameter"); }
        return helper;
      }
      export async function Server() {
        const s = await getTranslations({ locale: "en", namespace: "interface" });
        const root = await getTranslations();
        return [s("m000000000001"), root("settings.present"), root("settings.rootAbsent")];
      }
    `);
    const en = { settings: { present: "P", names: { a: "A" } }, interface: { m000000000001: "One" } };
    const de = { settings: { present: "P" }, interface: { m000000000001: "Eins" } };
    const result = checkMessageKeys({ root: fixture, ts, sourceDirs: [join(fixture, "src")], catalogues: { en, de } });
    const missing = Object.fromEntries(result.missing.map(m => [m.key, m.locales.join(",")]));
    assert.deepEqual(missing, {
      "settings.absent": "en,de",
      "settings.richAbsent": "en,de",
      "settings.branchAbsent": "en,de",
      "settings.names.*": "de",
      "settings.nothing.*": "en,de",
      "settings.rootAbsent": "en,de",
      "interface.m0000000000ff": "en,de",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("translator props, destructured names, computed namespaces and t.raw groups", () => {
  const fixture = mkdtempSync(join(tmpdir(), "i18n-keys-"));
  try {
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "src/setup.tsx"), `
      import { useTranslations } from "next-intl";
      import { getTranslations } from "next-intl/server";
      function Status({ ok, t }: { ok: boolean; t: ReturnType<typeof useTranslations> }) {
        return ok ? t("present") : t("propAbsent");
      }
      function Mixed({ t }: { t: ReturnType<typeof useTranslations> }) { return t("notChecked1"); }
      function helper(t: ReturnType<typeof useTranslations>) { return t("notChecked2"); }
      export function Page({ ok }) {
        const t = useTranslations("setup");
        const other = useTranslations("other");
        function Inner({ t }) { return t("shadowedByProps"); }
        const arrow = ({ t: label }) => label("shadowedByRename");
        const [first] = [""], { t: renamed } = { t: () => "" };
        t.raw("group"); t.raw("groupAbsent");
        return [<Status ok={ok} t={t} />, <Mixed t={t} />, <Mixed t={other} />, Inner, arrow, first, renamed, helper];
      }
      export async function Server(namespace) {
        const s = await getTranslations({ locale: "en", namespace });
        return s("notChecked3");
      }
    `);
    const en = { setup: { present: "P", group: { a: "A", b: "B" } } };
    const result = checkMessageKeys({ root: fixture, ts, sourceDirs: [join(fixture, "src")], catalogues: { en } });
    assert.deepEqual(result.missing.map(m => m.key).sort(), ["setup.groupAbsent", "setup.propAbsent"]);
    // Mixed gets two namespaces, helper an argument, Server a computed namespace: counted, not checked. Names bound by
    // destructuring (Inner's and arrow's) are no translators at all.
    assert.deepEqual(result.dynamic.map(d => d.text).sort(), ['s("notChecked3")', 't("notChecked1")', 't("notChecked2")']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
