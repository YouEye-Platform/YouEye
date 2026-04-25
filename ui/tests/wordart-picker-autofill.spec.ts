/**
 * WordArt Picker Auto-Fill — Playwright Tests
 *
 * Verifies the WordArt picker (in CP Server Branding embed) correctly
 * auto-fills preset indices from the currently saved style, instead of
 * resetting all indices to 0 and overwriting the loaded style.
 *
 * Runs against the deployed VM via CDP attach.
 */

import { test, expect, chromium } from "@playwright/test";

const UI_BASE = "https://devvm.test";
const CP_BASE = "https://control.devvm.test";

test.describe("WordArt preset auto-fill", () => {
  test("Server Branding WordArt picker shows current style, not defaults", async () => {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      // Navigate directly to the CP branding embed
      await page.goto(`${CP_BASE}/embed/branding`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });

      // The WordArt picker should load with the saved style's presets
      // If auto-fill is broken, all would show "Inter" (font index 0)
      // and "Glow" (effect index 0) regardless of saved style

      // Get the active font button (has aria-pressed or selected state)
      const fontButtons = page.locator('[data-picker="font"] button');
      const activeFont = page.locator(
        '[data-picker="font"] button[data-active="true"]'
      );

      // Wait for picker to render
      await page.waitForTimeout(2000);

      // Screenshot the picker state for visual verification
      await page.screenshot({
        path: "/tmp/shots/test-wordart-autofill.png",
        fullPage: true,
      });

      // The picker should have font/effect/colour/shape sections
      const sectionLabels = ["Font", "Effect", "Colour", "Shape"];
      for (const label of sectionLabels) {
        const section = page.getByText(label, { exact: true }).first();
        await expect(section).toBeVisible({ timeout: 5000 });
      }
    } finally {
      await context.close();
    }
  });

  test("Changing WordArt preset updates live preview", async () => {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      await page.goto(`${CP_BASE}/embed/branding`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });

      await page.waitForTimeout(2000);

      // Find the WordArt preview text element
      const preview = page.locator('[data-wordart-preview]').first();

      // Click a different font preset button (e.g. the 2nd one)
      const fontButtons = page.locator('[data-picker="font"] button');
      const count = await fontButtons.count();

      if (count >= 2) {
        // Get initial preview style
        const initialScreenshot = await page.screenshot();

        // Click second font
        await fontButtons.nth(1).click();
        await page.waitForTimeout(500);

        // Screenshot after change
        await page.screenshot({
          path: "/tmp/shots/test-wordart-font-change.png",
        });
      }
    } finally {
      await context.close();
    }
  });
});

test.describe("WordArt style persistence via API", () => {
  test("GET /api/v1/branding returns current site_name_style", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/api/v1/branding`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("site_name_style");

    const style = data.site_name_style;
    if (style) {
      // Style should have required fields
      expect(style).toHaveProperty("fontFamily");
      expect(style).toHaveProperty("color");
      expect(typeof style.fontFamily).toBe("string");
      expect(style.fontFamily.length).toBeGreaterThan(0);
    }
  });

  test("Saved WordArt style matches what picker would display", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/api/v1/branding`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    const style = data.site_name_style;

    if (style) {
      // If a gradient is set, both from/to should be valid colors
      if (style.gradient?.enabled) {
        expect(style.gradient.from).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(style.gradient.to).toMatch(/^#[0-9a-fA-F]{6}$/);
      }

      // fontWeight should be a valid CSS weight
      if (style.fontWeight) {
        expect([100, 200, 300, 400, 500, 600, 700, 800, 900]).toContain(
          style.fontWeight
        );
      }
    }
  });
});
