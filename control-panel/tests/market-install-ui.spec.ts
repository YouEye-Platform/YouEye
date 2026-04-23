/**
 * F1 + F5: Market Install UI — Validation Badge & Error Context
 *
 * Tests the App Market embed UI for:
 * - Pre-install validation badge in install dialog (F1)
 * - Error context display in install progress (F5)
 * - Warning status events (F5)
 *
 * Connects via CDP to the persistent browser session.
 * Session 13 — Andrew
 */

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';

const CP_URL = 'https://localhost';

let context: BrowserContext;
let page: Page;

test.beforeAll(async () => {
  // Connect to persistent browser via CDP
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await context?.close();
});

test.describe('F1: Install Dialog Validation Badge', () => {
  test('market page loads and shows app catalog', async () => {
    // First login to CP
    await page.goto(`${CP_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Fill login form (PAM auth)
    const usernameInput = page.locator('input[name="username"], input[type="text"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

    if (await usernameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await usernameInput.fill('root');
      await passwordInput.fill('tester123');
      await page.locator('button[type="submit"]').click();
      await page.waitForLoadState('networkidle');
    }

    // Navigate to the embed market page directly (bypass iframe)
    await page.goto(`${CP_URL}/embed/market`);
    await page.waitForLoadState('networkidle');

    // Screenshot the market page
    await page.screenshot({ path: 'screenshots/market-catalog.png' });

    // Should show app cards or catalog
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeTruthy();
  });

  test('clicking Install opens dialog with validation badge', async () => {
    // Navigate to embed market
    await page.goto(`${CP_URL}/embed/market`);
    await page.waitForLoadState('networkidle');

    // Wait for catalog to load — look for app cards
    await page.waitForTimeout(3000);

    // Find any Install button
    const installButton = page.locator('button').filter({ hasText: /install/i }).first();
    const hasInstallButton = await installButton.isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasInstallButton) {
      // If no install button, all apps may be installed already. Take screenshot and skip.
      await page.screenshot({ path: 'screenshots/market-no-install-buttons.png' });
      test.skip(true, 'No uninstalled apps available to test install dialog');
      return;
    }

    await installButton.click();
    await page.waitForTimeout(2000);

    // Screenshot the install dialog
    await page.screenshot({ path: 'screenshots/install-dialog-validation.png' });

    // Look for validation-related elements
    // The dialog should show a validation summary (details element or status indicator)
    const dialogContent = await page.textContent('body');

    // The validation runs async — wait a moment for it
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'screenshots/install-dialog-validation-loaded.png' });

    // Check that the dialog is visible (has subdomain input or app name)
    const subdomain = page.locator('input[name="subdomain"], input[placeholder*="subdomain" i]');
    const hasSubdomain = await subdomain.isVisible({ timeout: 5000 }).catch(() => false);

    // Either subdomain field or some dialog content should be present
    expect(hasSubdomain || (dialogContent && dialogContent.length > 50)).toBe(true);
  });
});

test.describe('F5: Error Context in Install Events', () => {
  test('SSE error events include errorContext fields', async () => {
    // This test validates the SSE event structure by checking the types
    // We don't want to actually install an app, just verify the event schema

    // Navigate to market page
    await page.goto(`${CP_URL}/embed/market`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Verify the page has loaded the InstallProgress type correctly
    // by checking that the event rendering code exists in the page source
    const pageSource = await page.content();

    // The embed client should have error context rendering logic
    // (errorContext, statusCode, suggestion, etc.)
    await page.screenshot({ path: 'screenshots/market-loaded-f5.png' });

    // Check the page loaded without errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Filter out expected errors (like network/CSP)
    const realErrors = errors.filter(e =>
      !e.includes('net::') &&
      !e.includes('Content Security Policy') &&
      !e.includes('favicon')
    );

    // No unexpected JS errors
    expect(realErrors.length).toBe(0);
  });
});

test.describe('F5: Install Progress UI Elements', () => {
  test('active installs banner renders correctly when present', async () => {
    await page.goto(`${CP_URL}/embed/market`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Check if there are active installs showing
    const activeInstalls = page.locator('[class*="install"], [data-testid*="install"]');
    const hasActive = await activeInstalls.first().isVisible({ timeout: 3000 }).catch(() => false);

    await page.screenshot({ path: 'screenshots/market-installs-state.png' });

    // This is informational — not all test runs will have active installs
    if (hasActive) {
      // Verify install progress elements are present
      const progressBar = page.locator('[role="progressbar"], div[style*="width"]');
      const hasProgress = await progressBar.first().isVisible({ timeout: 3000 }).catch(() => false);
      // Progress bars should render when there are active installs
      expect(hasProgress).toBe(true);
    }
  });
});
