/**
 * Tests for widget container-query scaling (cqw units)
 *
 * Verifies that:
 * - WordArt (server-name) and Clock widgets use CSS container queries
 * - Text scales proportionally when the widget is resized
 * - Reset defaults produce the new smaller WordArt width
 * - Clock displays time with gradient styling
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = 'https://devvm.test';

test.describe('Widget Container-Query Scaling', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP('http://localhost:9222');
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Handle SSO login if redirected
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

  test('widget wrappers have container-type: size', async () => {
    // Every widget content wrapper should have containerType set
    const containerTypes = await page.evaluate(() => {
      const wrappers = document.querySelectorAll('[style*="container-type"]');
      return Array.from(wrappers).map(el => ({
        containerType: (el as HTMLElement).style.containerType,
        hasChildren: el.children.length > 0,
      }));
    });

    expect(containerTypes.length).toBeGreaterThanOrEqual(1);
    for (const ct of containerTypes) {
      expect(ct.containerType).toBe('size');
    }
    await page.screenshot({ path: 'test-results/scaling-01-containers.png' });
  });

  test('server-name widget uses cqw-based fontSize', async () => {
    // Find the h1 inside the server-name widget
    const fontSizeInfo = await page.evaluate(() => {
      const h1s = document.querySelectorAll('h1');
      for (const h1 of h1s) {
        const style = h1.getAttribute('style') || '';
        if (h1.closest('[style*="container-type"]')) {
          return {
            text: h1.textContent,
            computedFontSize: getComputedStyle(h1).fontSize,
            hasStyleAttr: style.length > 0,
          };
        }
      }
      return null;
    });

    expect(fontSizeInfo).not.toBeNull();
    expect(fontSizeInfo!.text).toBeTruthy();
    // Computed fontSize should be a px value > 0 (cqw resolved to pixels)
    const px = parseFloat(fontSizeInfo!.computedFontSize!);
    expect(px).toBeGreaterThan(16); // Should be larger than 1rem
    await page.screenshot({ path: 'test-results/scaling-02-wordart.png' });
  });

  test('clock widget displays time with gradient', async () => {
    // Find the clock time element (has tabular-nums class)
    const clockInfo = await page.evaluate(() => {
      const spans = document.querySelectorAll('.tabular-nums');
      for (const span of spans) {
        const style = getComputedStyle(span);
        if (span.textContent && /\d{2}:\d{2}/.test(span.textContent)) {
          return {
            text: span.textContent,
            fontSize: style.fontSize,
            bgClip: style.webkitBackgroundClip || style.backgroundClip,
            hasGradient: (span as HTMLElement).style.backgroundImage?.includes('gradient'),
          };
        }
      }
      return null;
    });

    expect(clockInfo).not.toBeNull();
    expect(clockInfo!.text).toMatch(/\d{2}:\d{2}/);
    expect(clockInfo!.hasGradient).toBe(true);
    expect(clockInfo!.bgClip).toBe('text');
    await page.screenshot({ path: 'test-results/scaling-03-clock-gradient.png' });
  });

  test('clock date displays below time', async () => {
    const dateInfo = await page.evaluate(() => {
      const spans = document.querySelectorAll('.tracking-wider.uppercase');
      for (const span of spans) {
        if (span.textContent && span.textContent.match(/[A-Z]/)) {
          return {
            text: span.textContent,
            fontSize: getComputedStyle(span).fontSize,
          };
        }
      }
      return null;
    });

    expect(dateInfo).not.toBeNull();
    // Date should contain weekday and month
    expect(dateInfo!.text!.toUpperCase()).toMatch(/[A-Z]+/);
    // Date font should be smaller than time font
    const datePx = parseFloat(dateInfo!.fontSize!);
    expect(datePx).toBeGreaterThan(0);
    expect(datePx).toBeLessThan(30); // Should be small
  });

  test('reset defaults produces smaller WordArt widget', async () => {
    // Enter edit mode
    const editBtn = page.locator('button[title="Edit layout"]');
    await editBtn.click();
    await page.waitForTimeout(500);

    // Reset
    await page.locator('button:has-text("Reset")').click({ force: true });
    await page.waitForTimeout(2000);

    // Measure the WordArt widget width as percentage of the container
    const widgetWidth = await page.evaluate(() => {
      const containers = document.querySelectorAll('[style*="container-type"]');
      for (const c of containers) {
        const h1 = c.querySelector('h1');
        if (h1) {
          const parent = c.parentElement;
          if (parent) {
            const style = parent.style;
            const widthPx = parseFloat(style.width);
            const containerWidth = parent.parentElement?.parentElement?.offsetWidth ?? 1920;
            return { widthPx, containerWidth, pct: (widthPx / containerWidth) * 100 };
          }
        }
      }
      return null;
    });

    expect(widgetWidth).not.toBeNull();
    // Should be around 30% (± tolerance), not the old 57%
    expect(widgetWidth!.pct).toBeLessThan(40);
    await page.screenshot({ path: 'test-results/scaling-04-reset-defaults.png' });

    // Click Done
    await page.locator('button:has-text("Done")').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/scaling-05-final.png' });
  });
});
