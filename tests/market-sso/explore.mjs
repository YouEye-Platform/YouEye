// Exploration helper: open a URL with a saved session, print hops, visible buttons/links and save a screenshot.
// Usage: node explore.mjs <admin|user> <url> [clickRegex] [waitMs]
import { chromium } from '@playwright/test';
const [who, url, click, wait = '6000'] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: `.auth/${who}.json`, ignoreHTTPSErrors: false });
const page = await ctx.newPage();
const hops = [];
page.on('response', r => { if (r.request().isNavigationRequest()) hops.push(`${r.status()} ${r.url().slice(0, 140)}`); });
await page.goto(url, { timeout: 60000 }).catch(e => hops.push('ERR ' + e.message.slice(0, 100)));
await page.waitForTimeout(+wait);
if (click) {
  const re = new RegExp(click, 'i');
  const el = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).first();
  if (await el.isVisible().catch(() => false)) { hops.push('[click ' + click + ']'); await el.click(); await page.waitForTimeout(+wait); }
  else hops.push('[no element ' + click + ']');
  const cont = page.getByRole('button', { name: 'Continue' });
  if (await cont.isVisible().catch(() => false)) { hops.push('[consent]'); await cont.click(); await page.waitForTimeout(+wait); }
}
console.log(hops.join('\n'));
console.log('FINAL', page.url());
const items = await page.evaluate(() => [...document.querySelectorAll('button,a,input,h1,h2')].map(e => `${e.tagName} ${(e.innerText || e.value || e.getAttribute('href') || e.name || '').trim().slice(0, 60)}`).filter(s => s.length > 3).slice(0, 40));
console.log(items.join(' | '));
await page.screenshot({ path: `test-results/explore-${who}.png` });
await browser.close();
