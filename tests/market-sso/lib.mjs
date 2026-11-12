// Shared helpers for the YouEye ID sign-in tests (used by apps.spec.ts and probe.mjs).
// No passwords anywhere: every browser context starts from a saved YouEye ID session (.auth/<who>.json).
import { execFileSync } from 'node:child_process';

export const DOMAIN = (process.env.BOX_DOMAIN || (() => { throw new Error('Set BOX_DOMAIN to the test box domain'); })());
export const ID_HOST = `id.${DOMAIN}`;

// The two test identities. Usernames can be overridden if the sessions were saved for other users.
export const USERS = {
  admin: { storageState: '.auth/admin.json', username: process.env.ADMIN_USERNAME ?? 'tester', admin: true },
  user: { storageState: '.auth/user.json', username: process.env.USER_USERNAME ?? 'tester2', admin: false },
};

export const appUrl = (cfg) => `https://${cfg.sub}.${DOMAIN}`;

// Server-side checks run a command on the box as root over SSH. BOX_SSH is the ssh command line without the
// remote command, e.g. "ssh -i ~/.ssh/key -o BatchMode=yes root@<box-ip>". Without it, checks that need the
// box are skipped (whoami returns { skipped }).
export function box(cmd) {
  const ssh = process.env.BOX_SSH;
  if (!ssh) return null;
  const parts = ssh.split(/\s+/).filter(Boolean).map((p) => p.replace(/^~(?=\/)/, process.env.HOME));
  return execFileSync(parts[0], [...parts.slice(1), cmd], { encoding: 'utf8', timeout: 120_000 }).trim();
}

// Run SQL in an app's Postgres (a sidecar or the shared youeye-postgres) and return rows as arrays of fields.
export function psql(container, user, db, sql) {
  const out = box(`incus exec ${container} -- psql -U ${user} -d ${db} -AtF '|' -c "${sql.replace(/"/g, '\\"')}"`);
  return out == null ? null : out.split('\n').filter(Boolean).map((l) => l.split('|'));
}

/**
 * Start the app's YouEye ID sign-in the way a person would and wait until the browser is back on the app.
 * cfg.start: { path = '/', click?: RegExp | Array<RegExp | {name, optional}> (button or link names, clicked in order), wait?: ms to wait for each }
 * Returns { hops, urls, consent }: hops lists navigations (status + short URL), urls the full navigation URLs.
 */
export async function signIn(page, cfg) {
  const base = appUrl(cfg);
  const appHost = new URL(base).host;
  // Kept on the page too, so a caller can print the hops when signIn throws.
  const state = page.ssoState = { hops: [], urls: [], consent: false };
  const { hops, urls } = state;
  let sawId = false;
  page.on('response', (r) => {
    if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return;
    const u = new URL(r.url());
    if (u.host === ID_HOST) sawId = true;
    urls.push(r.url());
    hops.push(`${r.status()} ${u.host.split('.')[0]}${u.pathname}`);
  });
  const start = cfg.start ?? {};
  await page.goto(base + (start.path ?? '/'), { timeout: 60_000, waitUntil: 'domcontentloaded' });
  // Click through the app's own buttons in order (e.g. a splash "Get started", then "Continue with …").
  // An entry { name, optional: true } is clicked only if it shows up within a few seconds.
  for (const item of [start.click ?? []].flat()) {
    const { name, optional } = item instanceof RegExp || typeof item === 'string' ? { name: item } : item;
    const el = page.getByRole('button', { name }).or(page.getByRole('link', { name })).first();
    const shown = await el.waitFor({ state: 'visible', timeout: optional ? 5_000 : start.wait ?? 30_000 })
      .then(() => true, (e) => { if (optional) return false; throw e; });
    if (!shown) continue;
    hops.push(`[click ${name}]`);
    await el.click();
  }
  const deadline = Date.now() + (cfg.timeout ?? 60_000);
  while (Date.now() < deadline) {
    const u = new URL(page.url());
    if (u.host === ID_HOST) {
      sawId = true;
      const cont = page.getByRole('button', { name: /^Continue$/ });
      if (!state.consent && await cont.isVisible().catch(() => false)) {
        state.consent = true;
        hops.push('[consent Continue]');
        await cont.click();
      } else if (await page.locator('input[type=password]').isVisible().catch(() => false)) {
        throw new Error('YouEye ID asks for a password: the saved session has expired (re-run save-session.mjs)');
      }
    } else if (u.host === appHost && sawId && !/callback|oidc|oauth|openid|signin-oidc|\/sso\//i.test(u.pathname + u.search)) {
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!sawId) throw new Error(`never reached YouEye ID; hops: ${hops.join(' -> ')}`);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(cfg.settle ?? 3000);
  return state;
}

// Fetch JSON from the page's origin (uses the app's cookies), returning { status, body }.
export async function pageFetch(page, path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const r = await fetch(path, { credentials: 'include', ...init });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  }, { path, init });
}
