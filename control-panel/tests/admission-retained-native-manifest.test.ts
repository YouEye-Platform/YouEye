import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRetainedNativeManifestUpdate } from '../src/lib/admission/retained-native-manifest';
import { updateDigest } from '../src/lib/market/update-workspace';
const yaml = 'exact frozen native manifest';
const manifest: any = { metadata: { id: 'notes' }, integration: 'native', version: '1.0.1' };
const metadata: any = { appId: 'notes', integration: 'native', installedVersion: '1.0.1',
  installedAt: '2026-01-01T00:00:00Z', containers: [{ name: 'main', containerName: 'app-notes', type: 'lxd' }],
  nativeArtifacts: [{ containerName: 'main', version: '1.0.1', releaseTag: 'dev-v1.0.1',
    sourceRepo: 'https://github.com/example/notes', signature: 'verified-development', signatureKeyId: 'test', sha256: 'a'.repeat(64) }] };
const config: any = { manifestDigest: `sha256:${updateDigest(yaml)}` };
const record: any = { appId: 'notes', phase: 'cleanup', createdAt: '2026-01-02T00:00:00Z',
  cleanupComplete: true, commit: { verifiedAt: '2026-01-02T00:01:00Z' },
  resources: [{ kind: 'container', name: 'app-notes', ownerAppId: 'notes' }],
  target: { manifestSHA256: updateDigest(JSON.stringify(manifest)), artifactSHA256: ['a'.repeat(64)] } };
test('exact native committed manifest/artifact binding can recover a legacy record', () => {
  verifyRetainedNativeManifestUpdate(metadata, config, manifest, yaml, record);
});
for (const [name, change] of [
  ['changed manifest', (f: any) => { f.manifest.version = '1.0.2'; }],
  ['different digest', (f: any) => { f.config.manifestDigest = 'changed'; }],
  ['unfinished update', (f: any) => { f.record.cleanupComplete = false; }],
  ['uncommitted update', (f: any) => { delete f.record.commit; }],
  ['rolled back update', (f: any) => { f.record.rollbackVerifiedAt = '2026-01-02T00:02:00Z'; }],
  ['foreign runtime', (f: any) => { f.record.resources[0].name = 'app-foreign'; }],
  ['different artifact', (f: any) => { f.record.target.artifactSHA256 = ['b'.repeat(64)]; }],
  ['unsigned artifact', (f: any) => { f.metadata.nativeArtifacts[0].signature = 'unsigned'; }],
  ['later unrelated installation', (f: any) => { f.metadata.installedAt = '2026-01-03T00:00:00Z'; }],
  ['OCI app', (f: any) => { f.metadata.integration = 'basic'; }],
  ['missing receipt', (f: any) => { f.record = undefined; }],
] as const) test(`retained binding rejects ${name}`, () => {
  const f: any = structuredClone({ metadata, config, manifest, record }); change(f);
  assert.throws(() => verifyRetainedNativeManifestUpdate(f.metadata, f.config, f.manifest, yaml, f.record), /matching committed update evidence/);
});
