// Real shared Studio components with an in-memory draft, not installed acceptance.
// YOUEYE_BROWSER_TEST=1 node --import tsx --test tests/sticker-controls.browser.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("Match title preserves independent colours and unreadable uploads preserve the mark", {
  skip: process.env.YOUEYE_BROWSER_TEST !== "1", timeout: 60000,
}, async (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const require = createRequire(join(root, "control-panel/package.json"));
  const { build } = require("esbuild");
  const { chromium } = require(join(root, "node_modules/.pnpm/playwright@1.59.1/node_modules/playwright"));
  const compiled = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React, {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {TitleStudio} from "./packages/branding/Studio";
      import {defaultDesign} from "./packages/branding/lib/design";
      function Fixture() {
        const [design,setDesign]=useState({...structuredClone(defaultDesign),
          icon:{...defaultDesign.icon,mode:"symbol",symbol:"cat",match:false,
            foreground:"#135791",foregroundDark:"#abcdef"}});
        return <><TitleStudio design={design} onChange={setDesign} initialStage="icon"/>
          <output id="draft">{JSON.stringify(design)}</output></>;
      }
      createRoot(document.getElementById("root")).render(<Fixture/>);
    ` },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    nodePaths: [join(root, "control-panel/node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(compiled.outputFiles[0].text); return;
    }
    if (req.url.startsWith("/mytitle/fonts/")) {
      try { res.end(await readFile(join(root, "ui/public", req.url))); }
      catch { res.writeHead(404); res.end(); }
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    t.diagnostic("Studio loaded");
    const draft = async () => JSON.parse(await page.locator("#draft").textContent());
    const match = page.getByRole("checkbox", { name: /Match title/ });
    const original = await draft();
    await match.check();
    assert.deepEqual((await draft()).icon, { ...original.icon, match: true });
    await page.waitForFunction(() => {
      const d = JSON.parse(document.querySelector("#draft").textContent);
      return document.querySelector(".w-machine-window svg")?.outerHTML.includes(d.light.ink);
    });
    t.diagnostic("Matching colour rendered");
    await page.getByRole("button", { name: "Title Studio", exact: true }).click();
    // The legacy default shares an ink with the first palette; cycle until the
    // ink itself changes, rather than assuming every palette has a unique ink.
    for (let i = 0; i < 4 && (await draft()).light.ink === original.light.ink; i++)
      await page.getByRole("button", { name: "Next colour", exact: true }).click();
    const changed = await draft();
    assert.notEqual(changed.light.ink, original.light.ink);
    assert.deepEqual(changed.icon, { ...original.icon, match: true });
    await page.getByRole("button", { name: "Next: your logo", exact: true }).click();
    t.diagnostic("Title colour changed without replacing independent colours");
    await match.uncheck();
    assert.deepEqual((await draft()).icon, original.icon);
    await match.check();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.equal(await match.isChecked(), false);
    await match.check();
    await page.getByRole("button", { name: "Change colours", exact: true }).click();
    assert.equal(await match.isChecked(), false);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.deepEqual((await draft()).icon, { ...original.icon, match: true });
    t.diagnostic("Independent colour selection and Undo passed");
    await page.getByRole("button", { name: "Choose my own mark", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Choose your own mark" });
    await dialog.getByRole("button", { name: "Image", exact: true }).click();
    const beforeUpload = await draft();
    const file = dialog.locator('input[type="file"]');
    await file.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken") });
    await dialog.getByRole("alert").getByText("This image could not be opened. Try another PNG, JPEG or WebP image.", { exact: true }).waitFor();
    t.diagnostic("Corrupt image rejected without changing the draft");
    assert.deepEqual(await draft(), beforeUpload);
    const valid = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 24;
      canvas.getContext("2d").fillRect(0, 0, 24, 24);
      return canvas.toDataURL().split(",")[1];
    });
    await file.setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: Buffer.from(valid, "base64") });
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await draft()).icon.mode, "upload");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.deepEqual(await draft(), beforeUpload);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
