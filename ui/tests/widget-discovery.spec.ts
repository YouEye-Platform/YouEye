/**
 * Widget Auto-Discovery Tests
 *
 * Verifies that native app widgets are auto-discovered from running
 * containers and appear in the Add Widget dialog.
 */
import { test, expect, chromium } from "@playwright/test";

test.describe("Widget Auto-Discovery", () => {
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

  test("widget API returns discovered app widgets", async () => {
    await page.goto("https://sebvm.test");
    await page.waitForLoadState("networkidle");

    const response = await page.evaluate(() =>
      fetch("/api/v1/apps/widgets")
        .then((r) => r.json())
        .catch(() => null)
    );

    expect(response).toBeTruthy();
    expect(response.widgets).toBeDefined();
    expect(response.widgets.length).toBeGreaterThanOrEqual(6);

    // Verify expected apps have widgets
    const appIds = [...new Set(response.widgets.map((w: { app_id: string }) => w.app_id))];
    expect(appIds).toContain("wiki");
    expect(appIds).toContain("weather");
    expect(appIds).toContain("cinema");
    expect(appIds).toContain("translate");
    expect(appIds).toContain("search");
    expect(appIds).toContain("notes");
  });

  test("widget picker shows app tabs when in edit mode", async () => {
    await page.goto("https://sebvm.test");
    await page.waitForLoadState("networkidle");

    // Enter edit mode — click the edit toggle (pencil/paintbrush icon)
    const editButton = page.locator('button[title*="Edit"], button[title*="edit"], [data-testid="edit-mode-toggle"]');
    if (await editButton.count() > 0) {
      await editButton.first().click();
    } else {
      // Fallback: find by aria or text
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll("button")];
        const editBtn = btns.find((b) => b.querySelector("svg") && b.closest("[class*='edit']"));
        editBtn?.click();
      });
    }

    await page.waitForTimeout(1000);

    // Click Add button
    const addButton = page.locator('button:has-text("Add")').first();
    await expect(addButton).toBeVisible({ timeout: 5000 });
    await addButton.click();

    // Verify Add Widget dialog is open
    await expect(page.locator('text="Add Widget"')).toBeVisible({ timeout: 5000 });

    // Verify app tabs are present
    const expectedTabs = ["Built-in", "Wiki", "Notes", "Translate", "Cinema", "Search", "Weather"];
    for (const tab of expectedTabs) {
      await expect(
        page.locator(`button:has-text("${tab}")`)
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test("clicking an app tab shows its widgets", async () => {
    // Dialog should still be open from previous test
    // Click the Wiki tab
    await page.locator('button:has-text("Wiki")').click();
    await page.waitForTimeout(500);

    // Verify wiki widgets are shown
    await expect(page.locator('text="Featured Article"')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text="Today in History"')).toBeVisible({ timeout: 5000 });

    // Click Weather tab
    await page.locator('button:has-text("Weather")').click();
    await page.waitForTimeout(500);

    await expect(page.locator('text="Current Weather"')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text="Weather Forecast"')).toBeVisible({ timeout: 5000 });

    // Close the dialog
    await page.locator('button:has(svg.lucide-x)').first().click();
  });

  test("each widget has required fields from manifest", async () => {
    const response = await page.evaluate(() =>
      fetch("/api/v1/apps/widgets")
        .then((r) => r.json())
        .catch(() => null)
    );

    for (const widget of response.widgets) {
      expect(widget.id).toBeTruthy();
      expect(widget.app_id).toBeTruthy();
      expect(widget.app_name).toBeTruthy();
      expect(widget.widget_id).toBeTruthy();
      expect(widget.name).toBeTruthy();
      expect(widget.description).toBeTruthy();
      expect(widget.default_size).toBeDefined();
      expect(widget.default_size.width).toBeGreaterThan(0);
      expect(widget.default_size.height).toBeGreaterThan(0);
    }
  });
});
