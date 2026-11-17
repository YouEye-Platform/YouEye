import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptProductSequence, productReceipt, verifyProductRelease } from '../src/lib/releases/product-release';
import { installPointerRelease, type PointerInitialInstallIO } from '../src/lib/pointer/initial-install';
import type { PointerReleaseState } from '../src/lib/pointer/release-metadata';
import { productFixture, sha } from './fixtures/release-fixtures';

test('initial Pointer installation authenticates its channel release before effects and accepts only healthy installed identity', async t => {
  const repository = 'https://github.com/YouEye-Platform/Pointer';
  const archive = Buffer.from('standalone.tar');
  const f = productFixture('pointer','0.6.1-dev.2',repository,{'standalone.tar':archive,'pointer-build-contract.json':Buffer.from('contract')},{sequence:12});
  const selected = verifyProductRelease(f.raw,{product:'pointer',repository,tag:f.tag});
  const source = productFixture('notes','0.6.1-dev.2',repository,{'standalone.tar':archive});
  const notPointer = verifyProductRelease(source.raw,{product:'notes',repository,tag:source.tag});
  for (const mode of ['product','unavailable','not-pointer','older','stage-failure','wrong-archive','wrong-repository','failed-health','projection-failure']) {
    await t.test(mode, async () => {
      const effects: string[] = [];
      let saved: PointerReleaseState | undefined;
      const before: PointerReleaseState = {schema:'youeye.installed-pointer.v1',installed:null,floors:{}};
      if (mode === 'older') before.floors = acceptProductSequence({}, {...selected,build:{...selected.build,build_version:'0.6.1-dev.3'}});
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
        assert.deepEqual(saved!.floors,{pointer:{build:'0.6.1-dev.2',buildSHA256:sha(Buffer.from(selected.release.build_manifest_base64,'base64')),manifestSHA256:selected.manifestSHA256}});
      } else {
        await assert.rejects(run);
        assert.equal(effects.at(-1),'cleanup');
        assert.equal(saved,undefined);
        if (!['failed-health','projection-failure'].includes(mode)) assert.ok(!effects.includes('deploy'));
      }
    });
  }
});

