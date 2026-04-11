import { test, expect } from '@playwright/test';

// BUG-LISA-001 regression test: weather geocode API should not ETIMEDOUT
// Node.js v22 happy-eyeballs fix — NODE_OPTIONS=--dns-result-order=ipv4first

const VM_DOMAIN = process.env.VM_DOMAIN || 'lisavm.test';
const VM_USER = process.env.VM_USER || 'lisavm';
const VM_PASS = process.env.VM_PASS || 'tester123';

test.describe('Weather app — location search (BUG-LISA-001 fix)', () => {
  test('location search returns results for "London"', async ({ page }) => {
    // Step 1: Navigate to VM and complete SSO login
    await page.goto(`https://${VM_DOMAIN}`);
    await page.screenshot({ path: 'test-results/weather-fix-01-initial.png' });

    // Handle Authentik login
    await page.waitForURL(/auth\.|authentik/, { timeout: 15000 });
    await page.screenshot({ path: 'test-results/weather-fix-02-auth.png' });

    // Fill login form — Authentik uses shadow DOM, MUST use page.locator() (not page.fill())
    await page.locator('input[name="uidField"]').waitFor({ timeout: 10000 });
    await page.locator('input[name="uidField"]').fill(VM_USER);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000); // Wait for page transition to password step

    // Password step
    await page.locator('input[name="password"]').waitFor({ timeout: 10000 });
    await page.locator('input[name="password"]').fill(VM_PASS);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(5000); // Wait for SSO redirect

    // Handle OAuth consent if shown
    const consent = page.locator('button:has-text("Continue")');
    if (await consent.count() > 0) await consent.click();

    // Wait for YE-UI dashboard
    await expect(page.locator('text=Good')).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: 'test-results/weather-fix-03-dashboard.png' });

    // Step 2: Navigate to weather app
    await page.goto(`https://weather.${VM_DOMAIN}`);
    await page.screenshot({ path: 'test-results/weather-fix-04-weather-home.png' });

    // Step 3: Click "Add Location" button (use first — two links exist on empty state page)
    const addLocationBtn = page.locator('a[href="/locations"]').first();
    await addLocationBtn.waitFor({ timeout: 15000 });
    await addLocationBtn.click();
    await page.screenshot({ path: 'test-results/weather-fix-05-locations-page.png' });

    // Step 4: Type "London" in the search field
    const searchInput = page.locator('input[placeholder="Search cities..."]');
    await searchInput.waitFor({ timeout: 10000 });
    await searchInput.fill('London');

    // Step 5: Wait for results to appear (the key assertion — no more ETIMEDOUT)
    // Before the fix: geocode API returned HTTP 500 (ETIMEDOUT), no results
    // After the fix: geocode API should return results within 5s
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/weather-fix-06-search-results.png' });

    // Assert that the search results dropdown appeared
    // The results container is an absolutely-positioned div that appears when results > 0
    const resultsDropdown = page.locator('div.absolute.top-full');
    await expect(resultsDropdown).toBeVisible({ timeout: 10000 });

    // The first result button should contain "London"
    const firstResult = resultsDropdown.locator('button').first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });
    await expect(firstResult).toContainText('London');

    await page.screenshot({ path: 'test-results/weather-fix-07-results-visible.png' });

    // Step 6: Click the first result to add it
    await firstResult.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/weather-fix-08-location-added.png' });

    // The core assertion is already proven above: search results appeared.
    // That means the geocode API returned data (not ETIMEDOUT HTTP 500).
    // The location page should now show the saved location.
    const savedLocation = page.locator('p.font-medium.text-foreground:has-text("London")').first();
    await expect(savedLocation).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: 'test-results/weather-fix-09-location-saved.png' });
  });
});
