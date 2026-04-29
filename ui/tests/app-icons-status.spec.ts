/**
 * App Icons & Status Tests — Vanya v0.3.4.5
 *
 * Tests that app icons use neutral backgrounds (no colored category backgrounds)
 * and that installed apps show correct running status instead of "unknown".
 */

import { test, expect, chromium } from "@playwright/test";

test.describe("App Icons and Status Display", () => {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  let page: Awaited<ReturnType<typeof context.newPage>>;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP("http://localhost:9222");
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("apps page loads with installed apps section", async () => {
    await page.goto("https://vanyavm.test/settings/apps");
    await page.waitForTimeout(3000);
    await expect(page.locator("text=Installed Apps")).toBeVisible({ timeout: 15000 });
  });

  test("installed apps show running status, not unknown", async () => {
    // Look for "running" badges in the installed apps section
    const runningBadges = page.locator("text=running");
    expect(await runningBadges.count()).toBeGreaterThan(0);

    // There should be no "unknown" badges visible
    const unknownBadges = page.locator("span", { hasText: /^unknown$/ });
    await expect(unknownBadges).toHaveCount(0);
  });

  test("app icons use neutral backgrounds, not colored", async () => {
    // All icon containers should use bg-muted/50 (neutral), not category colors
    // Check that no violet, sky, or emerald backgrounds exist on icon divs
    const iconDivs = page.locator(
      '.bg-violet-100, .bg-sky-100, .bg-emerald-100, [class*="bg-violet"], [class*="bg-sky-100"], [class*="bg-emerald-100"]'
    );
    await expect(iconDivs).toHaveCount(0);
  });

  test("system components section loads for admin", async () => {
    await expect(page.locator("text=System Components")).toBeVisible({ timeout: 10000 });
    // Should show system components like Spine, CP, etc.
    await expect(page.locator("text=Spine")).toBeVisible();
    await expect(page.locator("text=Control Panel")).toBeVisible();
  });

  test("system components show running status", async () => {
    // System components should all show "running"
    const spineRow = page.locator("button", { hasText: "Spine" });
    await expect(spineRow).toBeVisible({ timeout: 10000 });
    // The row containing Spine should have a "running" badge nearby
    const spineParent = spineRow.locator("..");
    await expect(spineParent.locator("text=running")).toBeVisible();
  });
});
