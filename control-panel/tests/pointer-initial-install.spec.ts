import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptProductSequence, productReceipt, verifyProductRelease } from '../src/lib/releases/product-release';
import { installPointerRelease, type PointerInitialInstallIO } from '../src/lib/pointer/initial-install';
import type { PointerReleaseState } from '../src/lib/pointer/release-metadata';
import { productFixture, sha } from './fixtures/release-fixtures';

test('initial Pointer installation authenticates its channel release before effects and accepts only healthy installed identity', async t => {
  const repository = 'https://github.com/YouEye-Platform/Pointer';
  const archive = Buffer.from('standalone.tar');
  const f = productFixture('pointer','0.6.1-rc.2',repository,{'standalone.tar':archive,'pointer-build-contract.json':Buffer.from('contract')},{sequence:12});
  const selected = verifyProductRelease(f.raw,{product:'pointer',repository,tag:f.tag});
  const source = productFixture('notes','0.6.1-rc.2',repository,{'standalone.tar':archive});
  const notPointer = verifyProductRelease(source.raw,{product:'notes',repository,tag:source.tag});
  for (const mode of ['product','unavailable','not-pointer','older','stage-failure','wrong-archive','wrong-repository','failed-health','projection-failure']) {
    await t.test(mode, async () => {
      const effects: string[] = [];
      let saved: PointerReleaseState | undefined;
      const before: PointerReleaseState = {schema:'youeye.installed-pointer.v1',installed:null,floors:{}};
      if (mode === 'older') before.floors = acceptProductSequence({}, {...selected,release:{...selected.release,version:'0.6.1-rc.3',sequence:13}});
      const io: PointerInitialInstallIO = {
        read:async () => before,
        resolve:async () => {
          effects.push('resolve');
          if (mode === 'unavailable') throw new Error('This channel has no pointer release yet');
          return mode === 'not-pointer' ? notPointer : selected;
        },
        stage:async () => {
          effects.push('stage');
          if (mode === 'stage-failure') throw new Error('Corrupt payload');
          return {containerName:'youeye-pointer',path:'/owned/verified.tar',tag:f.tag,version:f.release.version,
            sourceRepo:mode === 'wrong-repository' ? 'https://forge.example.test/x/Pointer' : repository,
            artifactName:'standalone.tar',artifactSHA256:mode === 'wrong-archive' ? 'f'.repeat(64) : sha(archive),artifactBytes:archive.length,
            verification:{status:'product-release',releaseSHA256:selected.manifestSHA256},productRelease:productReceipt(selected)};
        },
        deploy:async artifact => {effects.push('deploy'); assert.equal(artifact.artifactName,'standalone.tar');},
        configure:async () => {effects.push('configure');},
        healthy:async () => {effects.push('health');return mode !== 'failed-health';},
        publish:async () => {effects.push('publish');return '12345678-1234-1234-1234-123456789abc';},
        verify:async () => {effects.push('verify');if (mode === 'projection-failure') throw new Error('Runtime replaced');},
        save:async value => {effects.push('save');saved=value;},
        cleanup:async () => {effects.push('cleanup');},
      };
      const run = () => installPointerRelease(io);
      if (mode === 'product') {
        await run();
        assert.deepEqual(effects,['resolve','stage','deploy','configure','health','publish','verify','save','cleanup']);
        assert.equal(saved?.installed?.receipt.manifestSHA256,selected.manifestSHA256);
        assert.equal(saved?.installed?.receipt.repository,repository);
        assert.deepEqual(saved!.floors,{pointer:{version:'0.6.1-rc.2',sequence:12,manifestSHA256:selected.manifestSHA256}});
      } else {
        await assert.rejects(run);
        assert.equal(effects.at(-1),'cleanup');
        assert.equal(saved,undefined);
        if (!['failed-health','projection-failure'].includes(mode)) assert.ok(!effects.includes('deploy'));
      }
    });
  }
});
