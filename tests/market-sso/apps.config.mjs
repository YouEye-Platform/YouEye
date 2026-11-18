// Per-app table for the YouEye ID sign-in tests. Each entry says where the app lives (sub = subdomain), how a
// person starts its YouEye sign-in (start), and how to ask the app who is signed in and whether they are an admin
// (whoami → { username, admin, ...extra }). whoami gets { page, context, signin, who } where signin is signIn()'s
// result. Entries with `skip` are documented but not run (reason in the string). `expect: { admin|user: { admin } }`
// overrides the expected admin flag where the app has a known gap, so a fix shows up as a failing test.
import { pageFetch, psql, box, USERS } from './lib.mjs';

export const apps = {
  'actual-budget': {
    sub: 'actual-budget',
    // Known limit: the FIRST person to sign in becomes the owner (ADMIN), whatever their YouEye role (Actual reads
    // no role claims; the listing tells the owner to sign in first). Passes because admin runs before user.
    start: { path: '/', click: /(Start using|Sign in with) OpenID/i },
    // The callback lands on /openid-cb?token=<session token>; the server's /account/validate says who it is.
    whoami: async ({ page, signin }) => {
      const token = signin.urls.map((u) => new URL(u).searchParams.get('token')).find(Boolean);
      const r = await pageFetch(page, '/account/validate', { headers: { 'x-actual-token': token ?? '' } });
      const d = r.body?.data ?? {};
      return { username: d.userName, admin: d.permission === 'ADMIN', permission: d.permission, status: r.status };
    },
  },
  audiobookshelf: {
    sub: 'audiobookshelf',
    // Type follows YouEye ID through the per-app claim abs_roles ([admin] | [user]), read from userinfo.
    start: { path: '/', click: /^Login with /i },
    // The callback lands on /audiobookshelf/login?setToken=<access token>; /api/me returns the user and its type
    // (root | admin | user | guest).
    whoami: async ({ page, signin }) => {
      const token = signin.urls.map((u) => new URL(u).searchParams.get('setToken')).find(Boolean);
      const r = await pageFetch(page, '/audiobookshelf/api/me', { headers: { Authorization: `Bearer ${token}` } });
      return { username: r.body?.username, admin: ['root', 'admin'].includes(r.body?.type), type: r.body?.type, status: r.status };
    },
  },
  freshrss: {
    sub: 'freshrss',
    // is_admin is set when FreshRSS creates the user, from the per-app claim freshrss_role (admin | user).
    // The whole site sits behind mod_auth_openidc: opening it goes straight to YouEye ID.
    start: { path: '/' },
    // FreshRSS has no session-cookie "who am I" API; the CLI on the box lists users with is_admin.
    whoami: async ({ page }) => {
      const html = await page.content();
      const shown = html.match(/class="signout">\(([^)]+)\)/)?.[1];
      const out = box("incus exec app-freshrss -- php /var/www/FreshRSS/cli/user-info.php --json --no-db-size --no-db-counts");
      if (out == null) return { skipped: 'BOX_SSH not set', shown };
      const users = JSON.parse(out);
      const me = users.find((u) => u.user === shown) ?? null;
      return { username: shown, admin: me ? Boolean(me.admin) : undefined, users: users.map((u) => `${u.user}${u.admin ? '*' : ''}`).join(',') };
    },
  },
  jellyfin: {
    sub: 'jellyfin',
    // The SSO plugin adds no button to Jellyfin's login page; its start URL is the manifest's sso.entry
    // (/sso/OID/start/<client slug>).
    start: { path: '/sso/OID/start/youeye-app-jellyfin' },
    settle: 6000,
    // The plugin's redirect page stores the Jellyfin token in localStorage (jellyfin_credentials).
    whoami: async ({ page }) => {
      const creds = await page.evaluate(() => JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}'));
      const token = creds.Servers?.find((s) => s.AccessToken)?.AccessToken;
      if (!token) return { error: 'no Jellyfin token in localStorage' };
      const r = await pageFetch(page, '/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` } });
      return { username: r.body?.Name, admin: Boolean(r.body?.Policy?.IsAdministrator), status: r.status };
    },
  },
  linkwarden: {
    sub: 'linkwarden',
    // Known limit: user id 1 (the first to sign in) is the admin (listing tells the owner). Passes with admin first.
    start: { path: '/login', click: / ID$/ },
    // Linkwarden's admin is simply user id 1 (NEXT_PUBLIC_ADMIN, default 1): the first account created. The
    // admin-only user list (/api/v1/users) answers 200 for the admin and 401 for anyone else.
    whoami: async ({ page }) => {
      const me = await pageFetch(page, '/api/v1/users/me');
      const all = await pageFetch(page, '/api/v1/users');
      return { username: me.body?.response?.username, id: me.body?.response?.id, admin: all.status === 200, usersStatus: all.status };
    },
  },
  memos: {
    sub: 'memos',
    // Known gap: Memos has no claim-to-role mapping; OIDC users are role USER (still true in 26.11).
    expect: { admin: { admin: false } },
    // Memos 26 goes straight to its only identity provider when password sign-in is off; 0.30 showed a button.
    start: { path: '/auth', click: [{ name: / ID$/, optional: true }] },
    settle: 5000,
    // Memos 26 dropped the /api/v1 prefix (/api/v1 answers 410); the access token may be in localStorage
    // (memos_access_token) or only in the session cookie.
    whoami: async ({ page }) => {
      const token = await page.evaluate(() => localStorage.getItem('memos_access_token'));
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      let r = await pageFetch(page, '/api/auth/me', { headers });
      if (r.status === 404) r = await pageFetch(page, '/api/v1/auth/me', { headers });
      const u = r.body?.user ?? r.body ?? {};
      return { username: u.username, admin: ['HOST', 'ADMIN'].includes(u.role), role: u.role, status: r.status };
    },
  },
  miniflux: {
    sub: 'miniflux',
    // 2.3.5+: admin follows YouEye ID's admin group at every sign-in (OAUTH2_ADMIN_GROUP).
    start: { path: '/', click: /Sign in with OpenID Connect/i },
    // Miniflux's REST API does not take the web session, so ask the web UI: the logout button's title names the
    // signed-in user ("Logged in as <name>", 2.3.5; older pages had a username field), and /users (user
    // management) is admin-only (403 for others).
    whoami: async ({ page }) => {
      const settings = await pageFetch(page, '/settings');
      const html = String(settings.body);
      const username = html.match(/title="Logged in as ([^"]+)"/)?.[1]
        ?? html.match(/name="username"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="username"/)?.slice(1).find(Boolean);
      const users = await pageFetch(page, '/users');
      return { username, admin: users.status === 200, usersStatus: users.status };
    },
  },
  nextcloud: {
    sub: 'nextcloud',
    // allow_multiple_user_backends=0: the login page goes straight to YouEye ID (/login?direct=1 shows the form).
    start: { path: '/login' },
    settle: 5000,
    // OCS: who am I, then my groups (Nextcloud's admin group is "admin").
    whoami: async ({ page }) => {
      const h = { 'OCS-APIRequest': 'true', Accept: 'application/json' };
      const me = await pageFetch(page, '/ocs/v2.php/cloud/user?format=json', { headers: h });
      const id = me.body?.ocs?.data?.id;
      const g = await pageFetch(page, `/ocs/v2.php/cloud/users/${encodeURIComponent(id)}/groups?format=json`, { headers: h });
      const groups = g.body?.ocs?.data?.groups ?? [];
      return { username: id, displayName: me.body?.ocs?.data?.['display-name'], admin: groups.includes('admin'), groups, groupsStatus: g.status };
    },
  },
  'open-webui': {
    sub: 'open-webui',
    // Role follows the per-app claim openwebui_role on every sign-in (OAuth role management). Open WebUI still
    // makes the very first account admin; the next sign-in corrects it once a second user exists.
    start: { path: '/auth', click: [{ name: /^Get started/i, optional: true }, /^Continue with /i] },
    // The "Get started" splash shows only while the instance has no users.
    settle: 5000,
    // Open WebUI keeps its JWT in localStorage.token (also the `token` cookie); /api/v1/auths/ returns the
    // user with role admin | user | pending.
    whoami: async ({ page }) => {
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const r = await pageFetch(page, '/api/v1/auths/', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const u = r.body ?? {};
      return { username: u.email ?? u.name, name: u.name, admin: u.role === 'admin', role: u.role, status: r.status };
    },
  },
  immich: {
    sub: 'immich',
    // The manifest's sso.entry: the login page starts the OAuth flow itself. The page script finishes the
    // callback (/auth/login?code=…) and sets the immich_access_token cookie.
    start: { path: '/auth/login?autoLaunch=1' },
    settle: 6000,
    // isAdmin follows the per-app claim immich_role (oauth.roleClaim), synced on every sign-in.
    whoami: async ({ page }) => {
      const r = await pageFetch(page, '/api/users/me');
      return { username: r.body?.email, name: r.body?.name, admin: Boolean(r.body?.isAdmin), status: r.status };
    },
  },
  kavita: {
    sub: 'kavita',
    // Known limit: Kavita's role sync would also take library access from the token, so it is off; YouEye ID
    // accounts are provisioned with reading roles and Kavita's own first account stays its admin.
    expect: { admin: { admin: false } },
    start: { path: '/login', click: / ID$/ },
    settle: 6000,
    // The web app keeps the signed-in user (with roles) in localStorage 'kavita-user'.
    whoami: async ({ page }) => {
      const u = await page.evaluate(() => JSON.parse(localStorage.getItem('kavita-user') || 'null'));
      if (!u) return { error: 'no kavita-user in localStorage' };
      return { username: u.username, email: u.email, admin: (u.roles ?? []).includes('Admin'), roles: (u.roles ?? []).join(',') };
    },
  },
  'paperless-ngx': {
    sub: 'paperless-ngx',
    // Regular login is off: the login page shows only the YouEye ID button (named after the box).
    start: { path: '/accounts/login/', click: /.+/ },
    settle: 5000,
    // Superuser follows YouEye ID's admin group on every sign-in (PAPERLESS_SOCIAL_ACCOUNT_SYNC_SUPERUSER_GROUP).
    whoami: async ({ page }) => {
      const r = await pageFetch(page, '/api/ui_settings/');
      const u = r.body?.user ?? {};
      return { username: u.username, admin: Boolean(u.is_superuser), staff: u.is_staff, status: r.status };
    },
  },
  hedgedoc: {
    sub: 'hedgedoc',
    // HedgeDoc 1.x has no admin role at all: everyone is a plain user.
    expect: { admin: { admin: false } },
    start: { path: '/auth/oauth2' },
    // /me gives the display name; the stored OAuth profile (on the box) has the username.
    whoami: async ({ page }) => {
      const r = await pageFetch(page, '/me');
      const rows = psql('youeye-postgres', 'youeye', 'hedgedoc', `select profile::json->>'username' from "Users" where id='${String(r.body?.id).replace(/[^0-9a-f-]/gi, '')}'`);
      if (rows == null) return { skipped: 'BOX_SSH not set', name: r.body?.name };
      return { username: rows[0]?.[0], name: r.body?.name, admin: false, status: r.status };
    },
  },
  mealie: {
    sub: 'mealie',
    // Password login is off, so the login page shows only the YouEye ID button. Its page script finishes the
    // callback (/login?code=…) and keeps the token in the mealie.access_token cookie.
    start: { path: '/login', click: /^Login with /i },
    settle: 6000,
    whoami: async ({ page, context }) => {
      const token = (await context.cookies()).find((c) => c.name === 'mealie.access_token')?.value;
      if (!token) return { error: 'no mealie.access_token cookie' };
      const r = await pageFetch(page, '/api/users/self', { headers: { Authorization: `Bearer ${token}` } });
      return { username: r.body?.username, email: r.body?.email, admin: Boolean(r.body?.admin), status: r.status };
    },
  },
  vikunja: {
    sub: 'vikunja',
    // Local login is off, so Vikunja goes straight to YouEye ID.
    start: { path: '/' },
    // Vikunja keeps its JWT in localStorage.token; /api/v1/user is the signed-in user with `is_admin`.
    // Known gap (2026-11-13): Vikunja 2.5 has an instance-admin flag (`vikunja user set-admin`) but no OIDC
    // mapping, so OIDC users are never admin.
    expect: { admin: { admin: false } },
    whoami: async ({ page }) => {
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const r = await pageFetch(page, '/api/v1/user', { headers: { Authorization: `Bearer ${token}` } });
      const u = r.body ?? {};
      return { username: u.username, admin: Boolean(u.is_admin ?? u.isAdmin), keys: Object.keys(u).join(','), status: r.status };
    },
  },
  homebox: {
    sub: 'homebox',
    // Homebox has no admin role (each person owns their collections): "no mapping", so admin=false is expected.
    expect: { admin: { admin: false } },
    start: { path: '/' },
    settle: 5000,
    // /api/v1/users/self uses the session cookie the OIDC callback set.
    whoami: async ({ page }) => {
      const r = await pageFetch(page, '/api/v1/users/self');
      const u = r.body?.item ?? r.body ?? {};
      return { username: u.email ?? u.name, name: u.name, admin: Boolean(u.isSuperuser), status: r.status };
    },
  },
  'gramps-web': {
    sub: 'gramps-web',
    // Role follows the per-app claim gramps_role (admin -> Gramps admin 5, everyone else editor 3) at every sign-in.
    start: { path: '/' },
    settle: 6000,
    whoami: async ({ page }) => {
      const token = await page.evaluate(() => localStorage.getItem('access_token') || localStorage.getItem('token'));
      const r = await pageFetch(page, '/api/users/-/', { headers: { Authorization: `Bearer ${token}` } });
      return { username: r.body?.name, admin: (r.body?.role ?? 0) >= 4, role: r.body?.role, status: r.status };
    },
  },
  trek: {
    sub: 'trek',
    // OIDC_ADMIN_CLAIM=groups / OIDC_ADMIN_VALUE=admin promote and demote at every sign-in.
    start: { path: '/login', click: [{ name: /ID$|YouEye|Sign in with/i, optional: true }] },
    settle: 5000,
    whoami: async ({ page }) => {
      const r = await pageFetch(page, '/api/auth/me');
      const u = r.body?.user ?? {};
      return { username: u.username, email: u.email, admin: u.role === 'admin', role: u.role, status: r.status };
    },
  },
  ghostfolio: {
    sub: 'ghostfolio',
    // Known limit: the FIRST person to sign in becomes ADMIN (no claim mapping upstream; the listing tells the owner
    // to sign in first). Passes because admin runs before user.
    start: { path: '/api/auth/oidc' },
    settle: 6000,
    // Ghostfolio stores no username or email (it keeps only the OIDC sub), so the signed-in name can't be read back:
    // a 200 for this session's own account stands in for it, and the ids show the two people get separate accounts.
    whoami: async ({ page, who }) => {
      const token = await page.evaluate(() => localStorage.getItem('auth-token') || sessionStorage.getItem('auth-token'));
      const r = await pageFetch(page, '/api/v1/user', { headers: { Authorization: `Bearer ${token}` } });
      return { username: r.status === 200 && r.body?.id ? USERS[who].username : undefined, id: r.body?.id, admin: (r.body?.permissions ?? []).includes('accessAdminControl'), status: r.status };
    },
  },
  'calibre-web-automated': {
    sub: 'calibre-web-automated',
    // Admin follows YouEye ID's admin group at every sign-in (oauth_admin_group, exact match).
    start: { path: '/login', click: /YouEye ID/i },
    settle: 4000,
    whoami: async ({ page }) => {
      const me = await pageFetch(page, '/me');
      const name = String(me.body).match(/id="top_user"[\s\S]*?<span class="hidden-sm">([^<]+)</)?.[1]?.trim();
      const adm = await pageFetch(page, '/admin/view');
      return { username: name, admin: adm.status === 200 && /admin/i.test(String(adm.body).slice(0, 4000)) && !/name="password"/.test(String(adm.body)), adminStatus: adm.status };
    },
  },
  // Native apps (YouEye-Canvas): opening the app without a session redirects to /api/auth/sso and YouEye ID.
  // The app's own session is a signed JWT cookie `ye-<id>-session` carrying username and isAdmin
  // (isAdmin = any YouEye group containing "admin"), which the app trusts on every request.
  ...Object.fromEntries(['notes', 'wiki', 'search', 'translate', 'weather', 'cinema'].map((id) => [id, {
    sub: id,
    native: true,
    start: { path: '/' },
    whoami: async ({ context }) => {
      const cookie = (await context.cookies()).find((c) => c.name === `ye-${id}-session`);
      if (!cookie) return { error: `no ye-${id}-session cookie` };
      const claims = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString());
      return { username: claims.username, admin: claims.isAdmin === true, groups: claims.groups };
    },
  }])),
};
