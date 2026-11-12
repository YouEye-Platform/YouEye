// Completes the Control Panel sign-in for each saved test session (the YouEye ID session carries it, no password)
// and writes the sessions back, so tests can call the Control Panel API as that user.
import { chromium } from '@playwright/test';
const base = process.argv[2] ?? `https://${(process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })())}`;
const browser = await chromium.launch();
for (const who of ['admin', 'user']) {
  const ctx = await browser.newContext({ storageState: `.auth/${who}.json` });
  const page = await ctx.newPage();
  await page.goto(base + '/settings', { timeout: 60000 }).catch(() => {});
  let session = null;
  for (let i = 0; i < 30 && !session; i++) {
    const r = await ctx.request.get(base + '/settings/api/auth/session', { maxRedirects: 0 });
    if (r.status() === 200) session = (await r.json()).user;
    else await page.waitForTimeout(1000);
  }
  await ctx.storageState({ path: `.auth/${who}.json` });
  console.log(who, session ? `${session.username} admin=${session.isAdmin}` : 'NO CONTROL PANEL SESSION');
  await ctx.close();
}
await browser.close();
