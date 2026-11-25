// Turn an app's YouEye ID sign-in off or on through the Control Panel API as the saved admin session (as
// Settings → Apps → <app> → "YouEye ID sign-in" does). Off runs the setup file's `remove:`, on its `steps:`,
// so this also re-runs an app's SSO setup. Usage: node sign-in.mjs <appId> [on|off]
import { chromium } from '@playwright/test';
import { launchOptions, contextOptions, openControlPanel } from './lib.mjs';
const [appId, mode] = process.argv.slice(2);
const browser = await chromium.launch(launchOptions);
const ctx = await browser.newContext({ ...contextOptions, storageState: '.auth/admin.json' });
const page = await ctx.newPage();
await openControlPanel(page);
page.setDefaultTimeout(1_500_000);
const out = await page.evaluate(async ({ appId, mode }) => {
  const csrf = (document.cookie.match(/ye-csrf=([^;]+)/) || [])[1] || '';
  const url = `/api/market/app/${appId}/sign-in`;
  if (!mode) { const g = await fetch(url); return { status: g.status, body: await g.text() }; }
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ enabled: mode === 'on' }) });
  return { status: r.status, body: (await r.text()).slice(0, 400) };
}, { appId, mode });
console.log(appId, mode ?? 'get', JSON.stringify(out));
await ctx.storageState({ path: '.auth/admin.json' });
await browser.close();
