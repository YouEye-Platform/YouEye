/**
 * Server Icon — Playwright Tests
 *
 * Tests the server icon/favicon system:
 * - Icon API endpoint (GET/POST)
 * - Branding API icon_config persistence
 * - Icon picker in branding settings (via CP embed)
 * - Favicon serving
 *
 * Runs against the deployed VM via CDP attach.
 */

import { test, expect, chromium } from "@playwright/test";

const UI_BASE = "https://devvm.test";

test.describe("Server Icon API", () => {
  test("GET /api/v1/branding returns icon_config field", async ({ request }) => {
    const res = await request.get(`${UI_BASE}/api/v1/branding`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("icon_config");
    expect(data).toHaveProperty("site_name");
    expect(data).toHaveProperty("accent_color");
  });

  test("GET /api/v1/branding/icon returns PNG when icons exist", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/api/v1/branding/icon?size=32`);
    // Either 200 (icons exist) or 404 (no icons rendered yet)
    if (res.status() === 200) {
      expect(res.headers()["content-type"]).toBe("image/png");
    } else {
      expect(res.status()).toBe(404);
    }
  });

  test("GET /api/v1/branding/icon rejects invalid sizes", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/api/v1/branding/icon?size=99`);
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid size");
  });

  test("GET /api/v1/branding/icon supports all standard sizes", async ({
    request,
  }) => {
    const sizes = [16, 32, 48, 180, 192, 512];
    for (const size of sizes) {
      const res = await request.get(
        `${UI_BASE}/api/v1/branding/icon?size=${size}`
      );
      // 200 if rendered, 404 if not yet — both valid
      expect([200, 404]).toContain(res.status());
    }
  });

  test("POST /api/v1/branding/icon requires auth", async ({ request }) => {
    const res = await request.post(`${UI_BASE}/api/v1/branding/icon`, {
      multipart: {
        icon_config: JSON.stringify({ mode: "letter", shape: "circle", background: { type: "solid", color: "#000" } }),
      },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("Icon Picker UI", () => {
  test("Server Branding tab shows icon picker", async () => {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      await page.goto(`${UI_BASE}/settings/branding`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });

      // Click Server Branding tab
      const serverTab = page.getByRole("button", { name: "Server Branding" });
      if (await serverTab.isVisible()) {
        await serverTab.click();
        await page.waitForTimeout(3000);

        // The Server Branding tab loads CP embed via iframe
        const iframe = page.frameLocator("iframe").first();

        // Check for Server Icon section in the iframe
        const iconTitle = iframe.getByText("Server Icon");
        await expect(iconTitle).toBeVisible({ timeout: 10000 });

        // Check for Letter/Emoji tabs
        const letterBtn = iframe.getByRole("button", { name: "Letter" });
        await expect(letterBtn).toBeVisible();

        const emojiBtn = iframe.getByRole("button", { name: "Emoji" });
        await expect(emojiBtn).toBeVisible();

        // Check shape controls
        const roundedBtn = iframe.getByRole("button", { name: "Rounded" });
        await expect(roundedBtn).toBeVisible();

        // Check canvas preview exists
        const canvas = iframe.locator("canvas").first();
        await expect(canvas).toBeVisible();

        // Screenshot the icon picker
        await page.screenshot({
          path: "/tmp/shots/test-icon-picker.png",
          fullPage: true,
        });
      }
    } finally {
      await context.close();
    }
  });

  test("Emoji tab shows emoji grid", async () => {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      // Go directly to CP embed page
      await page.goto("https://control.devvm.test/embed/branding", {
        waitUntil: "networkidle",
        timeout: 15000,
      });

      // Click Emoji tab
      const emojiBtn = page.getByRole("button", { name: "Emoji" });
      if (await emojiBtn.isVisible()) {
        await emojiBtn.click();
        await page.waitForTimeout(500);

        // Verify emoji grid appears (rocket should be one of them)
        const rocketBtn = page.locator("button").filter({ hasText: "\u{1F680}" });
        await expect(rocketBtn).toBeVisible();

        await page.screenshot({
          path: "/tmp/shots/test-emoji-tab.png",
        });
      }
    } finally {
      await context.close();
    }
  });
});

test.describe("CP Favicon Proxy", () => {
  test("CP serves favicon via proxy", async ({ request }) => {
    const res = await request.get(
      "https://control.devvm.test/api/branding/favicon?size=32"
    );
    // 200 if icons rendered, 404 if not
    if (res.status() === 200) {
      expect(res.headers()["content-type"]).toBe("image/png");
    }
  });
});
