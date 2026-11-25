/**
 * YE-154: "Only <site> users" is the one control for an app's gate. On keeps the admission gate (the policy's
 * people); off is public access. The default comes from the manifest's `public_access`; apps with no sign-in of
 * their own, or that trust the gate's login header, stay locked on. Data stays v1: the switch writes the policy's
 * `publicAccess`, the install record's `forwardAuthEnabled` is dual-written, and the old `forwardAuthGate` input maps.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { appFixture } from './fixtures/app-format';
import { load, root } from './fixtures/market-world';
import { freeLifecycle } from './fixtures/free-lifecycle';
import {
  accessSwitchState, defaultOnlyUsers, explicitInstallPublicAccess, gateOnlyReason, installAccessFields,
} from '../src/lib/market/public-access';
import { installWantsPublicAccess } from '../src/lib/market/engine';
import { OFFICIAL_MARKET_SOURCE_ID } from '../src/lib/market/source';

const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const OFFICIAL = OFFICIAL_MARKET_SOURCE_ID;

// Apps shaped like the catalog's (YE-AppMarket dev): only the fields the decision reads.
const secrets = { admin_password: { length: 24 } };
const searxng = appFixture({ id: 'searxng', name: 'SearXNG' });
const navidrome = appFixture({ id: 'navidrome', name: 'Navidrome',
  env: { ND_EXTAUTH_USERHEADER: 'X-YouEye-Username', ND_EXTAUTH_TRUSTEDSOURCES: '${app.network_cidr}' } });
const openWebUI = appFixture({ id: 'open-webui', name: 'Open WebUI',
  sso: { callback: '/oauth/oidc/callback', env: { OAUTH_CLIENT_ID: '${sso.client_id}' } } });
const qbittorrent = appFixture({ id: 'qbittorrent', name: 'qBittorrent', secrets,
  credentials: [{ label: 'WebUI Administrator', username: 'admin', password: 'admin_password' }] });
const razzia = appFixture({ id: 'razzia', name: 'Razzia', public_access: true });

test('locked on: no sign-in of its own, or the login header; Open WebUI and apps with accounts can be opened', () => {
  assert.equal(gateOnlyReason(searxng, true), 'no-sign-in');
  assert.equal(gateOnlyReason(navidrome, true), 'login-header');
  assert.equal(gateOnlyReason(openWebUI, true), null);
  assert.equal(gateOnlyReason(qbittorrent, true), null);
  // `public_access: true` is the catalog saying the app protects itself; only the official catalog's counts.
  assert.equal(gateOnlyReason(razzia, true), null);
  assert.equal(gateOnlyReason(razzia, false), 'no-sign-in');
  // Trusting the header wins over everything else: opened, anyone could send it.
  const headerWithSSO = appFixture({ sso: { callback: '/cb' }, public_access: true,
    env: { REMOTE_USER_HEADER: 'X-YouEye-Email' } });
  assert.equal(gateOnlyReason(headerWithSSO, true), 'login-header');
});

test('the install dialog starts from the manifest and sends one meaning', () => {
  // Default: off only for apps that protect themselves (official `public_access`), never for gate-only apps.
  assert.equal(defaultOnlyUsers({}), true);
  assert.equal(defaultOnlyUsers({ publicAccess: true }), false);
  assert.equal(defaultOnlyUsers({ publicAccess: true, gateOnly: 'no-sign-in' }), true);

  // Open WebUI with the switch off: public access, and its YouEye ID sign-in row is its own.
  const webui = { supportsSSO: true, integrations: [] };
  assert.deepEqual(installAccessFields(webui, { onlyUsers: false, youEyeSignIn: true }),
    { publicAccess: true, protectWithAccountLogin: true });
  assert.deepEqual(installAccessFields(webui, { onlyUsers: true, youEyeSignIn: true }),
    { publicAccess: false, protectWithAccountLogin: true });
  // A plain app: the old account-login flag is the gate, so it follows the switch.
  assert.deepEqual(installAccessFields({ supportsSSO: false }, { onlyUsers: false, youEyeSignIn: true }),
    { publicAccess: true, protectWithAccountLogin: false });
  // SearXNG: locked on, whatever the switch state says.
  assert.deepEqual(installAccessFields({ supportsSSO: false, gateOnly: 'no-sign-in' }, { onlyUsers: false, youEyeSignIn: false }),
    { publicAccess: false, protectWithAccountLogin: true });
  // A setup-file sign-in (identity integration) is an own login too.
  assert.deepEqual(installAccessFields({ supportsSSO: false, integrations: [{ id: 'youeye-id', name: 'YouEye ID', type: 'identity' }] },
    { onlyUsers: true, youEyeSignIn: false }), { publicAccess: false, protectWithAccountLogin: false });
});

test('the install API maps every input onto the one meaning; gate-only apps never open', () => {
  assert.equal(explicitInstallPublicAccess({ publicAccess: true }), true);
  assert.equal(explicitInstallPublicAccess({ publicAccess: false, forwardAuthGate: false }), false);
  // The old extra-gate flag: on means "only users"; off never opened an app before, so it is no choice.
  assert.equal(explicitInstallPublicAccess({ forwardAuthGate: true }), false);
  assert.equal(explicitInstallPublicAccess({ forwardAuthGate: false }), undefined);
  assert.equal(explicitInstallPublicAccess({}), undefined);

  assert.equal(installWantsPublicAccess(openWebUI, { sourceId: OFFICIAL, publicAccess: true }), true);
  assert.equal(installWantsPublicAccess(openWebUI, { sourceId: OFFICIAL }), false, 'no public_access: only users');
  assert.equal(installWantsPublicAccess(razzia, { sourceId: OFFICIAL }), true);
  assert.equal(installWantsPublicAccess(razzia, { sourceId: OFFICIAL, forwardAuthGate: true }), false);
  assert.equal(installWantsPublicAccess(razzia, { sourceId: OFFICIAL, forwardAuthGate: false }), true);
  // The CLI's --public-access cannot open a gate-only app.
  assert.equal(installWantsPublicAccess(searxng, { sourceId: OFFICIAL, publicAccess: true }), false);
  assert.equal(installWantsPublicAccess(navidrome, { sourceId: OFFICIAL, publicAccess: true }), false);
});

test('Access settings: the switch shows the policy, never the record; "Opening to everyone…" until applied', () => {
  const policy = { appId: 'open-webui', installationId: 'i', ownerId: 'o', mode: 'owner' as const, userIds: [], groupIds: [],
    revision: 3, state: 'ready' as const, publicAccess: false };
  // A 0.6.18 install of Open WebUI: record `forwardAuthEnabled: false` (no extra gate), policy owner-only. The switch
  // reads the policy only, so after the update it shows "on"; "Who may enter" is always there (YE-232).
  assert.deepEqual(accessSwitchState({ policy, reconciliation: 'applied' }, null),
    { onlyUsers: true, locked: false, opening: false, publicWhoHint: false });
  // Switched off: on its way, then saved but not applied, then applied.
  assert.equal(accessSwitchState({ policy, reconciliation: 'applied' }, true).opening, true);
  assert.equal(accessSwitchState({ policy, reconciliation: 'applied' }, true).publicWhoHint, true);
  const open = { ...policy, publicAccess: true };
  assert.deepEqual(accessSwitchState({ policy: open, reconciliation: 'pending' }, null),
    { onlyUsers: false, locked: false, opening: true, publicWhoHint: true });
  assert.equal(accessSwitchState({ policy: open, reconciliation: 'applied' }, null).opening, false);
  // SearXNG: locked on; one that an administrator opened before 0.6.19 can still be closed.
  assert.equal(accessSwitchState({ policy, reconciliation: 'applied', gateOnly: 'no-sign-in' }, null).locked, true);
  assert.equal(accessSwitchState({ policy: open, reconciliation: 'applied', gateOnly: 'no-sign-in' }, null).locked, false);
});

/** The access route over mocks: `policy` is the stored one, `gateOnly` the installed app's lock. */
function accessRoute(state: { policy: any; gateOnly: 'no-sign-in' | 'login-header' | null }) {
  const updates: any[] = [];
  const records: Array<[string, boolean]> = [];
  const session = async () => ({ session: { username: 'owner', isAdmin: true } });
  const route = load('src/app/api/market/apps/[appId]/access/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    '@/lib/market/update-admission': freeLifecycle,
    '@/lib/http/lifecycle-busy': { isLifecycleBusy: () => false, lifecycleBusyResponse: () => null },
    '@/lib/market/install-tracker': { logOperationFailure: () => {} },
    '@/lib/auth/rbac': { requireAdmin: session },
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/admission/store': {
      getAdmissionPolicy: async () => structuredClone(state.policy),
      updateAdmissionPolicy: async (input: any) => { updates.push(input); state.policy = { ...input.policy, revision: input.policy.revision + 1 }; return state.policy; },
    },
    '@/lib/admission/management': {
      admissionAdministrator: async () => '10000000-0000-4000-8000-000000000001',
      admissionManagementData: async () => ({ users: [], groups: [], resources: [] }),
      quarantineAdmissionData: async () => {},
    },
    '@/lib/admission/projection': { reconcileAdmissionProjections: async () => {}, admissionReconciliationState: async () => 'pending' },
    '@/lib/market/access-switch': {
      installedGateOnlyReason: async () => state.gateOnly,
      installedAccessFacts: async () => ({ gateOnly: state.gateOnly, host: 'app.example.test', youEyeSignIn: false, siteName: 'Byka' }),
      recordOnlyUsers: async (appId: string, onlyUsers: boolean) => { records.push([appId, onlyUsers]); return true; },
    },
  });
  const put = (appId: string, policy: any) => route.PUT(new Request('https://cp.example.test/api', { method: 'PUT',
    body: JSON.stringify({ policy, expectedRevision: policy.revision }) }), { params: Promise.resolve({ appId }) });
  return { route, put, updates, records };
}

