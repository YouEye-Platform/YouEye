// Run: node --test tests/names-setup-recovery.spec.mjs
// Plan 8 item 15: coming back to a claimed name, choosing a different one,
// and resuming the Names job at Control Panel start.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const load = (file, name, context) => {
  const source = stripTypeScriptTypes(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    .replace(/^import [\s\S]*?;\n/gm, '').replace(/^export (?=async function|function|const)/gm, '');
  return runInNewContext(`${source}\n${name}`, { NextResponse: { json: (body, init) => Response.json(body, init) }, ...context });
};

const lifecycle = (status, extra = {}) => ({ name: 'calm-river', fqdn: 'calm-river.ui.bingo', status, ...extra });
const statusOf = (state) => !state || state.status === 'released'
  ? { name: null, fqdn: null, stage: 'none', running: false, error: null }
  : { name: state.name, fqdn: state.fqdn, stage: state.status === 'provisioning' ? 'certificate_waiting' : 'ready', running: false, error: null };

function reuseRoute({ state, setupCompleted = false, bundle = null }) {
  return load('app/api/tls/youeye-names/reuse/route.ts', 'GET', {
    getSession: async () => ({ isAdmin: true, authMethod: 'setup' }),
    readNamesLifecycleState: async () => state,
    settingsService: { getRaw: async () => ({ setup_completed: setupCompleted }) },
    namesJobStatusOf: statusOf,
    getStagedBundle: async () => bundle,
  });
}

test('coming back during setup offers the name this server already claimed', async () => {
  for (const status of ['provisioning', 'healthy']) {
    const body = await (await reuseRoute({ state: lifecycle(status) })()).json();
    assert.equal(body.reuse, false);
    assert.equal(body.lease.name, 'calm-river');
    assert.equal(body.lease.fqdn, 'calm-river.ui.bingo');
    assert.doesNotMatch(JSON.stringify(body), /privateKeyPem|csrPem/);
  }
  // Released, absent, or after setup: nothing to continue with.
  assert.equal((await (await reuseRoute({ state: lifecycle('released') })()).json()).lease, null);
  assert.equal((await (await reuseRoute({ state: null })()).json()).lease, null);
  assert.equal((await (await reuseRoute({ state: lifecycle('healthy'), setupCompleted: true })()).json()).lease, null);
  // A staged installer bundle is still reported as before.
  const staged = await (await reuseRoute({ state: null, bundle: { name: 'saved', fqdn: 'saved.ui.bingo' } })()).json();
  assert.deepEqual([staged.reuse, staged.name, staged.fqdn], [true, 'saved', 'saved.ui.bingo']);
});

function releaseRoute({ state, settings }) {
  const effects = { revoked: 0, released: 0, patches: [], state };
  const post = load('app/api/tls/youeye-names/release/route.ts', 'POST', {
    getSession: async () => ({ isAdmin: true, authMethod: 'setup' }),
    verifyCSRFToken: async () => true,
    readNamesLifecycleState: async () => effects.state,
    updateNamesLifecycleState: async (update) => { effects.state = update(effects.state); return effects.state; },
    settingsService: { getRaw: async () => settings },
    spineClient: { patchConfig: async (patch) => { effects.patches.push(patch); } },
    getCurrentCertificate: async () => null,
    revokeCertificate: async () => { effects.revoked++; },
    releaseName: async () => { effects.released++; },
    namesErrorMessage: () => 'unavailable',
  });
  const request = (confirmation) => ({ headers: new Headers({ 'X-CSRF-Token': 'ok' }), json: async () => ({ confirmation }) });
  return { post, request, effects };
}

