import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const babel = require("next/dist/compiled/babel/core");
const compiler = require("babel-plugin-react-compiler");
const esbuild = require("esbuild");

test("production-compiled Title Studio and Sticker Machine render with real React", async () => {
  const compiledFiles = [];
  const result = await esbuild.build({
    stdin: {
      contents: `
        import React from "react";
        import { renderToString } from "react-dom/server";
        import TitleBuilder from "./packages/branding/creative/TitleBuilder";
        import StickerMachine from "./packages/branding/creative/StickerMachine";
        import { defaultDesign } from "./packages/branding/lib/design";
        export function render() {
          const props = {d: defaultDesign, theme: "light", kind: "title",
            onChange() {}, onMark() {}, onColours() {}, onDetails() {}};
          return renderToString(<><TitleBuilder {...props}/><StickerMachine {...props} kind="icon"/></>);
        }
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    write: false,
    plugins: [{
      name: "actual-react-production-compiler",
      setup(build) {
        build.onLoad({ filter: /packages\/branding\/.*\.tsx$/ }, async ({ path: filename }) => {
          const output = babel.transformSync(fs.readFileSync(filename, "utf8"), {
            filename, configFile: false, babelrc: false,
            parserOpts: { plugins: ["typescript", "jsx"] },
            plugins: [[compiler, { target: "19" }]],
          });
          compiledFiles.push(filename);
          return { contents: output.code, loader: "tsx", resolveDir: path.dirname(filename) };
        });
      },
    }],
  });
  const module = new Module(import.meta.filename);
  module.filename = import.meta.filename;
  module.paths = require.resolve.paths("react");
  module._compile(result.outputFiles[0].text, import.meta.filename);
  const html = module.exports.render();
  assert.ok(compiledFiles.some((file) => file.endsWith("/StickerMachine.tsx")));
  assert.match(html, /Make a name for yourself/);
  assert.match(html, /STICKER MACHINE/);
  assert.match(html, /aria-label="Randomize sticker"/);
  assert.doesNotMatch(html, /Make a new sticker/);
});