test('the Access route opens Open WebUI, refuses to open SearXNG, and dual-writes the record', async () => {
  const base = { installationId: 'i', ownerId: '10000000-0000-4000-8000-000000000001', mode: 'owner', userIds: [], groupIds: [],
    revision: 1, state: 'ready', publicAccess: false };

  const webui = accessRoute({ policy: { ...base, appId: 'open-webui' }, gateOnly: null });
  const opened = await webui.put('open-webui', { ...base, appId: 'open-webui', publicAccess: true });
  assert.equal(opened.status, 202, 'saved, not applied yet');
  const body = await opened.json();
  assert.equal(body.policy.publicAccess, true);
  assert.equal(body.reconciliation, 'pending');
  assert.equal(body.host, 'app.example.test');
  assert.deepEqual(webui.records, [['open-webui', false]], 'the record follows: no longer "only users"');

  const searx = accessRoute({ policy: { ...base, appId: 'searxng' }, gateOnly: 'no-sign-in' });
  const refused = await searx.put('searxng', { ...base, appId: 'searxng', publicAccess: true });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).gateOnly, 'no-sign-in');
  assert.equal(searx.updates.length, 0, 'nothing saved');
  assert.equal(searx.records.length, 0);
  // Who may enter still changes while the switch stays on.
  assert.equal((await searx.put('searxng', { ...base, appId: 'searxng', mode: 'all_users' })).status, 202);
  assert.deepEqual(searx.records, [['searxng', true]]);

  // A gate-only app opened before 0.6.19 can be closed (and saved while open) but not reopened once closed.
  const legacy = accessRoute({ policy: { ...base, appId: 'navidrome', publicAccess: true }, gateOnly: 'login-header' });
  assert.equal((await legacy.put('navidrome', { ...base, appId: 'navidrome', publicAccess: true })).status, 202);
  assert.equal((await legacy.put('navidrome', { ...base, appId: 'navidrome', revision: 2, publicAccess: false })).status, 202);
  assert.equal((await legacy.put('navidrome', { ...base, appId: 'navidrome', revision: 3, publicAccess: true })).status, 409);
});

