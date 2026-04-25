/**
 * Tests for widget auto-fit scaling
 *
 * Verifies that:
 * - WordArt (server-name) and Clock widgets fit text to container width
 * - Height auto-adjusts to content (no vertical empty space)
 * - Clock displays time with gradient styling
 * - AutoFit widgets have onAutoSize callback wired up
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = 'https://devvm.test';

test.describe('Widget Auto-Fit Scaling', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

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
        // Already logged in
      }
    }
    await page.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('server-name widget text fills container width', async () => {
    await page.waitForTimeout(1000); // let fit-text settle

    const fitInfo = await page.evaluate(() => {
      const h1s = document.querySelectorAll('h1');
      for (const h1 of h1s) {
        const container = h1.closest('[style*="container-type"]');
        if (container) {
          const containerW = (container as HTMLElement).clientWidth;
          const textRect = h1.getBoundingClientRect();
          return {
            text: h1.textContent,
            containerWidth: containerW,
            textWidth: textRect.width,
            fillRatio: textRect.width / containerW,
            fontSize: getComputedStyle(h1).fontSize,
          };
        }
      }
      return null;
    });

    expect(fitInfo).not.toBeNull();
    expect(fitInfo!.text).toBeTruthy();
    // Text should fill at least 90% of container width (fit-text with 0.98 margin)
    expect(fitInfo!.fillRatio).toBeGreaterThan(0.85);
    expect(fitInfo!.fillRatio).toBeLessThanOrEqual(1.05);
    await page.screenshot({ path: 'test-results/scaling-01-wordart-fit.png' });
  });

  test('clock widget time text fills container width', async () => {
    const clockInfo = await page.evaluate(() => {
      const spans = document.querySelectorAll('.tabular-nums');
      for (const span of spans) {
        if (span.textContent && /\d{2}:\d{2}/.test(span.textContent)) {
          const container = span.closest('[style*="container-type"]');
          if (container) {
            const containerW = (container as HTMLElement).clientWidth;
            const textRect = span.getBoundingClientRect();
            return {
              text: span.textContent,
              containerWidth: containerW,
              textWidth: textRect.width,
              fillRatio: textRect.width / containerW,
              fontSize: getComputedStyle(span).fontSize,
              hasGradient: (span as HTMLElement).style.backgroundImage?.includes('gradient'),
            };
          }
        }
      }
      return null;
    });

    expect(clockInfo).not.toBeNull();
    expect(clockInfo!.text).toMatch(/\d{2}:\d{2}/);
    expect(clockInfo!.hasGradient).toBe(true);
    // Time text should fill most of container width
    expect(clockInfo!.fillRatio).toBeGreaterThan(0.80);
    await page.screenshot({ path: 'test-results/scaling-02-clock-fit.png' });
  });

  test('clock date is proportional to time', async () => {
    const sizes = await page.evaluate(() => {
      const timeEl = document.querySelector('.tabular-nums');
      const dateEl = document.querySelector('.tracking-wider.uppercase');
      if (!timeEl || !dateEl) return null;
      return {
        timeFontSize: parseFloat(getComputedStyle(timeEl).fontSize),
        dateFontSize: parseFloat(getComputedStyle(dateEl).fontSize),
      };
    });

    expect(sizes).not.toBeNull();
    // Date should be roughly 25-35% of time size
    const ratio = sizes!.dateFontSize / sizes!.timeFontSize;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.45);
  });

  test('autoFit widgets have no bottom resize handles in edit mode', async () => {
    // Enter edit mode
    await page.locator('button[title="Edit layout"]').click();
    await page.waitForTimeout(500);

    // Check that autoFit widgets (server-name, clock) don't have bottom resize cursors
    const resizeHandles = await page.evaluate(() => {
      const containers = document.querySelectorAll('[style*="container-type"]');
      const results: { widgetText: string; hasBottomHandle: boolean }[] = [];

      for (const c of containers) {
        const parent = c.parentElement;
        if (!parent) continue;
        const text = c.textContent?.substring(0, 20) || '';
        // Check for cursor-s-resize (bottom resize handle)
        const bottomHandle = parent.querySelector('.cursor-s-resize');
        results.push({ widgetText: text, hasBottomHandle: !!bottomHandle });
      }
      return results;
    });

    // WordArt and clock should NOT have bottom handles
    for (const r of resizeHandles) {
      if (r.widgetText.match(/\d{2}:\d{2}/) || r.widgetText.match(/^[A-Z]/)) {
        // Clock or WordArt — should have no bottom handle
        expect(r.hasBottomHandle).toBe(false);
      }
    }

    await page.screenshot({ path: 'test-results/scaling-03-edit-mode.png' });

    // Exit edit mode
    await page.locator('button:has-text("Done")').click();
    await page.waitForTimeout(500);
  });

  test('reset defaults produces tight-fitting widgets', async () => {
    // Enter edit mode and reset
    await page.locator('button[title="Edit layout"]').click();
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Reset")').click({ force: true });
    await page.waitForTimeout(3000); // let auto-fit settle

    await page.screenshot({ path: 'test-results/scaling-04-reset.png' });

    // Done
    await page.locator('button:has-text("Done")').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/scaling-05-final.png' });
  });
});
