import { chromium } from '@playwright/test';
const [appId, mode] = process.argv.slice(2);
const cp = `https://control.${(process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })())}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: `.auth/admin.json` });
const page = await ctx.newPage();
await page.goto(cp + '/', { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 20; i++) { const r = await ctx.request.get(cp + '/api/auth/session', { maxRedirects: 0 }); if (r.status() === 200) break; await page.waitForTimeout(1000); }
const out = await page.evaluate(async ({ appId, mode }) => {
  const csrf = { csrfToken: (document.cookie.match(/ye-csrf=([^;]+)/) || [])[1] || '' };
  const url = `/api/market/apps/${appId}/access`;
  const g = await fetch(url); if (!g.ok) return { getStatus: g.status, body: (await g.text()).slice(0, 120) };
  const cur = await g.json();
  if (!mode) return { mode: cur.policy?.mode, state: cur.policy?.state };
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken || '' }, body: JSON.stringify({ policy: { ...cur.policy, mode }, expectedRevision: cur.policy.revision }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, mode: j.policy?.mode, state: j.policy?.state, error: j.error };
}, { appId, mode });
console.log(appId, JSON.stringify(out));
await ctx.storageState({ path: '.auth/admin.json' });
await browser.close();