test('the record dual-write: apps without their own login follow the switch; a 0.6.18 SSO record keeps its flag', async () => {
  const records: Record<string, any> = {
    searxng: { appId: 'searxng', enableSSO: false, forwardAuthEnabled: true, protectWithAccountLogin: true, sourceId: OFFICIAL },
    razzia: { appId: 'razzia', enableSSO: false, forwardAuthEnabled: true, protectWithAccountLogin: true, sourceId: OFFICIAL },
    'open-webui': { appId: 'open-webui', enableSSO: true, forwardAuthEnabled: false, protectWithAccountLogin: true, sourceId: OFFICIAL },
    nextcloud: { appId: 'nextcloud', enableSSO: false, selectedIntegrations: ['youeye-id'], forwardAuthEnabled: false, sourceId: OFFICIAL },
  };
  const saved: string[] = [];
  const store: Array<[string, boolean]> = [];
  const manifests: Record<string, any> = { searxng, razzia, 'open-webui': openWebUI };
  const accessSwitch = load('src/lib/market/access-switch.ts', {
    './frozen-manifest': { readInstalledAppManifest: async (appId: string) => {
      if (!manifests[appId]) throw new Error('no frozen copy');
      return manifests[appId];
    } },
    './installed-apps': { updateForwardAuthEnabled: async (appId: string, enabled: boolean) => { store.push([appId, enabled]); } },
    './metadata': {
      readInstallMetadata: async (appId: string) => structuredClone(records[appId] ?? null),
      saveInstallMetadata: async (value: any) => { saved.push(value.appId); records[value.appId] = value; },
    },
    './public-access': { gateOnlyReason },
    './source': { OFFICIAL_MARKET_SOURCE_ID: OFFICIAL },
    './update-admission': { withAppLifecycle: async (_appId: string, work: () => unknown) => work() },
    './platform-env': { getPlatformContext: async () => ({ siteName: 'Byka' }) },
  });

  assert.equal(await accessSwitch.recordOnlyUsers('razzia', false), true);
  assert.equal(records.razzia.forwardAuthEnabled, false);
  assert.equal(records.razzia.protectWithAccountLogin, false);
  assert.deepEqual(store, [['razzia', false]]);
  assert.equal(await accessSwitch.recordOnlyUsers('razzia', false), false, 'unchanged: nothing written');
  // Apps with their own YouEye ID login keep the flag (the independent copy reads it with the old meaning).
  assert.equal(await accessSwitch.recordOnlyUsers('open-webui', false), false);
  assert.equal(await accessSwitch.recordOnlyUsers('nextcloud', true), false);
  assert.equal(records['open-webui'].forwardAuthEnabled, false);
  assert.deepEqual(saved, ['razzia']);

  assert.equal(await accessSwitch.installedGateOnlyReason('searxng'), 'no-sign-in');
  assert.equal(await accessSwitch.installedGateOnlyReason('open-webui'), null);
  assert.equal(await accessSwitch.installedGateOnlyReason('nextcloud'), 'no-sign-in', 'no readable model: locked (the safe side)');
  assert.equal(await accessSwitch.installedGateOnlyReason('missing'), null);
  assert.deepEqual(await accessSwitch.installedAccessFacts('open-webui'),
    { gateOnly: null, host: null, youEyeSignIn: true, siteName: 'Byka' });
});

