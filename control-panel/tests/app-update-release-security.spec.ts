import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

async function fixture() {
  const state = {
    metadata: { appId: 'fixture', installedVersion: '1.0.0', ownerId: 'owner' } as Record<string, unknown>,
    credential: { generation: 1, state: 'active' },
    admission: { policy: { generation: 1 }, principals: [{ id: 'owner' }] },
    secret: Buffer.from('fixture credential'),
  };
  const output = ts.transpileModule(readFileSync(new URL('../src/lib/market/update-provider.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output + '\nexports.revision = securityRevision;')((name: string) => {
    if (name === 'node:fs/promises') return {
      readdir: async () => ['install.json', '.credential'],
      lstat: async () => ({ isFile: () => true, size: state.secret.length }),
      readFile: async () => state.secret,
    };
    if (name === './metadata') return { readInstallMetadata: async () => state.metadata };
    if (name === './update-workspace') return { updateDigest: (s: string | Buffer) => createHash('sha256').update(s).digest('hex') };
    if (name === '../apps/service-credential-store') return { appServiceCredentials: { projection: async () => state.credential } };
    if (name === '../admission/store') return { getAdmissionSnapshot: async () => state.admission };
    if (name === '../identity/store') return { identityRows: async () => [], identitySql: (s: string) => s };
    return {};
  }, exports);
  const plan = { securityRevision: await exports.revision(state.metadata) };
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => plan;
  return { state, check: () => provider.ensureCurrentSecurity({ appId: 'fixture' }) };
}

test('a verified release sequence recorded by the payload update does not block committed cleanup', async () => {
  const f = await fixture();
  f.state.metadata.installedVersion = '1.1.0-alpha.1';
  f.state.metadata.productReleaseFloors = {
    track: { source: 'https://example.test/apps/fixture', branch: 'main', sequence: 2, manifestSHA256: 'a'.repeat(64) },
  };
  await f.check();
});

test('release sequence changes do not hide changed credentials, ownership, grants or secret files', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.credential.generation++; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.metadata.ownerId = 'another-owner'; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.admission.policy.generation++; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.secret = Buffer.from('rotated credential'); },
  ]) {
    const f = await fixture();
    change(f);
    await assert.rejects(f.check(), /Current app security changed/);
  }
});
