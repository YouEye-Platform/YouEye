/**
 * Health Dashboard — Caddy green status verification
 *
 * Smoke test for FIX-3: Caddy health check false positive.
 * Verifies that the health dashboard shows Caddy as running (not Degraded)
 * when all containers are up and Caddy is proxying correctly.
 *
 * Also verifies the overall platform health summary.
 */

import { test, expect } from '@playwright/test';

const VM_DOMAIN = process.env.VM_DOMAIN || 'samvm.test';
const VM_USER = process.env.VM_USER || 'sam';
const VM_PASS = process.env.VM_PASS || 'tester123';

test('health dashboard shows Caddy as running (not Degraded)', async ({ page }) => {
  // Step 1: Navigate to CP login
  await page.goto(`https://${VM_DOMAIN}/login`);
  await page.screenshot({ path: 'test-results/health-01-login.png' });

  // Step 2: Log in via SSO (Authentik)
  await page.waitForSelector('input[name="uidField"]', { timeout: 15000 });
  await page.fill('input[name="uidField"]', VM_USER);
  await page.click('[type="submit"]');

  await page.waitForSelector('input[name="password"]', { timeout: 10000 });
  await page.fill('input[name="password"]', VM_PASS);
  await page.click('[type="submit"]');
  await page.screenshot({ path: 'test-results/health-02-after-login.png' });

  // Handle possible consent screen (BUG-013)
  try {
    const continueBtn = page.locator('text=Continue');
    await continueBtn.click({ timeout: 3000 });
  } catch {
    // No consent screen — that's fine
  }

  // Step 3: Navigate to CP (control.samvm.test)
  await page.goto(`https://control.${VM_DOMAIN}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'test-results/health-03-cp-dashboard.png' });

  // Step 4: Navigate to health dashboard via sidebar
  // Click the Health link in the sidebar
  const healthLink = page.locator('a[href*="health"]').first();
  await healthLink.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000); // Allow health checks to complete
  await page.screenshot({ path: 'test-results/health-04-health-page.png' });

  // Step 5: Verify Caddy shows as running (not Degraded)
  const pageContent = await page.content();

  // Check that Caddy card does NOT show degraded
  const caddyDegraded = pageContent.toLowerCase().includes('caddy') &&
    pageContent.toLowerCase().includes('degraded') &&
    // Make sure the degraded is near caddy text
    (() => {
      const caddyIdx = pageContent.toLowerCase().indexOf('caddy');
      const degradedIdx = pageContent.toLowerCase().indexOf('degraded', caddyIdx);
      return degradedIdx !== -1 && degradedIdx - caddyIdx < 500;
    })();

  expect(caddyDegraded, 'Caddy should not show as Degraded when running normally').toBe(false);

  // Verify health page loaded with service cards
  await expect(page.locator('text=Caddy')).toBeVisible();
  await page.screenshot({ path: 'test-results/health-05-caddy-status.png' });
});

test('platform health endpoint responds ok', async ({ page }) => {
  // Verify /api/ping is accessible
  const resp = await page.request.get(`https://${VM_DOMAIN}/api/ping`, {
    ignoreHTTPSErrors: true,
  });
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(body.status).toBe('ok');
});