test('first boot builds Pointer with its service disabled; setup moves built → configured → installed', async t => {
  const { activateBuiltPointerRelease, buildPointerRelease } = await import('../src/lib/pointer/initial-install');
  const { builtPointerRelease, pointerRelease } = await import('../src/lib/pointer/release-metadata');
  const repository = 'https://github.com/YouEye-Platform/Pointer';
  const archive = Buffer.from('standalone.tar');
  const f = productFixture('pointer','0.6.2-dev.1',repository,{'standalone.tar':archive,'pointer-build-contract.json':Buffer.from('contract')},{sequence:13});
  const selected = verifyProductRelease(f.raw,{product:'pointer',repository,tag:f.tag});
  const runtime = '12345678-1234-1234-1234-123456789abc';
  const staged = () => ({containerName:'youeye-pointer',path:'/owned/verified.tar',tag:f.tag,version:f.release.version,sourceRepo:repository,
    artifactName:'standalone.tar',artifactSHA256:sha(archive),artifactBytes:archive.length,
    verification:{status:'product-release' as const,releaseSHA256:selected.manifestSHA256},productRelease:productReceipt(selected)});

  for (const mode of ['built','deploy-failure','defer-failure']) {
    await t.test(`build: ${mode}`, async () => {
      const effects: string[] = [];
      let saved: PointerReleaseState | undefined;
      await (mode === 'built' ? (p: Promise<void>) => p : (p: Promise<void>) => assert.rejects(p))(buildPointerRelease({
        read:async () => ({schema:'youeye.installed-pointer.v1',installed:null,floors:{}}),
        resolve:async () => {effects.push('resolve');return selected;},
        stage:async () => {effects.push('stage');return staged();},
        deploy:async () => {effects.push('deploy');if (mode === 'deploy-failure') throw new Error('image download failed');},
        defer:async () => {effects.push('defer');if (mode === 'defer-failure') throw new Error('systemctl failed');},
        identity:async () => {effects.push('identity');return runtime;},
        save:async value => {effects.push('save');saved=value;},
        cleanup:async () => {effects.push('cleanup');},
      }));
      assert.equal(effects.at(-1),'cleanup');
      assert.ok(!effects.includes('configure'));
      if (mode === 'built') {
        assert.deepEqual(effects,['resolve','stage','deploy','defer','identity','save','cleanup']);
        assert.equal(saved!.installed,null);
        assert.equal(saved!.built!.runtimeUUID,runtime);
        assert.equal(builtPointerRelease(saved!)!.manifestSHA256,selected.manifestSHA256);
        assert.equal(pointerRelease(saved!),null,'a built Pointer is not an installed one (no updates, no provenance)');
      } else {
        assert.equal(saved,undefined,'an interrupted build records nothing, so setup rebuilds it');
      }
    });
  }

  const built: PointerReleaseState = {schema:'youeye.installed-pointer.v1',installed:null,
    built:{receipt:productReceipt(selected),runtimeUUID:runtime,builtAt:'2026-11-17T10:00:00.000Z'},floors:acceptProductSequence({},selected)};
  for (const mode of ['configured','other-runtime','not-built','unhealthy','replaced-during-publish']) {
    await t.test(`activate: ${mode}`, async () => {
      const effects: string[] = [];
      let saved: PointerReleaseState | undefined;
      const run = activateBuiltPointerRelease({
        read:async () => mode === 'not-built' ? {schema:'youeye.installed-pointer.v1',installed:null,floors:{}} : structuredClone(built),
        identity:async () => mode === 'other-runtime' ? '87654321-4321-4321-4321-cba987654321' : runtime,
        configure:async () => {effects.push('configure');},
        healthy:async () => {effects.push('health');return mode !== 'unhealthy';},
        publish:async () => {effects.push('publish');return mode === 'replaced-during-publish' ? '87654321-4321-4321-4321-cba987654321' : runtime;},
        verify:async () => {effects.push('verify');},
        save:async value => {effects.push('save');saved=value;},
      });
      if (mode === 'configured') {
        assert.equal(await run,true);
        assert.deepEqual(effects,['configure','health','publish','verify','save']);
        assert.equal(saved!.built,null);
        assert.equal(saved!.installed!.runtimeUUID,runtime);
        assert.equal(pointerRelease(saved!)!.manifestSHA256,selected.manifestSHA256);
      } else if (mode === 'other-runtime' || mode === 'not-built') {
        // No built record for this runtime: the caller recreates it (today's rule).
        assert.equal(await run,false);
        assert.deepEqual(effects,[]);
      } else {
        await assert.rejects(run);
        assert.equal(saved,undefined);
      }
    });
  }
  assert.throws(() => builtPointerRelease({...built,installed:{receipt:productReceipt(selected),runtimeUUID:runtime}}),/both built and installed/);

  // Activation published the runtime but stopped before `save`: a later configure pass records it installed.
  const { promoteBuiltPointerRelease } = await import('../src/lib/pointer/initial-install');
  for (const mode of ['promoted','other-runtime','not-built','unhealthy','projection-differs']) {
    await t.test(`promote: ${mode}`, async () => {
      const effects: string[] = [];
      let saved: PointerReleaseState | undefined;
      const run = promoteBuiltPointerRelease({
        read:async () => mode === 'not-built' ? {schema:'youeye.installed-pointer.v1',installed:null,floors:{}} : structuredClone(built),
        identity:async () => mode === 'other-runtime' ? '87654321-4321-4321-4321-cba987654321' : runtime,
        healthy:async () => {effects.push('health');return mode !== 'unhealthy';},
        verify:async (receipt, uuid) => {
          effects.push('verify');
          assert.equal(receipt.manifestSHA256,selected.manifestSHA256);
          assert.equal(uuid,runtime);
          if (mode === 'projection-differs') throw new Error('Installed product projection differs');
        },
        save:async value => {effects.push('save');saved=value;},
      });
      if (mode === 'promoted') {
        assert.equal(await run,true);
        assert.deepEqual(effects,['health','verify','save']);
        assert.equal(saved!.built,null);
        assert.equal(pointerRelease(saved!)!.manifestSHA256,selected.manifestSHA256);
        assert.deepEqual(saved!.floors,built.floors);
      } else if (mode === 'other-runtime' || mode === 'not-built') {
        assert.equal(await run,false);
        assert.deepEqual(effects,[]);
      } else {
        await assert.rejects(run);
        assert.equal(saved,undefined);
      }
    });
  }
});

test('first deployment builds Pointer without a domain and never fails on that build', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const deployer = readFileSync(new URL('../src/lib/infrastructure/deployer.ts', import.meta.url), 'utf8');
  const step5 = deployer.slice(deployer.indexOf('// ─── Step 5: Pointer AI service'), deployer.indexOf('export async function reconcileInfrastructure'));
  assert.match(step5, /if \(!hasPointerIdentitySettings\(settings\)\) \{[\s\S]*await buildPointerForSetup\(\)[\s\S]*catch \(err\) \{[\s\S]*emit\(onEvent, 5, 'skipped', 'YouEye AI service build deferred until setup configures the platform domain'/);
  const firstBoot = step5.slice(step5.indexOf('if (!hasPointerIdentitySettings(settings))'), step5.indexOf("emit(onEvent, 5, 'running', 'Deploying YouEye AI service...')"));
  assert.doesNotMatch(firstBoot, /failDeployment|emit\(onEvent, 5, 'error'/);
  // Setup: built → configure; otherwise no record → recreate; configured → reconfigure.
  const configure = deployer.slice(deployer.indexOf('export async function configurePointerForPlatform'));
  assert.ok(configure.indexOf('await activateBuiltPointer()') < configure.indexOf('deployPointerContainerFromConfiguredSource(true)'));
  assert.match(deployer, /export async function buildPointerForSetup[\s\S]*deferPointerServiceUntilSetup\(\)[\s\S]*replaceExisting = true/);
});

test('the configure path promotes a Pointer still recorded built', async () => {
  const { readFileSync } = await import('node:fs');
  const deployer = readFileSync(new URL('../src/lib/infrastructure/deployer.ts', import.meta.url), 'utf8');
  const branch = deployer.split('} else if (exists) {')[1].split('} else {')[0];
  assert.match(branch, /configurePointerService\(oldIssuer\);[\s\S]*promoteBuiltPointerRelease\(/);
});
