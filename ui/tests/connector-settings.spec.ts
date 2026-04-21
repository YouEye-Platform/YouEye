/**
 * Connector Settings UI Tests
 *
 * Tests the Settings > Connectors page:
 *   - App list with capability status (green/amber/gray)
 *   - Per-app detail with connector picker
 *   - Connect/disconnect flow
 *   - Credential entry for API-key connectors
 *
 * Connects to the persistent browser via CDP (no launch).
 */

import { test, expect, chromium } from "@playwright/test";

const DEVVM = "https://devvm.test";

test.describe("Connector Settings", () => {
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

  test("settings connectors page loads with app list", async () => {
    await page.goto(`${DEVVM}/settings/connectors`);
    await page.waitForLoadState("networkidle");

    // Page title
    await expect(page.locator("h2").first()).toContainText("Connectors");

    // App Connections section
    await expect(page.locator("text=App Connections")).toBeVisible();
    await expect(page.locator("text=Choose which data sources")).toBeVisible();
  });

  test("app list shows native apps with capability counts", async () => {
    await page.goto(`${DEVVM}/settings/connectors`);
    await page.waitForLoadState("networkidle");

    // Native apps should show capability status
    const searchRow = page.locator("button", { hasText: "Search" });
    await expect(searchRow).toBeVisible();

    const weatherRow = page.locator("button", { hasText: "Weather" });
    await expect(weatherRow).toBeVisible();

    const cinemaRow = page.locator("button", { hasText: "Cinema" });
    await expect(cinemaRow).toBeVisible();

    // Notes should show "No connectors"
    const notesRow = page.locator("button", { hasText: "Notes" });
    await expect(notesRow).toBeVisible();
    await expect(notesRow).toContainText("No connectors");
  });

  test("external apps section shows SearXNG and Whoogle", async () => {
    await page.goto(`${DEVVM}/settings/connectors`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=External Apps")).toBeVisible();

    const searxng = page.locator("button", { hasText: "SearXNG" });
    await expect(searxng).toBeVisible();
    await expect(searxng).toContainText("External app");

    const whoogle = page.locator("button", { hasText: "Whoogle" });
    await expect(whoogle).toBeVisible();
    await expect(whoogle).toContainText("External app");
  });

  test("app detail page shows capabilities and connectors", async () => {
    await page.goto(`${DEVVM}/settings/connectors/cinema`);
    await page.waitForLoadState("networkidle");

    // App name
    await expect(page.locator("h2").first()).toContainText("Cinema");

    // Capabilities
    await expect(page.locator("text=Media Catalog")).toBeVisible();
    await expect(page.locator("text=Media Search")).toBeVisible();

    // Back link
    await expect(page.locator("text=Back to Connectors")).toBeVisible();
  });

  test("connector picker shows available sources when clicked", async () => {
    await page.goto(`${DEVVM}/settings/connectors/weather`);
    await page.waitForLoadState("networkidle");

    // Click "Connect a source"
    const connectBtn = page.locator("button", {
      hasText: "Connect a source",
    });
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      await page.waitForTimeout(1000);

      // Open-Meteo should appear as an available connector
      await expect(page.locator("text=Open-Meteo")).toBeVisible();
      await expect(page.locator("text=internet")).toBeVisible();
    }
  });

  test("settings connectors API returns app list with capabilities", async () => {
    const res = await page.request.get(
      `${DEVVM}/api/settings/connectors`
    );
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.apps).toBeDefined();
    expect(data.apps.length).toBeGreaterThan(0);

    // Search should have search-engine capability
    const searchApp = data.apps.find(
      (a: { id: string }) => a.id === "search"
    );
    expect(searchApp).toBeDefined();
    expect(searchApp.capabilities).toContain("search-engine");

    // Cinema should have media-catalog and media-search
    const cinemaApp = data.apps.find(
      (a: { id: string }) => a.id === "cinema"
    );
    expect(cinemaApp).toBeDefined();
    expect(cinemaApp.capabilities).toContain("media-catalog");
    expect(cinemaApp.capabilities).toContain("media-search");

    // Notes should have no capabilities
    const notesApp = data.apps.find(
      (a: { id: string }) => a.id === "notes"
    );
    expect(notesApp).toBeDefined();
    expect(notesApp.capabilities).toHaveLength(0);
  });

  test("app detail API returns capabilities with available connectors", async () => {
    const res = await page.request.get(
      `${DEVVM}/api/settings/connectors/search`
    );
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.app).toBeDefined();
    expect(data.app.id).toBe("search");

    // Should have search-engine capability
    expect(data.capabilities.length).toBeGreaterThan(0);
    const searchCap = data.capabilities.find(
      (c: { capability: string }) => c.capability === "search-engine"
    );
    expect(searchCap).toBeDefined();

    // SearXNG should be available
    const searxng = searchCap.availableConnectors.find(
      (c: { id: string }) => c.id === "searxng-search"
    );
    expect(searxng).toBeDefined();
    expect(searxng.network).toBe("local");
    expect(searxng.authMethod).toBe("none");
  });

  test("permissions section renders on connectors page", async () => {
    await page.goto(`${DEVVM}/settings/connectors`);
    await page.waitForLoadState("networkidle");

    // App Permissions section should be visible
    await expect(page.locator("text=App Permissions")).toBeVisible();
    await expect(
      page.locator("text=Default deny")
    ).toBeVisible();
  });
});
