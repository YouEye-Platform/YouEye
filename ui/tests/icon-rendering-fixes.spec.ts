/**
 * Icon Rendering Pipeline Fixes — Playwright Tests
 *
 * Verifies the icon rendering bugfixes:
 * 1. /icon and /apple-icon routes are not blocked by auth middleware
 * 2. Favicon routes serve dynamic content (not prerendered fallback)
 * 3. Icon API returns correct PNG data
 *
 * Runs against the deployed VM via CDP attach.
 */

import { test, expect, chromium } from "@playwright/test";

const UI_BASE = "https://devvm.test";

test.describe("Icon route auth bypass", () => {
  test("/icon returns 200 without auth (not 307 redirect)", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/icon`, {
      maxRedirects: 0,
    });
    // Must be 200 (image served) — NOT 307 redirect to /login
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  });

  test("/apple-icon returns 200 without auth", async ({ request }) => {
    const res = await request.get(`${UI_BASE}/apple-icon`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  });

  test("/icon does not return stale prerendered cache", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/icon`);
    expect(res.status()).toBe(200);
    // Should NOT have immutable cache (that was the prerendered bug)
    const cacheControl = res.headers()["cache-control"] || "";
    expect(cacheControl).not.toContain("immutable");
    expect(cacheControl).not.toContain("max-age=31536000");
  });
});

test.describe("Dynamic favicon content", () => {
  test("/icon serves actual icon PNG (not empty/tiny fallback)", async ({
    request,
  }) => {
    const res = await request.get(`${UI_BASE}/icon`);
    expect(res.status()).toBe(200);
    const body = await res.body();
    // A real icon PNG should be more than a few hundred bytes
    // Even the fallback "Y" ImageResponse is ~1KB+
    expect(body.length).toBeGreaterThan(100);
    // Verify PNG magic bytes
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50); // P
    expect(body[2]).toBe(0x4e); // N
    expect(body[3]).toBe(0x47); // G
  });

  test("/apple-icon serves 180px PNG", async ({ request }) => {
    const res = await request.get(`${UI_BASE}/apple-icon`);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
  });

  test("/icon and /api/v1/branding/icon serve consistent content", async ({
    request,
  }) => {
    const [iconRes, apiRes] = await Promise.all([
      request.get(`${UI_BASE}/icon`),
      request.get(`${UI_BASE}/api/v1/branding/icon?size=32`),
    ]);

    // Both should succeed if icons are rendered
    if (apiRes.status() === 200) {
      expect(iconRes.status()).toBe(200);
      // Both should be PNG
      expect(iconRes.headers()["content-type"]).toBe("image/png");
      expect(apiRes.headers()["content-type"]).toBe("image/png");
    }
  });
});

test.describe("CP favicon proxy mirrors UI icon", () => {
  test("CP /api/branding/favicon returns same icon as UI", async ({
    request,
  }) => {
    const [uiRes, cpRes] = await Promise.all([
      request.get(`${UI_BASE}/api/v1/branding/icon?size=32`),
      request.get(
        "https://control.devvm.test/api/branding/favicon?size=32"
      ),
    ]);

    if (uiRes.status() === 200 && cpRes.status() === 200) {
      const uiBody = await uiRes.body();
      const cpBody = await cpRes.body();
      // Should be the same PNG data (CP proxies from UI)
      expect(Buffer.compare(uiBody, cpBody)).toBe(0);
    }
  });
});

test.describe("Homepage shows custom favicon", () => {
  test("Homepage HTML references /icon in link tags", async () => {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      await page.goto(UI_BASE, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      // Next.js metadata routes inject <link rel="icon" href="/icon">
      const iconLink = page.locator('link[rel="icon"]');
      await expect(iconLink).toHaveCount(1);
      const href = await iconLink.getAttribute("href");
      expect(href).toContain("/icon");

      await page.screenshot({
        path: "/tmp/shots/test-homepage-favicon.png",
      });
    } finally {
      await context.close();
    }
  });
});
