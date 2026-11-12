import { chromium } from '@playwright/test';
const base = `https://recipes.${(process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })())}`;
const browser = await chromium.launch();
for (const who of (process.argv[2] ? [process.argv[2]] : ['admin', 'user'])) {
  const ctx = await browser.newContext({ storageState: `.auth/${who}.json` });
  const page = await ctx.newPage();
  const hops = [];
  page.on('response', r => { if (r.request().isNavigationRequest()) hops.push(`${r.status()} ${new URL(r.url()).host.split('.')[0]}${new URL(r.url()).pathname}`); });
  await page.goto(base + '/api/auth/oauth', { timeout: 60000 }).catch(e => hops.push('ERR ' + e.message.slice(0, 80)));
  await page.waitForTimeout(4000);
  const cont = page.getByRole('button', { name: 'Continue' });
  if (await cont.isVisible().catch(() => false)) { hops.push('[consent: Continue]'); await cont.click(); }
  await page.waitForTimeout(15000);
  // Mealie keeps its session in a cookie/localStorage token after the callback; ask the API who we are.
  // Mealie's page script would now call the callback API with the code; do that call directly.
  const q = new URL(page.url()).search;
  const cb = await page.evaluate(async (q) => { const r = await fetch('/api/auth/oauth/callback' + q); const j = await r.json().catch(() => ({})); return { status: r.status, token: j.access_token || '' }; }, q);
  hops.push(`[callback ${cb.status}]`);
  const token = cb.token || ((await ctx.cookies(base)).find(c => c.name === 'mealie.access_token')?.value ?? '');
  const cookies = (await ctx.cookies(base)).map(c => c.name);
  const self = await page.evaluate(async (t) => {
    const r = await fetch('/api/users/self', { headers: t ? { Authorization: 'Bearer ' + t } : {} });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, username: j.username, email: j.email, admin: j.admin, group: j.group };
  }, token).catch(e => ({ err: e.message }));
  console.log(who, '|', hops.join(' -> '));
  console.log('   final', new URL(page.url()).pathname, '| cookies', cookies.join(','), '| self', JSON.stringify(self));
  await page.screenshot({ path: `test-results/mealie-${who}.png` });
  await ctx.close();
}
await browser.close();
