// Real onboarding client with read-only fixture endpoints.
// YOUEYE_BROWSER_TEST=1 node --import tsx --test tests/onboarding-navigation.browser.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("rapid navigation cannot save a newly exposed avatar, including reduced motion", {
  skip: process.env.YOUEYE_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const root = resolve(import.meta.dirname, "../..");
  const require = createRequire(join(root, "control-panel/package.json"));
  const { build } = require("esbuild");
  const { chromium } = require(join(root, "node_modules/.pnpm/playwright@1.59.1/node_modules/playwright"));
  const globalCss = await readFile(join(root, "control-panel/src/app/globals.css"), "utf8");
  const onboardingCss = globalCss.slice(globalCss.indexOf("@keyframes onboarding-enter"));
  const compiled = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {OnboardingClient} from "./control-panel/src/components/onboarding/onboarding-client";
      createRoot(document.getElementById("root")).render(<OnboardingClient username="fixture"/>);
    ` },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    nodePaths: [join(root, "control-panel/node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    plugins: [{
      name: "fixture-resolution",
      setup(build) {
        build.onResolve({ filter: /^@\// }, args => ({ path: require.resolve(join(root, "control-panel/src", args.path.slice(2))) }));
        build.onResolve({ filter: /^next\/image$/ }, () => ({ path: "image", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'import React from "react"; export default function Image({unoptimized,...props}) { return <img {...props}/> }',
          loader: "tsx", resolveDir: join(root, "control-panel"),
        }));
      },
    }],
  });
  const mutations = [];
  const server = createServer(async (req, res) => {
    const json = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
    if (req.method !== "GET") { mutations.push(req.url); json({ success: true }); return; }
    if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(compiled.outputFiles[0].text); return; }
    if (req.url === "/api/ui/branding") { json({ site_name: "Fixture" }); return; }
    if (req.url === "/api/ui-settings/onboarding") { json({ completed: false, has_pin: false, timeline: { configured: false, enabled: false, revision: null } }); return; }
    if (req.url.startsWith("/profile-avatar-art/")) { res.writeHead(204); res.end(); return; }
    res.setHeader("Content-Type", "text/html");
    // Reproduce the real phone overlap: the first profile choice occupies the
    // old Continue target. The test must exercise trusted pointer events.
    res.end(`<!doctype html><html><head><style>${onboardingCss}
      .onboarding-step > div > button:last-child,
      [aria-label="Profile icon presets"] [role="tabpanel"] button:first-child
      {position:fixed;left:20px;top:300px;width:120px;height:44px}
      </style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
      const page = await context.newPage();
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole("heading", { name: "Welcome, fixture", exact: true }).waitFor();
      const box = await page.getByRole("button", { name: "Continue", exact: true }).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 3, delay: 15 });
      await page.getByRole("heading", { name: "Your profile icon", exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector(".onboarding-step").getAttribute("aria-busy") === "false");
      assert.deepEqual(mutations, []);
      assert.equal(await page.locator("h1").evaluate(el => el === document.activeElement), true);
      // Once the guard settles, an intentional choice works normally.
      await page.getByRole("button", { name: /Use .+ avatar/ }).first().click();
      await page.waitForFunction(() => document.querySelector(".onboarding-step").getAttribute("aria-busy") === "false");
      assert.deepEqual(mutations.splice(0), ["/api/user/avatar"]);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      assert.equal(await page.locator(".onboarding-step").evaluate(el => getComputedStyle(el).animationName),
        reducedMotion === "reduce" ? "none" : "onboarding-enter");
      await page.getByLabel("Timeline PIN", { exact: true }).fill(" unsaved draft 🔐 ");
      await page.getByLabel("Repeat your PIN", { exact: true }).fill(" unsaved draft 🔐 ");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("heading", { name: "Ready for your space?", exact: true }).waitFor();
      assert.equal((await page.innerText("body")).includes("unsaved draft"), false);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      assert.equal(await page.getByLabel("Timeline PIN", { exact: true }).inputValue(), " unsaved draft 🔐 ");
      assert.equal(await page.locator(".onboarding-step").evaluate(el => getComputedStyle(el).animationName),
        reducedMotion === "reduce" ? "none" : "onboarding-back");
      assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
