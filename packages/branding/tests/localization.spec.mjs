import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBranding, packageRoot, requireBranding, requireTools } from "./helpers.mjs";

const React = requireBranding("react");
const { renderToStaticMarkup } = requireTools("react-dom/server");
const b = loadBranding();
const h = React.createElement;
const locales = ["en", "ru", "es", "de", "fr"];
const args = (text) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]).sort();
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
const translated = (locale, element) => renderToStaticMarkup(h(b.BrandingLocaleProvider, { locale }, element));
const noop = () => {};
const design = b.paint(structuredClone(b.defaultDesign), "title", b.palettes[0]);
design.name = 'Café <My Server> & "friends"';
design.icon = { ...design.icon, mode: "symbol", symbol: "cat" };

// Exercise real lettering paths, with the same pinned bytes used by the app.
for (const id of ["righteous", "spacegrotesk", "oswald"]) {
  const bytes = readFileSync(resolve(packageRoot, "../../ui/public/mytitle/fonts", `${id}.ttf`));
  b.registerFont(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

for (const locale of locales) {
  test(`${locale}: complete catalogs, placeholder parity and number formatting`, () => {
    const catalog = b.brandingCatalogs[locale];
    const english = b.brandingCatalogs.en;
    const t = b.createBrandingTranslator(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.trim(), key);
      assert.deepEqual(args(value), args(english[key]), `${locale}:${key}`);
      const values = Object.fromEntries(args(value).map((name) => [name, 1234]));
      assert.doesNotMatch(t(key, values), /\{[a-zA-Z]+\}/, key);
      assert.equal(value.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, "").includes("{"), false, key);
    }
    assert.equal(t("common.number", { value: 1234.5 }), new Intl.NumberFormat(locale).format(1234.5));
    assert.ok(t("common.range", { start: 1, end: 48, total: 1512 }).includes(new Intl.NumberFormat(locale).format(1512)));
    assert.throws(() => t("common.use"), /Missing branding message argument/);
  });

  test(`${locale}: every design, creative and icon option has a catalog entry`, () => {
    const t = b.createBrandingTranslator(locale);
    const catalog = b.brandingCatalogs[locale];
    const key = (value) => assert.ok(Object.hasOwn(catalog, value), `${locale}:${value}`);
    for (const name of Object.keys(b.icons)) {
      key(`symbol.${name}`);
      assert.equal(b.symbolLabel(t, name), catalog[`symbol.${name}`]);
    }
    for (const [name] of b.palettes) {
      key(`palette.${name}`);
      assert.equal(b.paletteLabel(t, name), catalog[`palette.${name}`]);
    }
    for (const category of ["all", ...Object.keys(b.symbolGroups)]) key(`mark.category.${category}`);
    for (const [, labelKey] of [...b.effects, ...b.shapeNames]) key(labelKey);
    for (const { labelKey } of b.titleStyles) key(labelKey);
    for (const { nameKey } of b.iconStyles) key(nameKey);
    for (const { nameKey, hintKey } of b.moods) { key(nameKey); key(hintKey); }
    for (const experiment of b.experiments) {
      for (const [field, value] of Object.entries(experiment)) if (field.endsWith("Key")) key(value);
    }
    for (const world of Object.keys(b.worlds)) key(world);
    for (const finish of b.designSchema.shape.icon.shape.finish.unwrap().options) key(`iconFinish.${finish}`);
    for (const shape of b.designSchema.shape.icon.shape.shape.options) key(`iconShape.${shape}`);
  });

  test(`${locale}: renders studio chrome, accessibility and dynamic labels without changing artwork`, () => {
    const before = JSON.stringify(design);
    const t = b.createBrandingTranslator(locale);
    const html = translated(locale, h(b.TitleStudio, { design, onChange: noop, onContinue: noop, onBack: noop }));
    for (const key of ["title.heading", "title.nameLabel", "title.identity.label", "title.identity.random",
      "title.colour.label", "title.colour.choose", "title.finish.label", "title.finish.browse",
      "title.keepHint", "title.next", "sticker.kicker", "sticker.match", "sticker.ownMark",
      "sticker.identity.change", "mark.symbols", "mark.category.all", "common.closeDialog",
      "studio.undo", "studio.smallPreviews", "studio.use"]) {
      assert.ok(html.includes(escape(t(key))), `${locale}:${key}`);
    }
    assert.ok(html.includes(escape(t("artwork.identityLabel", { name: design.name }))));
    assert.ok(html.includes(escape(t("artwork.iconLabel", { name: design.name }))));
    assert.ok(html.includes(escape(b.namedSymbol(design, t))));
    assert.ok(html.includes(escape(b.paletteLabel(t, b.palettes[0][0]))));
    assert.ok(html.includes(escape(t("effect.flat"))));
    assert.ok(html.includes('value="' + escape(design.name) + '"'));
    assert.ok(html.includes("Righteous"));
    assert.ok(html.includes("data-title-art"));
    assert.equal(JSON.stringify(design), before);
    if (locale !== "en") {
      for (const key of ["title.heading", "sticker.intro", "studio.use", "title.identity.random"]) {
        assert.ok(!html.includes(escape(b.brandingCatalogs.en[key])), `${locale}: leaked ${key}`);
      }
    }
  });

  test(`${locale}: mark sources, upload hints, fonts and reusable controls render localized names`, () => {
    const t = b.createBrandingTranslator(locale);
    const entry = (mode) => translated(locale, h(b.MarkLibrary, { design: { ...design, icon: { ...design.icon, mode } }, onChange: noop, onClose: noop }));
    assert.ok(entry("monogram").includes(escape(t("mark.useLetters"))));
    assert.ok(entry("emoji").includes(escape(t("mark.customEmoji"))));
    assert.ok(entry("upload").includes(escape(t("mark.imageHint"))));
    const props = { d: design, kind: "title", theme: "light", onChange: noop, onColours: noop, onMark: noop, onDetails: noop };
    const controls = translated(locale, h(React.Fragment, null,
      h(b.FontSelect, props),
      h(b.FinishTiles, props),
      h(b.FinishTiles, { ...props, kind: "icon" }),
      h(b.Swatches, props),
      h(b.Lock, { locked: true, label: t("sticker.identity.label"), onChange: noop }),
      h(b.LockButton, { locked: false, label: t("sticker.colour.label"), onClick: noop }),
      h(b.ShuffleButton, { onClick: noop }),
      h(b.RangeControl, { label: t("title.colour.label"), value: 1234, max: 2000, onChange: noop }),
    ));
    for (const key of ["font.lettering", "outfit.softServe", "common.remix"]) assert.ok(controls.includes(escape(t(key))), key);
    assert.ok(controls.includes(escape(t("common.keep", { label: t("sticker.colour.label") }))));
    assert.ok(controls.includes(escape(t("common.unlockShuffle", { label: t("sticker.identity.label") }))));
    assert.ok(controls.includes(new Intl.NumberFormat(locale).format(1234)));
    assert.equal(b.namedSymbol({ ...design, icon: { ...design.icon, mode: "upload" } }, t), t("mark.imageFallback"));
    assert.equal(b.namedSymbol({ ...design, icon: { ...design.icon, mode: "monogram", letters: "Я" } }, t), "Я");
  });

  test(`${locale}: font coverage warnings and error messages have translations`, () => {
    const t = b.createBrandingTranslator(locale);
    const html = translated(locale, h(b.Artwork, { design: { ...design, name: "🧪", icon: { ...design.icon, mode: "monogram", letters: "🧪" } }, view: "logo" }));
    assert.ok(html.includes(escape(t("artwork.titleFontError"))));
    assert.ok(html.includes(escape(t("artwork.initialsFontError"))));
    for (const key of ["artwork.loadError", "upload.typeError", "upload.sizeError", "upload.openError", "upload.dimensionsError", "upload.readError"]) {
      assert.ok(t(key));
      if (locale !== "en") assert.notEqual(t(key), b.brandingCatalogs.en[key], key);
    }
  });
}

