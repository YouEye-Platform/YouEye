// Signs the two test identities in to YouEye ID on a TEST box and saves their sessions to .auth/admin.json and
// .auth/user.json (git-ignored, mode 0600), then completes the Control Panel sign-in and checks that the admin is
// admin=true and the standard user admin=false. Replaces save-session.mjs (a person signing in by hand) on test boxes.
//
// Test boxes only, YouEye ID test accounts only. Normally run through Tools/box/test-login, which holds the standard
// test accounts and refuses the owner's box. Usernames and passwords come only from the environment, never from
// this repository:
//   YOUEYE_TEST_ADMIN_USER, YOUEYE_TEST_ADMIN_PASS   the YouEye ID admin
//   YOUEYE_TEST_USER_USER,  YOUEYE_TEST_USER_PASS    the standard user
// BOX_DOMAIN: the box's domain. BOX_IP (optional): its address, for a domain that is not in DNS (devvm.test).
// One attempt per user: a refused password is reported and never retried (YouEye ID locks a username for 15 minutes
// after 10 failed sign-ins). Prints no password, cookie or token.
// Usage: node login.mjs [admin] [user]        (default both)
import { chromium } from '@playwright/test';
import { chmodSync, mkdirSync, renameSync } from 'node:fs';
import { DOMAIN, ID_HOST, USERS, launchOptions, controlPanelSession } from './lib.mjs';

const ENV = { admin: 'YOUEYE_TEST_ADMIN', user: 'YOUEYE_TEST_USER' };
const which = process.argv.slice(2);
for (const w of which) if (!ENV[w]) { console.error('usage: node login.mjs [admin] [user]'); process.exit(2); }
const whos = which.length ? which : ['admin', 'user'];
const accounts = {};
for (const who of whos) {
  const username = process.env[`${ENV[who]}_USER`], password = process.env[`${ENV[who]}_PASS`];
  if (!username || !password) {
    console.error(`Set ${ENV[who]}_USER and ${ENV[who]}_PASS (Tools/box/test-login does this for test boxes)`);
    process.exit(2);
  }
  accounts[who] = { username, password };
}

const base = `https://${DOMAIN}`;
mkdirSync('.auth', { recursive: true, mode: 0o700 });
// Test boxes may use YouEye's internal TLS (devvm.test) or a box-local certificate: accepted here.
const browser = await chromium.launch(launchOptions);
let failed = 0;
for (const who of whos) {
  const { username, password } = accounts[who];
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto(`https://${ID_HOST}/identity/login`, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#continue-button').click();
    // Wait for the redirect away from the sign-in page, or for the page's error line. Never submit twice.
    let error = '';
    for (let i = 0; i < 60; i++) {
      const u = new URL(page.url());
      if (!(u.host === ID_HOST && u.pathname.startsWith('/identity/login'))) break;
      error = (await page.locator('.error').textContent({ timeout: 1000 }).catch(() => '') ?? '').trim();
      if (error) break;
      await page.waitForTimeout(500);
    }
    if (error) throw new Error(`YouEye ID refused ${username}: ${error} (not retried)`);
    if (new URL(page.url()).host === ID_HOST && new URL(page.url()).pathname.startsWith('/identity/login')) {
      throw new Error(`no answer from YouEye ID's sign-in for ${username} within 30 s`);
    }
    const session = await controlPanelSession(page, base);
    if (!session) throw new Error(`signed in to YouEye ID as ${username}, but no Control Panel session followed`);
    const file = USERS[who].storageState;
    await context.storageState({ path: `${file}.tmp` });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
    const ok = session.username === username && Boolean(session.isAdmin) === USERS[who].admin;
    console.log(`${who} ${session.username} admin=${session.isAdmin} -> ${file}${ok ? '' : `  UNEXPECTED: want ${username} admin=${USERS[who].admin}`}`);
    if (!ok) failed++;
  } catch (e) {
    failed++;
    console.error(`${who}: ${String(e.message).split('\n')[0]}`);
  } finally {
    await context.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
