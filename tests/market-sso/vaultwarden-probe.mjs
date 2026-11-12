// Vaultwarden: YouEye ID sign-in up to the master-password step (no password is typed). The login page asks
// for the account's email first (an identifier), then "Use single sign-on" goes to YouEye ID.
// Usage: node vaultwarden-probe.mjs [admin|user]
import { chromium } from '@playwright/test';
import { DOMAIN, USERS, ID_HOST } from './lib.mjs';
const who = process.argv[2] ?? 'admin';
const email = `${USERS[who].username}@test.test`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: USERS[who].storageState });
const page = await ctx.newPage();
const hops = [];
page.on('response', (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) hops.push(`${r.status()} ${new URL(r.url()).host.split('.')[0]}${new URL(r.url()).pathname}`); });
await page.goto(`https://vault.${DOMAIN}/#/login`, { timeout: 60_000 });
await page.locator('input[type=email]:visible').first().fill(email);
await page.getByRole('button', { name: /single sign-on/i }).first().click();
for (let i = 0; i < 60; i++) {
  if (new URL(page.url()).host === ID_HOST) {
    const cont = page.getByRole('button', { name: /^Continue$/ });
    if (await cont.isVisible().catch(() => false)) { hops.push('[consent]'); await cont.click(); }
  }
  if (/set-initial-password|lock|vault/.test(page.url().split('#')[1] ?? '') && new URL(page.url()).host.startsWith('vault.')) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(3000);
console.log(who, hops.join(' -> '));
console.log('final', page.url());
await page.screenshot({ path: `test-results/vaultwarden-${who}.png` });
await browser.close();
