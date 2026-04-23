/**
 * Settings Apps — Playwright test suite
 *
 * Tests the Settings restructure (Session A):
 * - Sidebar shows "Apps" and "Accounts" instead of "Connectors"
 * - Admin sidebar shows "App Management" instead of "Apps"
 * - /settings/connectors redirects to /settings/apps
 * - Apps list page loads and shows installed apps
 * - Per-app detail page has 3 tabs: Data Sources, Link Handling, Permissions
 * - Accounts page loads with Connected Accounts and API Keys sections
 */

import { test, expect, chromium } from '@playwright/test';

const BASE = 'https://devvm.test';

test.describe('Settings Apps Restructure', () => {
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

  test('login and navigate to settings', async () => {
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

    // Navigate to settings via avatar menu
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle', timeout: 15000 });
    await expect(page.locator('text=Profile')).toBeVisible({ timeout: 10000 });
  });

  test('sidebar shows Apps instead of Connectors', async () => {
    // "Apps" should be visible in sidebar
    const appsLink = page.locator('nav a[href="/settings/apps"]');
    await expect(appsLink).toBeVisible();
    await expect(appsLink).toContainText('Apps');

    // Old "Connectors" link should NOT exist
    const connectorsLink = page.locator('nav a[href="/settings/connectors"]');
    await expect(connectorsLink).toHaveCount(0);
  });

  test('sidebar shows Accounts section', async () => {
    const accountsLink = page.locator('nav a[href="/settings/accounts"]');
    await expect(accountsLink).toBeVisible();
    await expect(accountsLink).toContainText('Accounts');
  });

  test('admin sidebar shows App Management', async () => {
    const appMgmtLink = page.locator('nav a[href="/settings/apps-list"]');
    await expect(appMgmtLink).toBeVisible();
    await expect(appMgmtLink).toContainText('App Management');
  });

  test('/settings/connectors redirects to /settings/apps', async () => {
    await page.goto(`${BASE}/settings/connectors`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1000);
    expect(page.url()).toContain('/settings/apps');
    expect(page.url()).not.toContain('/settings/connectors');
  });

  test('Apps list page shows installed apps', async () => {
    await page.goto(`${BASE}/settings/apps`, { waitUntil: 'networkidle', timeout: 15000 });

    // Page title
    await expect(page.locator('h2:has-text("Apps")')).toBeVisible({ timeout: 10000 });

    // Wait for app list to load
    await page.waitForTimeout(2000);

    // Should show at least Search app
    await expect(page.locator('text=Search')).toBeVisible({ timeout: 10000 });

    // Should show multiple native apps
    const appNames = ['Weather', 'Wiki', 'Notes', 'Translate', 'Cinema'];
    for (const name of appNames) {
      await expect(page.locator(`button:has-text("${name}")`).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking an app navigates to per-app detail page', async () => {
    // Click on Search app
    await page.locator('button:has-text("Search")').first().click();
    await page.waitForTimeout(2000);

    // Should show app header
    await expect(page.locator('h2:has-text("Search")')).toBeVisible({ timeout: 10000 });

    // Should show "Back to Apps" link
    await expect(page.locator('text=Back to Apps')).toBeVisible();
  });

  test('per-app page has 3 tabs', async () => {
    // Data Sources tab should be visible and active
    const dsTab = page.locator('button:has-text("Data Sources")');
    await expect(dsTab).toBeVisible();

    // Link Handling tab
    const lhTab = page.locator('button:has-text("Link Handling")');
    await expect(lhTab).toBeVisible();

    // Permissions tab
    const permTab = page.locator('button:has-text("Permissions")');
    await expect(permTab).toBeVisible();
  });

  test('Data Sources tab shows connector capabilities', async () => {
    // Should show connections section on Data Sources tab
    await expect(page.locator('text=CONNECTIONS').first()).toBeVisible({ timeout: 5000 });
  });

  test('Link Handling tab shows placeholder', async () => {
    await page.locator('button:has-text("Link Handling")').click();
    await page.waitForTimeout(500);

    await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });
  });

  test('Permissions tab shows permission state', async () => {
    await page.locator('button:has-text("Permissions")').click();
    await page.waitForTimeout(1000);

    // Should show either permissions or "No permissions granted" message
    const hasPermissions = await page.locator('text=No permissions granted').isVisible().catch(() => false);
    const hasGranted = await page.locator('text=granted').isVisible().catch(() => false);
    expect(hasPermissions || hasGranted).toBeTruthy();
  });

  test('Back to Apps link works', async () => {
    await page.locator('text=Back to Apps').click();
    await page.waitForTimeout(1000);
    expect(page.url()).toContain('/settings/apps');
    expect(page.url()).not.toContain('/settings/apps/');
  });

  test('Accounts page loads correctly', async () => {
    await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle', timeout: 15000 });

    // Page title
    await expect(page.locator('h2:has-text("Accounts")')).toBeVisible({ timeout: 10000 });

    // Connected Accounts section
    await expect(page.locator('text=Connected Accounts')).toBeVisible();

    // API Keys section
    await expect(page.locator('text=API Keys')).toBeVisible();
  });

  test('Accounts page shows empty states', async () => {
    // Since no providers are configured, should show appropriate messages
    const noProviders = page.locator('text=No auth providers configured');
    const noKeys = page.locator('text=No API keys stored yet');

    // At least one of these should be visible
    const providersVisible = await noProviders.isVisible().catch(() => false);
    const keysVisible = await noKeys.isVisible().catch(() => false);
    expect(providersVisible || keysVisible).toBeTruthy();
  });
});
