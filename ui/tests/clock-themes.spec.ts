/**
 * Clock Widget Theme Tests
 *
 * Verifies that clock themes can be selected from the settings dialog
 * and that theme styles are applied to the clock widget.
 */

import { test, expect, chromium } from '@playwright/test';

test.describe('Clock Widget Themes', () => {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  let page: Awaited<ReturnType<typeof context.newPage>>;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('clock widget renders with default gradient theme', async () => {
    await page.goto('https://devvm.test');
    await page.waitForTimeout(2000);

    // Clock widget should be visible with tabular-nums styling
    const clockTime = page.locator('span.tabular-nums').first();
    await expect(clockTime).toBeVisible({ timeout: 10000 });

    // Default gradient theme applies backgroundImage with linear-gradient
    const bgImage = await clockTime.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toContain('linear-gradient');
  });

  test('clock settings dialog shows theme picker', async () => {
    // Enter edit mode by clicking the edit/pencil button
    const editBtn = page.locator('button').filter({ has: page.locator('svg.lucide-pencil, svg[class*="pencil"]') }).first();
    await editBtn.click({ timeout: 5000 }).catch(async () => {
      // Fallback: try finding edit button by aria or other means
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.querySelector('svg') && b.closest('[class*="edit"]')) {
            b.click();
            return;
          }
        }
      });
    });
    await page.waitForTimeout(1000);

    // Open clock widget settings (settings button is at top-left of widget)
    await page.evaluate(() => {
      const containers = document.querySelectorAll('[class*="group"]');
      for (const c of containers) {
        if (c.innerHTML?.includes('tabular-nums')) {
          const btns = c.querySelectorAll('button[title]');
          for (const btn of btns) {
            if ((btn as HTMLElement).className.includes('-left-')) {
              (btn as HTMLElement).style.opacity = '1';
              (btn as HTMLElement).click();
              return;
            }
          }
        }
      }
    });
    await page.waitForTimeout(1000);

    // Verify Clock Settings dialog is open
    await expect(page.locator('text=Clock Settings')).toBeVisible({ timeout: 5000 });

    // Verify theme category tabs exist
    await expect(page.locator('button:text-is("Clean")')).toBeVisible();
    await expect(page.locator('button:text-is("Bold")')).toBeVisible();
    await expect(page.locator('button:text-is("Glow")')).toBeVisible();
    await expect(page.locator('button:text-is("Retro")')).toBeVisible();

    // Verify "CLOCK THEME" section header
    await expect(page.locator('text=Clock Theme').first()).toBeVisible();
  });

  test('can switch theme categories and see different presets', async () => {
    // Click Bold tab
    await page.locator('button:text-is("Bold")').click();
    await page.waitForTimeout(500);

    // Should show Bold presets (Solid, Accent, Sunset, Ocean)
    await expect(page.locator('button[title="Solid"]')).toBeVisible();
    await expect(page.locator('button[title="Sunset"]')).toBeVisible();

    // Click Retro tab
    await page.locator('button:text-is("Retro")').click();
    await page.waitForTimeout(500);

    // Should show Retro presets (Terminal, Digital, Amber)
    await expect(page.locator('button[title="Terminal"]')).toBeVisible();
    await expect(page.locator('button[title="Digital"]')).toBeVisible();
    await expect(page.locator('button[title="Amber"]')).toBeVisible();
  });

  test('selecting a theme applies it to the clock widget', async () => {
    // Select Terminal theme
    await page.locator('button[title="Terminal"]').click();
    await page.waitForTimeout(500);

    // Save settings
    await page.locator('button:text-is("Save")').click();
    await page.waitForTimeout(1000);

    // Clock should now show Terminal theme (Courier New monospace, green color)
    const clockTime = page.locator('span.tabular-nums').first();
    const fontFamily = await clockTime.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily.toLowerCase()).toContain('courier');

    const color = await clockTime.evaluate((el) => getComputedStyle(el).color);
    // Terminal green is #4ade80 = rgb(74, 222, 128)
    expect(color).toContain('74');
    expect(color).toContain('222');
  });

  test('can revert to default gradient theme', async () => {
    // Open settings again
    await page.evaluate(() => {
      const containers = document.querySelectorAll('[class*="group"]');
      for (const c of containers) {
        if (c.innerHTML?.includes('tabular-nums')) {
          const btns = c.querySelectorAll('button[title]');
          for (const btn of btns) {
            if ((btn as HTMLElement).className.includes('-left-')) {
              (btn as HTMLElement).style.opacity = '1';
              (btn as HTMLElement).click();
              return;
            }
          }
        }
      }
    });
    await page.waitForTimeout(1000);

    // Switch to Clean category
    await page.locator('button:text-is("Clean")').click();
    await page.waitForTimeout(500);

    // Select Gradient
    await page.locator('button[title="Gradient"]').click();
    await page.waitForTimeout(500);

    // Save
    await page.locator('button:text-is("Save")').click();
    await page.waitForTimeout(1000);

    // Clock should have gradient backgroundImage again
    const clockTime = page.locator('span.tabular-nums').first();
    const bgImage = await clockTime.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toContain('linear-gradient');

    // Exit edit mode
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('Done')) {
          b.click();
          return;
        }
      }
    });
    await page.waitForTimeout(1000);
  });
});
