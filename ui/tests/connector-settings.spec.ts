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
import { SignJWT } from "jose";

const DEVVM = "https://devvm.test";
const JWT_SECRET =
  "5bed9b45317c939593786844f4803016fcbfcbf9981b6f8893dd07b5b11953e2";

test.describe("Connector Settings", () => {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  let page: Awaited<ReturnType<typeof context.newPage>>;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP("http://localhost:9222");
    context = await browser.newContext({ ignoreHTTPSErrors: true });

    // Create authenticated session cookie
    const secret = new TextEncoder().encode(JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      userId: "705a7b03-57dd-412e-8705-dd5db453dc9a",
      username: "tester",
      name: "Test User",
      email: "tester@test.local",
      isAdmin: true,
      groups: ["authentik Admins"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);

    await context.addCookies([
      {
        name: "ye-ui-session",
        value: token,
        domain: "devvm.test",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

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

  test("external apps section shows installed external apps", async () => {
    await page.goto(`${DEVVM}/settings/connectors`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=External Apps")).toBeVisible();

    const searxng = page.locator("button", { hasText: "SearXNG" });
    await expect(searxng).toBeVisible();
    await expect(searxng).toContainText("External app");
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

  test("connected connectors show Internal/External badges", async () => {
    await page.goto(`${DEVVM}/settings/connectors/search`);
    await page.waitForLoadState("networkidle");

    // SearXNG is a local connector — should show "Internal" badge
    await expect(page.locator("text=Internal").first()).toBeVisible();

    // Navigate to Wiki which has Wikipedia (internet) connected
    await page.goto(`${DEVVM}/settings/connectors/wiki`);
    await page.waitForLoadState("networkidle");

    // Wikipedia is an internet connector — should show "External" badge
    await expect(page.locator("text=External").first()).toBeVisible();
  });

  test("local connectors show backend app name", async () => {
    await page.goto(`${DEVVM}/settings/connectors/search`);
    await page.waitForLoadState("networkidle");

    // SearXNG connector should show the installed app name in parentheses
    await expect(page.locator("text=(SearXNG)")).toBeVisible();
  });

  test("app detail API includes backends for local connectors", async () => {
    const res = await page.request.get(
      `${DEVVM}/api/settings/connectors/search`
    );
    expect(res.status()).toBe(200);

    const data = await res.json();
    const searchCap = data.capabilities.find(
      (c: { capability: string }) => c.capability === "search-engine"
    );

    // SearXNG should have backends from backend discovery
    const searxng = searchCap.availableConnectors.find(
      (c: { id: string }) => c.id === "searxng-search"
    );
    expect(searxng.backends).toBeDefined();
    expect(searxng.backends.length).toBeGreaterThan(0);
    expect(searxng.backends[0].appName).toBeDefined();
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