test("regional/unknown locale selection and independent translators never share a person's locale", async () => {
  assert.equal(b.normalizeBrandingLocale(" RU_ru "), "ru");
  assert.equal(b.normalizeBrandingLocale("es-MX"), "es");
  assert.equal(b.normalizeBrandingLocale("fr-CA"), "fr");
  assert.equal(b.normalizeBrandingLocale("pt-BR"), "en");
  const results = await Promise.all(locales.map(async (locale) => {
    const t = b.createBrandingTranslator(locale);
    await Promise.resolve();
    return t("title.heading");
  }));
  assert.deepEqual(results, locales.map((locale) => b.brandingCatalogs[locale]["title.heading"]));
  function Probe() { return h("span", { lang: b.useBrandingLocale() }, b.useBrandingTranslations()("title.heading")); }
  const markup = renderToStaticMarkup(h(React.Fragment, null,
    h(b.BrandingLocaleProvider, { locale: "ru" }, h(Probe)),
    h(b.BrandingLocaleProvider, { locale: "de" }, h(Probe)),
    h(Probe),
  ));
  for (const locale of ["ru", "de", "en"]) assert.ok(markup.includes(`lang="${locale}">${escape(b.brandingCatalogs[locale]["title.heading"])}`));
});

test("user placeholders and SVG accessible metadata escape safely without changing geometry", () => {
  const name = '<img src=x onerror="bad()"> & {name}';
  const t = b.createBrandingTranslator("ru");
  assert.equal(t("artwork.iconLabel", { name }), `Значок: ${name}`);
  const metadata = (locale) => {
    const translate = b.createBrandingTranslator(locale);
    return { label: translate("artwork.iconLabel", { name }), title: translate("artwork.documentTitle", { name }) };
  };
  const en = b.renderSvg(design, "light", "icon", "test", false, false, metadata("en"));
  const ru = b.renderSvg(design, "light", "icon", "test", false, false, metadata("ru"));
  const geometry = (svg) => svg.replace(/aria-label="[^"]*"/, "").replace(/<title>.*?<\/title>/, "");
  assert.equal(geometry(en), geometry(ru));
  assert.ok(ru.includes("&lt;img"));
  assert.ok(!ru.includes("<img"));
});

