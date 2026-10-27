import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import { acceptProductSequence, productReceipt, verifyProductRelease, type ProductBuild, type ProductRelease } from '../src/lib/releases/product-release';
import { installPointerRelease, type PointerInitialInstallIO } from '../src/lib/pointer/initial-install';
import type { PointerReleaseState } from '../src/lib/pointer/release-metadata';

const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
test('initial Pointer installation authenticates descriptor payloads before effects and accepts only healthy installed identity', async t => {
  const key = generateKeyPairSync('ed25519'), previous = publicPolicy.keys;
  publicPolicy.keys = {...previous, stable:key.publicKey.export({type:'spki',format:'pem'}).toString()};
  try {
    const source = 'https://github.com/YouEye-Platform/Pointer';
    const signer = sha(key.publicKey.export({type:'spki',format:'der'}));
    const build: ProductBuild = {schema:'youeye.product-build.v1', product:'pointer', kind:'native', build_version:'0.5.11',
      source, branch:'main', source_commit:'a'.repeat(40), tag:'v0.5.11', input_sha256:'b'.repeat(64), contract_sha256:'c'.repeat(64), signer_sha256:signer,
      primary:'standalone.tar', assets:['standalone.tar','SHA256SUMS','SHA256SUMS.sig','provenance.json','sbom.spdx.json'].map(name =>
        ({name,url:`${source}/releases/download/v0.5.11/${name}`,sha256:sha(name),size_bytes:name.length}))};
    const buildRaw = Buffer.from(JSON.stringify(build));
    const release: ProductRelease = {schema:'youeye.product-release.v1',product:'pointer',version:'0.5.12',source,branch:'main',tag:'v0.5.12',channel:'stable',sequence:12,minimum_reader:1,
      signer_sha256:signer,build_manifest_base64:buildRaw.toString('base64'),build_signature_base64:sign(null,buildRaw,key.privateKey).toString('base64')};
    const raw = Buffer.from(JSON.stringify(release));
    const selected = verifyProductRelease(raw,sign(null,raw,key.privateKey),{product:'pointer',source,tag:release.tag});
    const descriptor = {tag:'v0.5.12',version:'0.5.12',url:`${source}/releases/download/v0.5.12/product-release.json`};
    for (const mode of ['product','legacy','missing-metadata','invalid-signature','wrong-pin','wrong-channel','rollback','stage-failure','wrong-archive','unsigned','failed-health','projection-failure','installed-downgrade']) {
      await t.test(mode, async () => {
        const effects: string[] = [];
        let saved: PointerReleaseState | undefined;
        const before: PointerReleaseState = {schema:'youeye.installed-pointer.v1',installed:null,floors:{}};
        if (mode === 'rollback') before.floors = acceptProductSequence({}, {...selected,release:{...selected.release,sequence:13}});
        if (mode === 'installed-downgrade') before.installed = {receipt:productReceipt(selected),runtimeUUID:'12345678-1234-1234-1234-123456789abc'};
        const io: PointerInitialInstallIO = {
          read:async () => before,
          resolve:async () => {
            effects.push('resolve');
            if (mode === 'invalid-signature') throw new Error('Product signature rejected');
            return ['legacy','missing-metadata','installed-downgrade'].includes(mode) ? null : selected;
          },
          stage:async () => {
            effects.push('stage');
            if (mode === 'stage-failure') throw new Error('Corrupt payload');
            return {containerName:'youeye-pointer',path:'/owned/verified.tar',tag:release.tag,version:release.version,sourceRepo:source,
              artifactName:'standalone.tar',artifactSHA256:mode === 'wrong-archive' ? 'f'.repeat(64) : sha('standalone.tar'),artifactBytes:14,
              signature:mode === 'unsigned' ? {status:'unsigned'} : {status:'verified-stable',keyId:signer},productRelease:productReceipt(selected)};
          },
          deploy:async artifact => {effects.push('deploy'); assert.equal(!!artifact, mode !== 'legacy'); if (artifact) assert.equal(artifact.artifactName,'standalone.tar');},
          configure:async () => {effects.push('configure');},
          healthy:async () => {effects.push('health');return mode !== 'failed-health';},
          publish:async () => {effects.push('publish');return '12345678-1234-1234-1234-123456789abc';},
          verify:async () => {effects.push('verify');if (mode === 'projection-failure') throw new Error('Runtime replaced');},
          save:async value => {effects.push('save');saved=value;},
          recordLegacy:async () => {effects.push('legacy');},
          cleanup:async () => {effects.push('cleanup');},
        };
        const channel = {source,branch:mode === 'wrong-channel' ? 'beta' : 'main',artifact_sha256:mode === 'wrong-pin' ? 'f'.repeat(64) : undefined};
        const input = mode === 'legacy' || mode === 'installed-downgrade' ? {...descriptor,url:descriptor.url.replace('product-release.json','standalone.tar')} : descriptor;
        const run = () => installPointerRelease(input,channel,io);
        if (mode === 'product') {
          await run();
          assert.deepEqual(effects,['resolve','stage','deploy','configure','health','publish','verify','save','cleanup']);
          assert.equal(saved?.installed?.receipt.manifestSHA256,selected.manifestSHA256);
          assert.equal(Object.values(saved!.floors)[0].sequence,12);
        } else if (mode === 'legacy') {
          await run();
          assert.deepEqual(effects,['resolve','deploy','configure','health','legacy','cleanup']);
          assert.equal(saved,undefined);
        } else {
          await assert.rejects(run);
          assert.equal(effects.at(-1),'cleanup');
          assert.equal(saved,undefined);
          assert.ok(!effects.includes('legacy'));
          if (!['failed-health','projection-failure'].includes(mode)) assert.ok(!effects.includes('deploy'));
        }
      });
    }
  } finally {publicPolicy.keys=previous;}
});
