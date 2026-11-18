// The app's security state an update must not roll back across (update-provider.ts securityParts), on the shapes
// production writes: install.json with updatedAt and update-owned fields, an app directory with a secrets/ tree, the
// real credential projection and admission snapshot.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

type Entry = { kind: 'file'; bytes: Buffer } | { kind: 'dir' } | { kind: 'link' };

function fixture() {
  const state = {
    metadata: {
      schema: 'youeye.install.v1', appId: 'fixture', installationId: 'inst-1', admissionOwnerId: 'owner-1',
      integration: 'basic', enableSSO: true, hasSSO: true, ssoClientId: 'client-1', subdomain: 'fixture',
      domain: 'warm-shore.ui.bingo', serviceCredentialState: 'ready', installedVersion: '1.0.0',
      updatedAt: '2026-11-18T01:00:00.000Z', manifestDigest: 'sha256:aaaa', containers: [{ name: 'main', containerName: 'app-fixture' }],
    } as Record<string, unknown>,
    credential: {
      schema: 'youeye.app-service-credential.v1', appId: 'fixture', installationId: 'inst-1', generation: 1, revision: 3,
      status: 'active', verifierHash: 'v'.repeat(64), createdAt: '2026-11-01T00:00:00Z', rotatedAt: null, revokedAt: null, expiresAt: null,
    } as Record<string, unknown>,
    admission: {
      policy: { appId: 'fixture', installationId: 'inst-1', ownerId: 'owner-1', mode: 'all_users', userIds: [], groupIds: [],
        revision: 4, state: 'active', publicAccess: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' },
      reconciled: true,
      principals: [{ id: 'owner-1', active: true }],
    } as { policy: Record<string, unknown>; reconciled: boolean; principals: Array<Record<string, unknown>> },
    files: new Map<string, Entry>([
      ['install.json', { kind: 'file', bytes: Buffer.from('{}') }],
      ['secrets', { kind: 'dir' }],
      ['secrets/secret_key', { kind: 'file', bytes: Buffer.from('k1') }],
      ['secrets/db_password', { kind: 'file', bytes: Buffer.from('p1') }],
    ]),
  };
  const base = '/var/lib/youeye/app-fixture';
  const relative = (path: string) => path === base ? '' : path.slice(base.length + 1);
  const output = ts.transpileModule(readFileSync(new URL('../src/lib/market/update-provider.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output + '\nexports.parts = securityParts;')((name: string) => {
    if (name === 'node:fs/promises') return {
      readdir: async (path: string) => {
        const prefix = relative(path);
        return [...state.files.keys()].filter(key => prefix ? key.startsWith(`${prefix}/`) && !key.slice(prefix.length + 1).includes('/') : !key.includes('/'))
          .map(key => key.split('/').pop()!);
      },
      lstat: async (path: string) => {
        const entry = state.files.get(relative(path))!;
        return { isDirectory: () => entry.kind === 'dir', isFile: () => entry.kind === 'file', size: entry.kind === 'file' ? entry.bytes.length : 0 };
      },
      readFile: async (path: string) => (state.files.get(relative(path)) as { bytes: Buffer }).bytes,
    };
    if (name === './metadata') return { readInstallMetadata: async () => structuredClone(state.metadata) };
    if (name === './update-workspace') return { updateDigest: (s: string | Buffer) => createHash('sha256').update(s).digest('hex') };
    if (name === '../apps/service-credential-store') return { appServiceCredentials: { projection: async () => structuredClone(state.credential) } };
    if (name === '../admission/store') return { getAdmissionSnapshot: async () => structuredClone(state.admission) };
    if (name === '../identity/store') return { identityRows: async () => [], identitySql: (s: string) => s };
    if (name === './update-inventory') return { AppUpdatePreflightError: class extends Error { constructor(readonly code: string, message: string) { super(message); } } };
    return {};
  }, exports);
  return { state, exports, parts: () => exports.parts(structuredClone(state.metadata)) };
}

async function changedParts(change: (state: ReturnType<typeof fixture>['state']) => void) {
  const f = fixture();
  const before = await f.parts();
  change(f.state);
  const after = await f.parts();
  return Object.keys(after).filter(key => after[key] !== before[key]);
}

test('what an update writes itself, other users and policy timestamps are not security changes', async () => {
  assert.deepEqual(await changedParts(state => {
    state.metadata.updatedAt = '2026-11-18T02:00:00.000Z';
    state.metadata.installedVersion = '1.1.0';
    state.metadata.manifestDigest = 'sha256:bbbb';
    state.metadata.containers = [{ name: 'main', containerName: 'app-fixture', healthCheck: { type: 'http' } }];
    state.metadata.productReleaseFloors = { track: { sequence: 2 } };
    state.admission.principals.push({ id: 'new-user', active: true });
    state.admission.policy.updatedAt = '2026-11-18T02:00:00Z';
    state.credential.rotatedAt = null;
  }), []);
});

test('each kind of security change is detected, and named', async () => {
  assert.deepEqual(await changedParts(state => { state.credential.revision = 4; }), ['credential']);
  assert.deepEqual(await changedParts(state => { state.metadata.admissionOwnerId = 'owner-2'; }), ['metadata']);
  assert.deepEqual(await changedParts(state => { state.metadata.enableSSO = false; }), ['metadata']);
  assert.deepEqual(await changedParts(state => { state.admission.policy.revision = 5; }), ['admission']);
  assert.deepEqual(await changedParts(state => { state.files.set('secrets/secret_key', { kind: 'file', bytes: Buffer.from('k2') }); }), ['files']);
  assert.deepEqual(await changedParts(state => { state.files.set('secrets/new_key', { kind: 'file', bytes: Buffer.from('n') }); }), ['files']);
});

test('a secrets/ directory is read, not refused; links and devices are refused', async () => {
  const f = fixture();
  await f.parts();
  f.state.files.set('secrets/linked', { kind: 'link' });
  await assert.rejects(f.parts(), /not a bounded regular file/);
});

test('recovery names what changed and never dead-ends; plans from older builds report nothing', async () => {
  const f = fixture();
  const provider = new f.exports.IncusAppUpdateProvider();
  const plan: Record<string, unknown> = { securityParts: await f.parts() };
  provider.load = () => plan;
  assert.deepEqual(await provider.securityChanges({ appId: 'fixture' }), []);
  f.state.credential.revision = 9;
  f.state.metadata.updatedAt = '2026-11-18T03:00:00.000Z';
  assert.deepEqual(await provider.securityChanges({ appId: 'fixture' }), ['credential']);
  // A 0.6.7 plan holds only an overall revision from the old function: it can't be compared, and isn't fatal.
  delete plan.securityParts;
  plan.securityRevision = 'from-an-older-build';
  assert.deepEqual(await provider.securityChanges({ appId: 'fixture' }), []);
});
