/**
 * System Metrics Page — Playwright test suite
 *
 * Tests the system admin page fix (was returning HTTP 500):
 * - System page loads without errors
 * - Shows host info (hostname, OS, kernel, uptime)
 * - Shows CPU info (model, cores, usage)
 * - Shows memory usage with progress bar
 * - Shows disk usage with progress bar
 * - Shows container summary (total, running, stopped)
 * - Refresh button works
 */

import { test, expect, chromium } from '@playwright/test';

const BASE = 'https://devvm.test';

test.describe('System Metrics Page', () => {
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

  test('login and navigate to system settings', async () => {
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

    await page.goto(`${BASE}/settings/system`, { waitUntil: 'networkidle', timeout: 15000 });
  });

  test('system page does not return HTTP 500', async () => {
    // The page should be on /settings/system, not redirected to an error page
    expect(page.url()).toContain('/settings/system');

    // Should show the System heading
    await expect(page.locator('text=System').first()).toBeVisible({ timeout: 10000 });
  });

  test('shows Host section with system info', async () => {
    // Host section
    await expect(page.locator('text=Host')).toBeVisible({ timeout: 10000 });

    // Hostname
    await expect(page.locator('text=Hostname')).toBeVisible();

    // Operating System
    await expect(page.locator('text=Operating System')).toBeVisible();
    await expect(page.locator('text=Ubuntu')).toBeVisible();

    // Kernel
    await expect(page.locator('text=Kernel')).toBeVisible();

    // Uptime
    await expect(page.locator('text=Uptime')).toBeVisible();
  });

  test('shows CPU section', async () => {
    await expect(page.locator('text=CPU')).toBeVisible();
    await expect(page.locator('text=Model')).toBeVisible();
    await expect(page.locator('text=Cores')).toBeVisible();
    await expect(page.locator('text=Usage')).toBeVisible();
    await expect(page.locator('text=Load Average')).toBeVisible();
  });

  test('shows Memory section with usage', async () => {
    await expect(page.locator('text=Memory')).toBeVisible();
    // Memory shows "X / Y MB (Z%)" format
    await expect(page.locator('text=MB')).toBeVisible();
  });

  test('shows Disk section with usage', async () => {
    await expect(page.locator('text=Disk')).toBeVisible();
    // Disk shows "X / Y GB (Z%)" format
    await expect(page.locator('text=GB')).toBeVisible();
  });

  test('shows Containers section', async () => {
    await expect(page.locator('text=Containers')).toBeVisible();
    await expect(page.locator('text=Total')).toBeVisible();
    await expect(page.locator('text=Running')).toBeVisible();
    await expect(page.locator('text=Stopped')).toBeVisible();
  });

  test('Refresh button is present and clickable', async () => {
    const refreshBtn = page.locator('button:has-text("Refresh")');
    await expect(refreshBtn).toBeVisible();

    // Click refresh and verify page doesn't crash
    await refreshBtn.click();
    await page.waitForTimeout(3000);

    // Page should still show system data after refresh
    await expect(page.locator('text=Host')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=CPU')).toBeVisible();
    await expect(page.locator('text=Memory')).toBeVisible();
  });
});
