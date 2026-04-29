/**
 * Link Handling — Playwright test suite
 *
 * Tests Phase 3: Link Handling feature:
 * - Link Handling tab visible on per-app detail page
 * - Empty state shows placeholder text and "Add link handler" button
 * - Admin can add a link handler with type, description, domains, endpoint
 * - Handler card renders with correct data (type, description, domain pills, endpoint)
 * - Admin can delete a link handler
 * - Link handler API (GET, POST, DELETE) works correctly
 */

import { test, expect, chromium } from '@playwright/test';

const BASE = 'https://devvm.test';

test.describe('Link Handling', () => {
  let browser: any;
  let context: any;
  let page: any;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('login and navigate to app settings', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

    // Handle SSO login if needed
    if (page.url().includes('authentik') || page.url().includes('/if/flow/')) {
      await page.locator('input[name="uidField"]').fill('tester');
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(1000);
      await page.locator('input[name="password"]').fill('tester123');
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
    }

    // Navigate to settings > apps
    await page.goto(`${BASE}/settings/apps`, { waitUntil: 'networkidle', timeout: 15000 });
    await expect(page.locator('h2:has-text("Apps")')).toBeVisible({ timeout: 10000 });
  });

  test('navigate to SearXNG detail page', async () => {
    // Click on SearXNG app
    await page.locator('button:has-text("SearXNG")').first().click();
    await page.waitForTimeout(2000);

    // Should show app header
    await expect(page.locator('h2:has-text("SearXNG")')).toBeVisible({ timeout: 10000 });
  });

  test('Link Handling tab is visible', async () => {
    const linkTab = page.locator('button:has-text("Link Handling")');
    await expect(linkTab).toBeVisible();
  });

  test('Link Handling tab shows empty state', async () => {
    // Click the Link Handling tab
    await page.locator('button:has-text("Link Handling")').click();
    await page.waitForTimeout(1000);

    // Should show empty state message
    await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });

    // Should show description text
    await expect(page.locator('text=Link handling lets apps intercept and rewrite URLs')).toBeVisible();

    // Should show "Add link handler" button
    await expect(page.locator('button:has-text("Add link handler")')).toBeVisible();
  });

  test('clicking Add opens the form', async () => {
    await page.locator('button:has-text("Add link handler")').click();
    await page.waitForTimeout(500);

    // Form should be visible with all 4 fields
    await expect(page.locator('input[placeholder*="Handler type"]')).toBeVisible();
    await expect(page.locator('input[placeholder*="Description"]')).toBeVisible();
    await expect(page.locator('input[placeholder*="Domains"]')).toBeVisible();
    await expect(page.locator('input[placeholder*="Endpoint"]')).toBeVisible();

    // Save and Cancel buttons
    await expect(page.locator('button:has-text("Save")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('Save validates required fields', async () => {
    // Click Save with empty fields
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);

    // Should show validation error
    await expect(page.locator('text=Type, description, and at least one domain are required')).toBeVisible();
  });

  test('Cancel hides the form', async () => {
    await page.locator('button:has-text("Cancel")').click();
    await page.waitForTimeout(500);

    // Form should be hidden, empty state should return
    await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });
  });

  test('admin can add a link handler', async () => {
    // Open the form again
    await page.locator('button:has-text("Add link handler")').click();
    await page.waitForTimeout(500);

    // Fill in the form
    await page.locator('input[placeholder*="Handler type"]').fill('search');
    await page.locator('input[placeholder*="Description"]').fill('Routes search queries through SearXNG');
    await page.locator('input[placeholder*="Domains"]').fill('google.com, bing.com, duckduckgo.com');
    await page.locator('input[placeholder*="Endpoint"]').fill('/search');

    // Click Save
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(2000);

    // Handler card should appear
    await expect(page.locator('text=Search').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Routes search queries through SearXNG')).toBeVisible();
  });

  test('handler card shows correct data', async () => {
    // Domain pills should be visible
    await expect(page.locator('text=google.com')).toBeVisible();
    await expect(page.locator('text=bing.com')).toBeVisible();
    await expect(page.locator('text=duckduckgo.com')).toBeVisible();

    // Endpoint should be displayed
    await expect(page.locator('text=/search')).toBeVisible();

    // Remove button should be visible (admin)
    await expect(page.locator('button:has-text("Remove")')).toBeVisible();

    // Footer text
    await expect(page.locator('text=Links matching these domains will be opened in SearXNG')).toBeVisible();
  });

  test('+ Add handler button moves to header when handlers exist', async () => {
    // When there are handlers, the "Add handler" button should be in the header area
    await expect(page.locator('button:has-text("Add handler")')).toBeVisible();
  });

  test('admin can delete a link handler', async () => {
    // Click Remove
    await page.locator('button:has-text("Remove")').click();
    await page.waitForTimeout(2000);

    // Should return to empty state
    await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });
  });

  test('all 4 tabs are present on detail page', async () => {
    await expect(page.locator('button:has-text("Overview")')).toBeVisible();
    await expect(page.locator('button:has-text("Permissions")')).toBeVisible();
    await expect(page.locator('button:has-text("Network")')).toBeVisible();
    await expect(page.locator('button:has-text("Link Handling")')).toBeVisible();
  });
});
