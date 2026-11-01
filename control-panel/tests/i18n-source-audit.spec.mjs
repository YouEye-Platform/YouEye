import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { collectSourceLiterals } from "../../shared/i18n-source-audit.mjs";

const ts = createRequire(import.meta.url)("typescript");

test("translation audit includes shared controls and TypeScript navigation data", () => {
  const fixture = mkdtempSync(join(tmpdir(), "i18n-audit-"));
  const put = (path, source) => {
    const file = join(fixture, path);
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, source);
  };
  try {
    put("control-panel/src/components/ai-navigation.ts", 'export const links = [{label: "New navigation"}];');
    put("control-panel/src/page.tsx", '<button aria-label="Accessible action">{t("translated")}</button>');
    put("packages/branding/Studio.tsx", '<button>Untranslated shared action</button>');
    put("packages/branding/creative/data.ts", 'export const choices = [{title: "New creative choice"}];');
    put("packages/branding/node_modules/vendor.tsx", '<p>Third-party implementation</p>');
    const messages = [...collectSourceLiterals(join(fixture, "control-panel"), ts).keys()].map(key => JSON.parse(key)[1]);
    assert.deepEqual(messages.sort(), ["Accessible action", "New creative choice", "New navigation", "Untranslated shared action"].sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a misplaced client directive fails in shared components as well", () => {
  const fixture = mkdtempSync(join(tmpdir(), "i18n-directive-"));
  try {
    mkdirSync(join(fixture, "control-panel/src"), { recursive: true });
    mkdirSync(join(fixture, "packages/branding"), { recursive: true });
    writeFileSync(join(fixture, "packages/branding/Studio.tsx"), 'import x from "x"; "use client";');
    assert.throws(() => collectSourceLiterals(join(fixture, "control-panel"), ts), /Client directive must precede imports/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
