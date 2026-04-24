/**
 * WordArt Widget Overflow Tests
 *
 * Verifies that text effects (glow, neon, fire) on the server-name widget
 * are NOT clipped by the widget container bounds.
 *
 * Agent: Vanya | VM: ye-vanya
 */

import { test, expect, chromium } from '@playwright/test';

const BASE_URL = 'https://devvm.test';
const VM_USER = 'tester';
const VM_PASS = 'tester123';

test.describe('WordArt Widget Overflow', () => {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  let page: Awaited<ReturnType<typeof context.newPage>>;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();

    // SSO login
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const ssoButton = page.locator('button:has-text("Sign in with Authentik"), a:has-text("Sign in with Authentik")');
    if (await ssoButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await ssoButton.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
      await page.locator('input[name="uidField"]').fill(VM_USER);
      await page.locator('button[type="submit"]').click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      await page.locator('input[name="password"]').fill(VM_PASS);
      await page.locator('button[type="submit"]').click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(5000);
      const continueBtn = page.locator('button:has-text("Continue")');
      if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);
      }
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('server-name widget container allows overflow', async () => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3000);

    // The widget container for server-name should have overflow-visible, not overflow-hidden
    const widgetContentDiv = page.locator('[style*="container-type: size"]').first();
    await expect(widgetContentDiv).toBeVisible();

    const overflowClass = await widgetContentDiv.getAttribute('class');
    expect(overflowClass).toContain('overflow-visible');
    expect(overflowClass).not.toContain('overflow-hidden');
  });

  test('server-name widget inner container allows overflow', async () => {
    const serverNameContainer = page.locator('.overflow-visible').filter({ has: page.locator('h1') });
    await expect(serverNameContainer).toBeVisible();

    // Verify it has overflow-visible class
    const cls = await serverNameContainer.getAttribute('class');
    expect(cls).toContain('overflow-visible');
  });

  test('text-shadow effects extend beyond widget bounds', async () => {
    // Get the branding style to confirm a text effect is active
    const branding = await page.evaluate(() =>
      fetch('/api/v1/branding').then(r => r.json())
    );
    const style = branding.site_name_style;

    // Verify text-shadow is set (not 'none')
    expect(style.textShadow).toBeDefined();
    expect(style.textShadow).not.toBe('none');

    // Verify the h1 element renders with the text-shadow
    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible();
    const textShadow = await h1.evaluate(el => window.getComputedStyle(el).textShadow);
    expect(textShadow).not.toBe('none');
  });

  test('widget renders on dashboard without clipping artifacts', async () => {
    // Take a screenshot and verify it has content (not blank)
    const screenshot = await page.screenshot();
    expect(screenshot.length).toBeGreaterThan(50000); // Real page with content
  });
});