test("upload failures retain typed message keys, not frozen display strings", async () => {
  const image = { type: "image/png", size: 10 };
  const rejected = (code) => (error) => error instanceof b.ImageReadError && error.code === code;
  await assert.rejects(b.readImage({ type: "image/svg+xml", size: 1 }), rejected("upload.typeError"));
  await assert.rejects(b.readImage({ ...image, size: 2_000_001 }), rejected("upload.sizeError"));
  const previousBitmap = globalThis.createImageBitmap;
  const previousReader = globalThis.FileReader;
  try {
    globalThis.createImageBitmap = async () => { throw new Error("decoder detail"); };
    await assert.rejects(b.readImage(image), rejected("upload.openError"));
    let closed = false;
    globalThis.createImageBitmap = async () => ({ width: 4097, height: 2, close() { closed = true; } });
    await assert.rejects(b.readImage(image), rejected("upload.dimensionsError"));
    assert.equal(closed, true);
    globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
    globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => this.onerror()); } };
    await assert.rejects(b.readImage(image), rejected("upload.readError"));
    globalThis.FileReader = class { result = "data:image/png;base64,unchanged"; readAsDataURL() { queueMicrotask(() => this.onload()); } };
    assert.equal(await b.readImage(image), "data:image/png;base64,unchanged");
  } finally {
    globalThis.createImageBitmap = previousBitmap;
    globalThis.FileReader = previousReader;
  }
});

test("shared source audit has zero untranslated package entries, without any baseline", async () => {
  const { collectSourceLiterals } = await import("../../../shared/i18n-source-audit.mjs");
  const literals = collectSourceLiterals(resolve(packageRoot, "../../control-panel"), requireTools("typescript"));
  const shared = [...literals].filter(([id]) => JSON.parse(id)[0].includes("packages/branding/"));
  assert.deepEqual(shared, []);
});
