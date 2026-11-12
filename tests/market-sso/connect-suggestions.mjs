// List the Control Panel's connection suggestions as the saved admin session and approve the ones named
// (like clicking Connect on a suggestion card). Usage: node connect-suggestions.mjs [from>to ...]
// With no arguments it only lists them. BOX_DOMAIN selects the box.
import { chromium } from '@playwright/test';
const wanted = process.argv.slice(2);
const cp = `https://control.${(process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })())}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.auth/admin.json' });
const page = await ctx.newPage();
await page.goto(cp + '/', { timeout: 60000 }).catch(() => {});
page.setDefaultTimeout(900_000);
const out = await page.evaluate(async (wanted) => {
  const csrf = (document.cookie.match(/ye-csrf=([^;]+)/) || [])[1] || '';
  const list = await (await fetch('/api/suggestions')).json();
  const rows = (Array.isArray(list) ? list : list.suggestions ?? []).map((s) => ({ id: s.id, type: s.type, from: s.fromAppId, to: s.targetAppId, status: s.status }));
  const results = [];
  for (const s of rows) {
    if (!wanted.includes(`${s.from}>${s.to}`)) continue;
    const r = await fetch('/api/suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ action: 'approve', id: s.id }) });
    results.push({ pair: `${s.from}>${s.to}`, status: r.status, body: (await r.text()).slice(0, 300) });
  }
  return { rows, results };
}, wanted);
console.log(JSON.stringify(out, null, 2));
await ctx.storageState({ path: '.auth/admin.json' });
await browser.close();
