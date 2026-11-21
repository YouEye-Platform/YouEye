import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recoveredNativeArtifacts } from '../src/lib/market/native-artifact';
import { productReceipt, verifyProductRelease } from '../src/lib/releases/product-release';
import { productFixture } from './fixtures/release-fixtures';

const source = 'https://github.com/YouEye-Platform/Notes';
const payload = Buffer.from('notes standalone.tar');
function release(product: string, version: string) {
  const f = productFixture(product, version, source, { 'standalone.tar': payload }, { clean: true });
  return verifyProductRelease(f.raw, { product, repository: source, tag: f.tag });
}
const recorded = (receiptOf = release('notes', '0.6.4'), containerName = 'main') => [{
  productRelease: productReceipt(receiptOf), runtimeUUID: '423f2bc4-5a1c-4a82-8b94-e91c7d9c8759', containerName,
  sourceRepo: source, releaseTag: receiptOf.release.tag, version: receiptOf.release.version, artifactName: 'standalone.tar',
  sha256: 'f'.repeat(64), bytes: 1, verification: 'product-release', productReleaseSHA256: receiptOf.manifestSHA256,
}];

test('a recovered native runtime keeps the release its backed-up install record names', () => {
  const selected = release('notes', '0.6.4');
  const [artifact, ...rest] = recoveredNativeArtifacts('notes', '0.6.4', recorded(selected), ['main']);
  assert.equal(rest.length, 0);
  assert.deepEqual(artifact.productRelease, productReceipt(selected));
  assert.equal(artifact.version, '0.6.4');
  assert.equal(artifact.productReleaseSHA256, selected.manifestSHA256);
  // Digest and size come from the verified release, not the record; the runtime identity is published again.
  assert.equal(artifact.bytes, payload.length);
  assert.notEqual(artifact.sha256, 'f'.repeat(64));
  assert.equal(artifact.runtimeUUID, undefined);
});

test('a backed-up release record that does not fit is dropped', () => {
  assert.deepEqual(recoveredNativeArtifacts('notes', '0.6.4', recorded(), []), []);
  assert.deepEqual(recoveredNativeArtifacts('notes', '0.6.4', recorded(release('notes', '0.6.4'), 'other'), ['main']), []);
  assert.deepEqual(recoveredNativeArtifacts('notes', '0.6.5', recorded(), ['main']), []);
  assert.deepEqual(recoveredNativeArtifacts('wiki', '0.6.4', recorded(), ['main']), []);
  assert.deepEqual(recoveredNativeArtifacts('notes', '0.6.4', undefined, ['main']), []);
  const forged = recorded();
  forged[0].productRelease = { ...forged[0].productRelease, manifestSHA256: '0'.repeat(64) };
  assert.deepEqual(recoveredNativeArtifacts('notes', '0.6.4', forged, ['main']), []);
});

test('restores and retained-data adoption hand the earlier record to the installer, which republishes the projection', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8');
  assert.match(read('backup/app-restore.ts'), /recoveredNativeArtifacts: backedUpInstallMeta\?\.nativeArtifacts/);
  assert.match(read('admission/retained-data.ts'), /recoveredNativeArtifacts: metadata\.nativeArtifacts/);
  const engine = read('market/engine.ts');
  assert.match(engine, /recoveredNativeArtifacts\(\s*appId, manifest\.version, restoreOptions\?\.recoveredNativeArtifacts, recoveredNativeContainers\)/);
  assert.equal(engine.match(/adoptRestoredLXDContainer\(lxdSpec, appNIC, owner\);\n\s*await publishRecoveredProjection\(recoveredArtifacts/g)?.length, 2);
  assert.equal(engine.match(/describeNativeArtifacts\(stagedNativeArtifacts, recoveredArtifacts\)/g)?.length, 2);
});