test('a 0.6.18 install record keeps its policy across the update', () => {
  // The update keeps the record's access fields as they are …
  const provider = read('src/lib/market/update-provider.ts');
  assert.match(provider, /'forwardAuthEnabled', 'forwardAuthSlug', 'protectWithAccountLogin'/);
  // … and neither the update nor the start touches the admission policy: only the Access route and an install do.
  for (const file of ['src/lib/market/update-provider.ts', 'src/lib/market/updater.ts', 'src/lib/market/reconciler.ts',
    'src/lib/incus/startup-reconciliation.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /applyInstallPublicAccess|updateAdmissionPolicy|recordOnlyUsers/, file);
  }
  // A restore that brings back the app's own policy never applies an install choice; an old backup's record flag is
  // an access choice only where it was the optional extra gate (apps with their own login).
  const engine = read('src/lib/market/engine.ts');
  assert.match(engine, /if \(!restoreOptions\?\.restoredIdentity && config\.admissionActorId && \(wantsPublicAccess \|\| accessChoice === false\)\)/);
  assert.match(read('src/lib/backup/app-restore.ts'), /forwardAuthEnabled === 'boolean' && backedUpInstallMeta\?\.enableSSO === true/);
});

test('one control in the dialog and in Access settings, in plain words in every language', () => {
  const dialog = read('src/components/market/install-dialog.tsx');
  assert.match(dialog, /row\('only-users', translateInterface\("mc664ff9c2740", \{ site: siteName \}\), onlyUsersHint, onlyUsers, setOnlyUsers, onlyUsersLocked\)/);
  assert.doesNotMatch(dialog, /row\('public'|row\('gate'|forwardAuthGate|ma05ac86e60af|m59829f8776db/, 'no separate "publicly reachable" row');
  const access = read('src/components/market/app-access-settings.tsx');
  assert.doesNotMatch(access, /me8886dba5eee|m235d80077e2c/, 'the "publicly reachable" checkbox is gone');
  assert.match(access, /<Switch className="shrink-0" checked=\{state\.onlyUsers\}/);
  assert.match(access, /access\.opening/);
  // "Who may enter" shows for a public app too: it still decides the dashboard and YouEye ID sign-in (YE-232).
  assert.doesNotMatch(access, /showWhoList/);
  assert.match(access, /publicWhoHint && <span[^>]*>\{settingsApps\('access\.whoPublic'/);
  // Both install routes refuse any other access choice; the engine defaults to everyone (YE-232).
  for (const route of ['src/app/api/market/install/route.ts', 'src/app/api/market/install-url/route.ts']) {
    assert.match(read(route), /accessMode !== undefined && [a-z.]*accessMode !== 'all_users' && [a-z.]*accessMode !== 'owner'\) \{\s*return Response\.json\(\{ error: 'Invalid access choice: use all_users or owner' \}, \{ status: 400 \}\)/, route);
  }
  assert.match(read('src/lib/market/engine.ts'), /mode: config\.accessMode \?\? 'all_users',/);
  // The install dialog's household choice: everyone by default, "Only me", not shown when a kept policy decides.
  assert.match(dialog, /useState<'all_users' \| 'owner'>\('all_users'\)/);
  assert.match(dialog, /accessMode: existingAccess \? undefined : accessMode,/);
  assert.match(dialog, /\{!existingAccess && \(\s*<div className="space-y-1\.5">\s*<Label htmlFor="access-mode">/);

  const keys = { marketStore: ['onlyUsersOn', 'onlyUsersOnEveryone', 'onlyUsersOnKept', 'onlyUsersOff', 'onlyUsersOffSignIn',
    'onlyUsersLockedNoSignIn', 'onlyUsersLockedHeader', 'accessLabel', 'accessEveryone', 'accessOnlyMe', 'accessHint'],
  settingsApps: ['onlyUsersOn', 'whoPublic', 'opening', 'notOpen', 'stillPending', 'retry'] };
  for (const language of ['en', 'de', 'es', 'fr', 'ru']) {
    const messages = JSON.parse(read(`messages/${language}.json`));
    const texts = [...keys.marketStore.map((key) => messages.marketStore.install[key]),
      ...keys.settingsApps.map((key) => messages.settingsApps.access[key])];
    for (const text of texts) {
      assert.equal(typeof text, 'string', `${language}: every message is there`);
      assert.doesNotMatch(text, /proxy|прокси|forward|admission|допуск/i, `${language}: "${text}"`);
    }
  }
  const en = JSON.parse(read('messages/en.json'));
  assert.equal(en.marketStore.install.onlyUsersOn, 'Only you can open it. Choose who in {app} → Access.');
  assert.equal(en.marketStore.install.onlyUsersOff, 'Anyone who can reach {host} gets {app}’s own sign-in page.');
  assert.equal(en.marketStore.install.onlyUsersOffSignIn, '{site} accounts still sign in with {site} ID.');
  assert.equal(en.marketStore.install.onlyUsersLockedNoSignIn, '{app} has no sign-in of its own, so it stays for {site} users only.');
  assert.equal(en.settingsApps.access.opening, 'Opening to everyone…');
  assert.equal(en.marketStore.install.accessEveryone, 'Everyone');
  assert.equal(en.marketStore.install.accessOnlyMe, 'Only me');
});
