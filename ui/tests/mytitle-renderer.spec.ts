import assert from "node:assert/strict";
import { test, before } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defaultDesign, designSchema, fonts, presets, fitDesign } from "../../packages/branding/lib/design";
import { registerFont } from "../../packages/branding/lib/fonts";
import { supportsText } from "../../packages/branding/lib/coverage";
import { renderSvg } from "../../packages/branding/lib/render";

const asset = (name: string) => new URL(`../public/mytitle/fonts/${name}`, import.meta.url);
before(() => {
  for (const [id] of fonts) {
    const bytes = readFileSync(asset(`${id}.ttf`));
    registerFont(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
});

test("the complete local font catalogue matches the retained upstream manifest and both consumers", () => {
  const manifest = JSON.parse(readFileSync(asset("manifest.json"), "utf8"));
  assert.equal(manifest.length, 49);
  for (const row of manifest) {
    const bytes = readFileSync(asset(`${row.id}.ttf`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256, row.id);
    assert.deepEqual(bytes, readFileSync(new URL(`../../control-panel/public/mytitle/fonts/${row.id}.ttf`, import.meta.url)));
    assert.ok(readFileSync(asset(`${row.id}-LICENSE.txt`)).length > 100);
  }
});

test("every pinned preset renders path geometry in both themes and all compositions", () => {
  for (const { design } of presets) {
    assert.doesNotThrow(() => designSchema.parse(design));
    for (const theme of ["light", "dark"] as const) for (const view of ["title", "icon", "logo"] as const) {
      const svg = renderSvg(design, theme, view, "test", false);
      assert.match(svg, /<path/);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined|<script|<foreignObject|<text/);
    }
  }
});

test("persisted input rejects executable images, unknown symbols, versions and controls", () => {
  for (const bad of [
    { ...defaultDesign, version: 2 },
    { ...defaultDesign, depth: 99 },
    { ...defaultDesign, icon: { ...defaultDesign.icon, image: "data:image/png;base64,PHN2ZyBvbmxvYWQ9J2FsZXJ0KDEpJy8+" } },
    { ...defaultDesign, unknown: true },
    { ...defaultDesign, icon: { ...defaultDesign.icon, symbol: "unknown-registry-symbol" } },
    { ...defaultDesign, icon: { ...defaultDesign.icon, image: "data:image/svg+xml,<svg onload='alert(1)'/>" } },
    { ...defaultDesign, icon: { ...defaultDesign.icon, image: "https://example.invalid/image.png" } },
  ]) assert.equal(designSchema.safeParse(bad).success, false);
  const svg = renderSvg({ ...defaultDesign, name: '<script> & "hi"' }, "light");
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("multilingual titles choose actual glyph coverage; paired appearances keep geometry", () => {
  for (const name of ["Мой дом", "小屋", "우리집"]) {
    const d = fitDesign({ ...defaultDesign, name });
    assert.ok(supportsText(d.font, name), name);
    assert.match(renderSvg(d), /<path/);
  }
  const paths = (svg: string) => Array.from(svg.matchAll(/ d="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(paths(renderSvg(defaultDesign, "light")), paths(renderSvg(defaultDesign, "dark")));
});

test("compact titles fit actual lettering for short, long and warped names without changing full exports", () => {
  for (const name of ["I", "DevVM", "A much longer home title"]) for (const shape of ["straight", "arch", "wave", "slant"] as const) {
    const design = fitDesign({ ...defaultDesign, name, shape });
    const full = renderSvg(design, "light", "title");
    const compact = renderSvg(design, "light", "title", "compact", false, true);
    assert.match(full, /viewBox="0 0 960 440"/);
    const box = compact.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    assert.equal(box.length, 4);
    assert.ok(box.every(Number.isFinite));
    assert.ok(box[2] > 0 && box[2] < 960);
    assert.ok(box[3] > 0 && box[3] < 440);
    assert.deepEqual(box, renderSvg(design, "dark", "title", "compact", false, true).match(/viewBox="([^"]+)"/)![1].split(" ").map(Number));
    assert.doesNotMatch(compact, /NaN|Infinity|undefined/);
  }
});
