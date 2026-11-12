// Install an app through the Control Panel API as the saved admin session (like clicking Install), with AI
// Settings off (needed for AI apps such as Open WebUI, which the CLI cannot install). Prints the last stream
// events. Usage: node install-api.mjs <appId>   (BOX_DOMAIN selects the box)
import { chromium } from '@playwright/test';
const appId = process.argv[2];
const cp = `https://control.${(process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })())}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.auth/admin.json' });
const page = await ctx.newPage();
await page.goto(cp + '/', { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 20; i++) { const r = await ctx.request.get(cp + '/api/auth/session', { maxRedirects: 0 }); if (r.status() === 200) break; await page.waitForTimeout(1000); }
page.setDefaultTimeout(1_500_000);
const out = await page.evaluate(async (appId) => {
  const csrf = (document.cookie.match(/ye-csrf=([^;]+)/) || [])[1] || '';
  const r = await fetch('/api/market/install', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ appId, aiSettings: { enabled: false } }) });
  const text = await r.text();
  return { status: r.status, tail: text.split('\n').filter((l) => l.startsWith('data:')).slice(-4).join('\n') || text.slice(0, 400) };
}, appId);
console.log(out.status, out.tail);
await ctx.storageState({ path: '.auth/admin.json' });
await browser.close();
