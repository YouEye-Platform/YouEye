/**
 * System Dashboard Tests — Vanya v0.3.4.5 / CP v0.3.6.5
 *
 * Tests the redesigned system page with live graphs and merged container task manager.
 * Connects to the persistent browser via CDP (no headless launch).
 */

import { test, expect, chromium } from "@playwright/test";

test.describe("System Dashboard with Graphs + Container Task Manager", () => {
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

  test("system page loads with CPU, Memory, Disk cards", async () => {
    await page.goto("https://vanyavm.test/settings/system");
    await page.waitForTimeout(3000);

    // The system embed should contain the three metric cards
    const iframe = page.frameLocator("iframe");
    await expect(iframe.locator("text=CPU")).toBeVisible({ timeout: 15000 });
    await expect(iframe.locator("text=Memory")).toBeVisible();
    await expect(iframe.locator("text=Disk")).toBeVisible();
  });

  test("system page shows auto-refresh indicator", async () => {
    const iframe = page.frameLocator("iframe");
    await expect(iframe.locator("text=Auto-refresh 5s")).toBeVisible({ timeout: 10000 });
  });

  test("system page shows hostname and OS info", async () => {
    const iframe = page.frameLocator("iframe");
    await expect(iframe.locator("text=ye-vanya")).toBeVisible({ timeout: 10000 });
    await expect(iframe.locator("text=Ubuntu")).toBeVisible();
  });

  test("system page shows kernel and incus info bar", async () => {
    const iframe = page.frameLocator("iframe");
    await expect(iframe.locator("text=Kernel")).toBeVisible({ timeout: 10000 });
    await expect(iframe.locator("text=Incus")).toBeVisible();
    await expect(iframe.locator("text=running")).toBeVisible();
  });

  test("container task manager section is visible", async () => {
    const iframe = page.frameLocator("iframe");
    await expect(iframe.locator("text=Containers")).toBeVisible({ timeout: 10000 });
    await expect(iframe.locator("text=Resource usage per container")).toBeVisible();
  });

  test("container table shows all 10 containers", async () => {
    const iframe = page.frameLocator("iframe");
    // Table should have header + 10 data rows
    const rows = iframe.locator("table tbody tr");
    await expect(rows).toHaveCount(10, { timeout: 15000 });
  });

  test("containers show memory and disk stats", async () => {
    const iframe = page.frameLocator("iframe");
    // youeye-control should show memory usage
    const controlRow = iframe.locator("tr", { hasText: "youeye-control" });
    await expect(controlRow).toBeVisible({ timeout: 10000 });
    // Should contain MB text for memory
    await expect(controlRow.locator("text=/\\d+ MB/")).toBeVisible();
  });

  test("containers have Stop and Restart action buttons", async () => {
    const iframe = page.frameLocator("iframe");
    // Running containers should have Stop and Restart buttons
    const stopButtons = iframe.locator("button", { hasText: "Stop" });
    const restartButtons = iframe.locator("button", { hasText: "Restart" });
    expect(await stopButtons.count()).toBeGreaterThan(0);
    expect(await restartButtons.count()).toBeGreaterThan(0);
  });

  test("SVG area charts are rendered for metrics", async () => {
    const iframe = page.frameLocator("iframe");
    // After a few seconds, SVG charts should be present
    await page.waitForTimeout(6000);
    const svgs = iframe.locator("svg");
    expect(await svgs.count()).toBeGreaterThanOrEqual(3);
  });

  test("containers sidebar nav item is removed", async () => {
    // The sidebar should NOT have a "Containers" link
    const containersLink = page.locator('a[href="/settings/containers"]');
    await expect(containersLink).toHaveCount(0);
  });
});
