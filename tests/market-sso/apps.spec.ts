// YouEye ID sign-in + admin mapping, per app. For each app in apps.config.mjs (or only APPS=a,b), and for each
// saved identity (admin, user): start the app's own "Sign in with YouEye" flow, accept YouEye ID's consent if
// asked, land back on the app, then ask the app who is signed in and whether they are an admin there.
// Expected: the admin session → admin in the app; the standard-user session → signed in, not admin.
// Known product gaps are recorded per app as `expect: { admin: false }` etc. and checked as such, so a fix
// shows up as a failing test that must be updated.
import { test, expect } from '@playwright/test';
import { USERS, appUrl, signIn } from './lib.mjs';
import { apps } from './apps.config.mjs';

const only = process.env.APPS?.split(',').map((s) => s.trim()).filter(Boolean);

for (const [id, cfg] of Object.entries(apps)) {
  if (only && !only.includes(id)) continue;
  test.describe(id, () => {
    test.skip(Boolean(cfg.skip), String(cfg.skip));
    test.beforeAll(async ({ playwright }) => {
      // Skip apps that are not installed (their subdomain does not answer as the app).
      const request = await playwright.request.newContext();
      const r = await request.get(appUrl(cfg) + '/', { maxRedirects: 0, failOnStatusCode: false, timeout: 20_000 }).catch(() => null);
      const status = r?.status() ?? 0;
      // A host with no app falls through to the YouEye dashboard, which redirects "/" to "/settings".
      const fallback = status >= 300 && status < 400 && new URL(r!.headers()['location'] ?? '/', appUrl(cfg)).pathname === '/settings';
      await request.dispose();
      test.skip(!status || status >= 500 || status === 404 || fallback,
        `${id} is not installed or not reachable (${fallback ? 'dashboard fallback' : status || 'no answer'})`);
    });
    for (const who of ['admin', 'user'] as const) {
      test(`${who} signs in with YouEye ID`, async ({ browser }, info) => {
        const context = await browser.newContext({ storageState: USERS[who].storageState });
        const page = await context.newPage();
        try {
          const signin = await signIn(page, cfg);
          info.annotations.push({ type: 'hops', description: signin.hops.join(' -> ') });
          await page.screenshot({ path: `test-results/${id}-${who}.png` });
          const me = await cfg.whoami({ page, context, signin, who });
          info.annotations.push({ type: 'whoami', description: JSON.stringify(me) });
          test.skip(Boolean(me.skipped), `whoami: ${me.skipped}`);
          // Signed in as the right person (apps that show an email or display name match on the username part).
          expect(String(me.username ?? '').toLowerCase(), 'signed-in user').toContain(USERS[who].username);
          const wantAdmin = cfg.expect?.[who]?.admin ?? USERS[who].admin;
          expect(Boolean(me.admin), `${who} admin in ${id}`).toBe(wantAdmin);
        } finally {
          await context.close();
        }
      });
    }
  });
}