test('choosing a different name during setup releases the claimed one and reruns every provisioning step', async () => {
  const route = releaseRoute({
    state: lifecycle('provisioning', { provisioning: { stage: 'certificate_waiting', privateKeyPem: 'key', csrPem: 'csr' } }),
    // The config step may already have saved this name as the domain.
    settings: { setup_completed: false, domain: 'calm-river.ui.bingo' },
  });
  assert.equal((await route.post(route.request('calm-river.ui.bingo'))).status, 200);
  assert.equal(route.effects.released, 1);
  assert.equal(route.effects.state.status, 'released');
  assert.equal(route.effects.state.provisioning, null, 'no resumable key or CSR survives a release');
  assert.equal(JSON.stringify(route.effects.patches), JSON.stringify([{ setup_steps: {}, setup_step_errors: null, setup_step_times: null }]));
  // The exact name must be confirmed.
  const unconfirmed = releaseRoute({ state: lifecycle('healthy'), settings: { setup_completed: false } });
  assert.equal((await unconfirmed.post(unconfirmed.request('calm-river'))).status, 400);
  assert.equal(unconfirmed.effects.released, 0);
});

test('after setup the name in use still cannot be released', async () => {
  const route = releaseRoute({ state: lifecycle('healthy'), settings: { setup_completed: true, domain: 'calm-river.ui.bingo' } });
  assert.equal((await route.post(route.request('calm-river.ui.bingo'))).status, 409);
  assert.equal(route.effects.released, 0);
  assert.equal(route.effects.patches.length, 0);
});

test('a Names job interrupted during setup resumes at Control Panel start, without the maintenance delay', async () => {
  const resume = ({ state, setupCompleted }) => {
    const calls = { follow: 0 };
    const fn = load('lib/youeye-names/maintenance.ts', 'resumeNamesJobAtStart', {
      readNamesLifecycleState: async () => state,
      settingsService: { getRaw: async () => ({ setup_completed: setupCompleted }) },
      followNamesJob: async () => { calls.follow++; },
      setTimeout, setInterval, console, process,
    });
    return { fn, calls };
  };
  const during = resume({ state: lifecycle('provisioning'), setupCompleted: false });
  assert.equal(await during.fn(), true);
  assert.equal(during.calls.follow, 1);
  for (const [state, setupCompleted] of [[lifecycle('healthy'), false], [null, false], [lifecycle('provisioning'), true]]) {
    const other = resume({ state, setupCompleted });
    assert.equal(await other.fn(), false);
    assert.equal(other.calls.follow, 0);
  }
  const maintenance = readFileSync(new URL('../src/lib/youeye-names/maintenance.ts', import.meta.url), 'utf8');
  const loop = maintenance.slice(maintenance.indexOf('export function startNamesMaintenanceLoop'));
  assert.ok(loop.indexOf('resumeNamesJobAtStart()') < loop.indexOf('const initialDelay'));
});

test('wizard order: address, human check (the Names job starts), title, confirm, provisioning', () => {
  const page = readFileSync(new URL('../src/app/setup/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /onNewSetup=\{\(\) => goToStep\(0\)\}/);
  assert.match(page, /goToStep\(tlsChoice === 'youeye-names' && !yenReusing && !yenLeaseHeld \? 3 : 1\)/);
  assert.match(page, /onVerified=\{\(proof, kind\) => \{ void startNamesJob\(proof, kind\); \}\}/);
  const start = page.slice(page.indexOf('const startNamesJob = useCallback'));
  assert.ok(start.indexOf("fetch('/api/setup/names/start'") < start.indexOf('setYenLeaseHeld(true);'));
  assert.ok(start.indexOf('setYenLeaseHeld(true);') < start.indexOf('goToStep(1);'));
  assert.match(page, /onContinue=\{\(\) => goToStep\(2\)\}\s*onBack=\{\(\) => goToStep\(0, 'back'\)\}/);
  assert.match(page, /onClick=\{\(\) => goToStep\(4\)\}/);
  // Provisioning carries only the claimed name, never the one-use proof.
  const run = page.slice(page.indexOf("fetch('/api/setup/run'"), page.indexOf('setupProgressOptions());'));
  assert.doesNotMatch(run, /proof|verified_setup_session|yen_terms_version/);
  // The address step offers to continue with, or release, a name already claimed.
  const address = readFileSync(new URL('../src/components/setup/SetupServerName.tsx', import.meta.url), 'utf8');
  assert.match(address, /d\?\.lease\?\.name && d\.lease\.fqdn[\s\S]*setYenLeaseHeld\?\.\(true\)/);
  assert.match(address, /fetch\('\/api\/tls\/youeye-names\/release'[\s\S]*confirmation: lease\.fqdn/);
});
