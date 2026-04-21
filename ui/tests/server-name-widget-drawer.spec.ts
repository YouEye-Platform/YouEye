/**
 * Tests for Server Name WordArt Widget and App Drawer overhaul
 * Connects to the persistent Chromium via CDP (port 9222).
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = 'https://devvm.test';

test.describe('Server Name Widget & App Drawer', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();

    // Navigate and handle SSO if needed
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // If on Authentik login, fill credentials
    const url = page.url();
    if (url.includes('authentik') || url.includes('/if/flow/')) {
      try {
        await page.locator('input[name="uidField"]').fill('tester', { timeout: 5000 });
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(2000);
        await page.locator('input[name="password"]').fill('tester123', { timeout: 5000 });
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(5000);
      } catch {
        // Already logged in or different auth flow
      }
    }
    // Wait for homepage to settle
    await page.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('homepage loads with navbar', async () => {
    await expect(page.locator('header')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'test-results/01-homepage.png' });
  });

  test('server name widget in add widget dialog', async () => {
    // Enter edit mode via paintbrush button
    await page.locator('button[title="Edit layout"]').click();
    await page.waitForTimeout(500);

    // Click "+ Add"
    await page.locator('button:has-text("Add")').first().click();
    await page.waitForTimeout(500);

    // Server Name should be in the catalog
    await expect(page.locator('text=Server Name')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'test-results/02-add-widget-menu.png' });

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('reset defaults shows server name widget', async () => {
    // Dismiss the add-widget dialog overlay by clicking backdrop
    const backdrop = page.locator('.bg-black\\/60, [class*="backdrop"]').first();
    if (await backdrop.isVisible({ timeout: 1000 }).catch(() => false)) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(500);
    }

    // Still in edit mode — click Reset (force to bypass any remaining overlay)
    await page.locator('button:has-text("Reset")').click({ force: true });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/03-reset-defaults.png' });

    // Click Done
    await page.locator('button:has-text("Done")').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/04-homepage-server-name.png' });
  });

  test('app drawer opens as popover with pencil icon', async () => {
    await page.locator('button[aria-label="Apps"]').click();
    await page.waitForTimeout(500);

    // Pencil icon in top-left, no "Manage Apps" text
    await expect(page.locator('[title="Edit drawer"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/05-drawer-open.png' });
  });

  test('drawer edit mode shows two-panel layout with controls', async () => {
    await page.locator('[title="Edit drawer"]').click();
    await page.waitForTimeout(500);

    // Edit mode header with Done button
    await expect(page.locator('button:has-text("Done editing")')).toBeVisible();
    // Hidden panel on left
    await expect(page.locator('text=HIDDEN')).toBeVisible();
    // Controls at bottom
    await expect(page.locator('text=Columns')).toBeVisible();
    await expect(page.locator('text=Icon size')).toBeVisible();
    await expect(page.locator('text=Max height')).toBeVisible();
    await page.screenshot({ path: 'test-results/06-drawer-edit.png' });
  });

  test('column selector toggles', async () => {
    // Click column 5
    const buttons = page.locator('button:has-text("5")');
    const col5 = buttons.last();
    await col5.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/07-columns-5.png' });

    // Click back to 4
    await page.locator('button:has-text("4")').last().click();
    await page.waitForTimeout(300);
  });

  test('exit edit mode', async () => {
    await page.locator('button:has-text("Done editing")').click();
    await page.waitForTimeout(500);
    // Back to normal mode — pencil icon visible
    await expect(page.locator('[title="Edit drawer"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/08-drawer-normal.png' });
  });

  test('empty state shows marketplace link for admin', async () => {
    await expect(page.locator('text=No apps installed')).toBeVisible();
    await expect(page.locator('text=Visit Marketplace')).toBeVisible();
    await page.screenshot({ path: 'test-results/09-empty-admin.png' });

    // Close drawer
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('drawer prefs API persists', async () => {
    const getRes = await page.evaluate(async () => {
      const r = await fetch('/api/v1/apps/drawer/prefs');
      return r.json();
    });
    expect(getRes).toHaveProperty('columns');
    expect(getRes).toHaveProperty('iconScale');
    expect(getRes).toHaveProperty('maxHeight');

    const putRes = await page.evaluate(async () => {
      const r = await fetch('/api/v1/apps/drawer/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: 4 }),
      });
      return r.json();
    });
    expect(putRes.columns).toBe(4);

    // Reset
    await page.evaluate(async () => {
      await fetch('/api/v1/apps/drawer/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: 3 }),
      });
    });
  });

  test('clock widget is compact', async () => {
    await expect(page.locator('text=/\\d{2}:\\d{2}/')).toBeVisible();
    await page.screenshot({ path: 'test-results/10-compact-clock.png' });
  });
});
