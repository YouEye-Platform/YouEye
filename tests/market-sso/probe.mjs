// Run one app's sign-in + whoami for admin and/or user and print the result (exploration twin of apps.spec.ts).
// Usage: node probe.mjs <appId> [admin|user]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { USERS, signIn } from './lib.mjs';
import { apps } from './apps.config.mjs';
const [id, only] = process.argv.slice(2);
const cfg = apps[id];
if (!cfg) { console.error('unknown app', id); process.exit(2); }
mkdirSync('test-results', { recursive: true });
const browser = await chromium.launch();
for (const who of only ? [only] : ['admin', 'user']) {
  const context = await browser.newContext({ storageState: USERS[who].storageState });
  const page = await context.newPage();
  let signin = { hops: [], urls: [] }, res;
  try {
    signin = await signIn(page, cfg);
    res = await cfg.whoami({ page, context, signin, who });
  } catch (e) { res = { error: e.message.split('\n')[0].slice(0, 300) }; signin = page.ssoState ?? signin; }
  await page.screenshot({ path: `test-results/${id}-${who}.png` }).catch(() => {});
  console.log(`${id} ${who} | ${signin.hops.join(' -> ')}`);
  console.log(`   final ${page.url().slice(0, 120)}`);
  console.log(`   WHOAMI ${JSON.stringify(res)}`);
  await context.close();
}
await browser.close();
