// Focused real-component browser regression with a local fixture API.
// YOUEYE_BROWSER_TEST=1 node --import tsx --test tests/title-appearance.browser.mjs
// Requires the lockfile-pinned Playwright browser. This is not installed acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("saved personal/shared titles refresh headers and widgets without reloading", {
  skip: process.env.YOUEYE_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const root = resolve(import.meta.dirname, "../..");
  const require = createRequire(join(root, "control-panel/package.json"));
  const { build } = require("esbuild");
  const { chromium } = require(join(root, "node_modules/.pnpm/playwright@1.59.1/node_modules/playwright"));
  const { defaultDesign } = await import("../../packages/branding/lib/design.ts");
  const { resolveTitle } = await import("../../packages/branding/appearance.ts");
  const style = { fontFamily: "Inter", fontSize: "1.5rem", fontWeight: 700,
    letterSpacing: "0em", color: "#111111", gradient: null, textShadow: "none", textTransform: "none" };
  let shared = { site_name: "Shared original", site_name_style: { ...style, mytitle: { ...defaultDesign, name: "Shared original" } } };
  const personal = new Map();
  let failSave = false;
  let delayedHeader = null;
  let releaseAppearance;
  const initialAppearance = new Promise(resolve => { releaseAppearance = resolve; });
  const compiled = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { ControlHeader } from "./control-panel/src/components/control-surface/control-header";
      import { AppearanceClient } from "./control-panel/src/components/settings-shell/appearance-client";
      import { HeaderBrand } from "./ui/src/components/layout/header-brand";
      import { ServerNameWidget } from "./ui/src/components/widgets/server-name-widget";
      createRoot(document.getElementById("root")).render(<>
        <div id="settings-header"><ControlHeader username="fixture" isAdmin /></div>
        <div id="dashboard-header"><HeaderBrand initial={{site_name:"Shared original",site_name_style:null,logo_url:null}} /></div>
        <div id="widget"><ServerNameWidget /></div>
        <AppearanceClient isAdmin />
      </>);
    ` },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    nodePaths: [join(root, "control-panel/node_modules"), join(root, "ui/node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    plugins: [{
      name: "local-fixture-resolution",
      setup(build) {
        build.onResolve({ filter: /^@\// }, args => ({
          path: require.resolve(join(root, args.importer.includes("/ui/") ? "ui/src" : "control-panel/src", args.path.slice(2))),
        }));
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'import React from "react"; export default function Link({children,...props}) { return <a {...props}>{children}</a> }',
          loader: "tsx", resolveDir: join(root, "control-panel"),
        }));
      },
    }],
  });
  const script = compiled.outputFiles[0].text;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const user = req.headers.cookie?.includes("user=bob") ? "bob" : "alice";
    const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
    if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
    if (path.startsWith("/mytitle/fonts/")) {
      try { res.end(await readFile(join(root, "ui/public", path))); } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (path.includes("header/config")) {
      const title = resolveTitle(shared, personal.get(user));
      const payload = { branding: { site_name: title.name, site_name_style: title.style, logo_url: null },
        user: { username: user, email: `${user}@example.invalid`, is_admin: true }, theme: { mode: "light" } };
      if (delayedHeader) { const wait = delayedHeader; delayedHeader = null; await wait; }
      json(payload); return;
    }
    if (path === "/api/ui/branding") {
      if (req.method === "GET") await initialAppearance;
      if (req.method === "PUT") {
        if (failSave) { json({ error: "Fixture save failure" }, 500); return; }
        let body = ""; for await (const part of req) body += part;
        const saved = JSON.parse(body);
        shared = { ...saved, site_name: saved.site_name_style.mytitle.name };
      }
      json(shared); return;
    }
    if (path.endsWith("/wordart")) {
      if (req.method === "GET") await initialAppearance;
      if (req.method === "PUT") {
        if (failSave) { json({ error: "Fixture save failure" }, 500); return; }
        let body = ""; for await (const part of req) body += part;
        personal.set(user, JSON.parse(body).wordart);
      }
      if (req.method === "DELETE") personal.delete(user);
      json({ wordart: personal.get(user) ?? null }); return;
    }
    if (path.includes("/themes")) { json([]); return; }
    if (path.startsWith("/api") || path.includes("/api/")) { json({}); return; }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    await bob.addCookies([{ name: "user", value: "bob", url: origin }]);
    const page = await alice.newPage();
    const otherTab = await alice.newPage();
    const otherUser = await bob.newPage();
    const errors = [];
    for (const p of [page, otherTab, otherUser]) p.on("pageerror", e => errors.push(e.message));
    await Promise.all([page.goto(origin), otherTab.goto(origin), otherUser.goto(origin)]);
    const title = (p, selector = "#settings-header") => p.locator(`${selector} [role=img]`).filter({ has: p.locator(".mytitle-light") });
    async function expectTitle(p, name) {
      for (const selector of ["#settings-header", "#dashboard-header", "#widget"]) {
        await p.waitForFunction(({ selector, name }) =>
          [...document.querySelectorAll(`${selector} [role=img]`)].some(el => el.getAttribute("aria-label") === name), { selector, name });
      }
    }
    await expectTitle(page, "Shared original");
    await page.getByText("Loading appearance…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Your title", exact: true }).count(), 0);
    releaseAppearance();
    await page.getByRole("textbox", { name: "Your title", exact: true }).fill("Alice personal");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expectTitle(page, "Alice personal");
    await expectTitle(otherTab, "Alice personal"); // BroadcastChannel, no reload or focus.
    await expectTitle(otherUser, "Shared original");
    await page.getByRole("button", { name: "Server Branding", exact: true }).click();
    await page.getByRole("textbox", { name: "Your title", exact: true }).fill("Shared saved");
    await page.getByRole("button", { name: "Save title and sticker", exact: true }).click();
    await expectTitle(page, "Alice personal");
    await otherUser.evaluate(() => dispatchEvent(new Event("focus")));
    await expectTitle(otherUser, "Shared saved");
    assert.equal(shared.site_name, "Shared saved");

    // Reset must not use an unsaved administrator draft.
    await page.getByRole("textbox", { name: "Your title", exact: true }).fill("Unsaved server draft");
    await page.getByRole("button", { name: "My Title Studio", exact: true }).click();
    await page.getByRole("button", { name: "Use server title", exact: true }).click();
    await expectTitle(page, "Shared saved");
    await expectTitle(otherTab, "Shared saved");
    assert.equal(personal.has("alice"), false);

    // A rejected save changes neither the confirmed header nor another user's view.
    failSave = true;
    await page.getByRole("textbox", { name: "Your title", exact: true }).fill("Rejected personal title");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Save failed", { exact: true }).waitFor();
    assert.equal(await title(page).getAttribute("aria-label"), "Shared saved");
    assert.equal(personal.has("alice"), false);

    // A stale request completing after newer readback cannot revert the header.
    let release;
    delayedHeader = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await new Promise(resolve => setTimeout(resolve, 50));
    shared = { ...shared, site_name: "Latest shared", site_name_style: { ...style, mytitle: { ...defaultDesign, name: "Latest shared" } } };
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expectTitle(page, "Latest shared");
    release();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(await title(page).getAttribute("aria-label"), "Latest shared");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
