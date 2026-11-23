// Completes the Control Panel sign-in for each saved test session (the YouEye ID session carries it, no password)
// and writes the sessions back, so tests can call the Control Panel API as that user.
import { chromium } from '@playwright/test';
import { DOMAIN, launchOptions, contextOptions, controlPanelSession } from './lib.mjs';
const base = process.argv[2] ?? `https://${DOMAIN}`;
const browser = await chromium.launch(launchOptions);
for (const who of ['admin', 'user']) {
  const ctx = await browser.newContext({ ...contextOptions, storageState: `.auth/${who}.json` });
  const session = await controlPanelSession(await ctx.newPage(), base);
  await ctx.storageState({ path: `.auth/${who}.json` });
  console.log(who, session ? `${session.username} admin=${session.isAdmin}` : 'NO CONTROL PANEL SESSION');
  await ctx.close();
}
await browser.close();
