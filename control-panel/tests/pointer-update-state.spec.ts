import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerUpdateState } from '../src/lib/apps/lxd-updates';

const key = (version: string, sequence: number) => ({ line: version.replace(/-.*/, ''), sequence });
const candidate = (version: string, sequence: number) => ({ version, tag: `v${version}`, key: key(version, sequence) });
const installedAt = (version: string, sequence: number) => ({ version, key: key(version, sequence), manifestSHA256: 'a'.repeat(64) });

test('Pointer updates are ordered by line and sequence, never by release name', () => {
  const installed = installedAt('0.6.1-dev.2', 200);
  const newer = pointerUpdateState(installed, candidate('0.6.1-alpha.1', 300));
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.behind, undefined);
  assert.equal(newer.installedVersion, '0.6.1-dev.2');
  assert.equal(newer.latestVersion, '0.6.1-alpha.1');
  assert.equal(newer.latestTag, 'v0.6.1-alpha.1');

  const older = pointerUpdateState(installed, candidate('0.6.1', 100));
  assert.equal(older.hasUpdate, false);
  assert.equal(older.behind, true);
  // A newer line wins whatever its sequence; labels never decide.
  assert.equal(pointerUpdateState(installed, candidate('0.6.2-dev.1', 150)).hasUpdate, true);
  assert.equal(pointerUpdateState(installed, candidate('0.6.1-beta.9', 199)).behind, true);

  // The same build is no update under its own name or another (YE-139): the installed name stays.
  assert.equal(pointerUpdateState(installed, candidate('0.6.1-dev.2', 200)).hasUpdate, false);
  const renamed = pointerUpdateState(installedAt('0.6.1-alpha.1', 200), candidate('0.6.1-beta.1', 200));
  assert.equal(renamed.hasUpdate, false);
  assert.equal(renamed.behind, undefined);
  assert.equal(renamed.installedVersion, '0.6.1-alpha.1');

  // Nothing on the channel; nothing installed yet; an install without a recorded release.
  assert.deepEqual(pointerUpdateState(installed, undefined), { appId: 'pointer', installedVersion: '0.6.1-dev.2', latestVersion: undefined, hasUpdate: false });
  assert.equal(pointerUpdateState(undefined, candidate('0.6.1-dev.1', 100)).hasUpdate, true);
  // An install without a recorded release is never offered a build it can't order (YE-141): dev.1 could be older.
  assert.equal(pointerUpdateState({ version: '0.6.1-dev.9' }, candidate('0.6.1-dev.1', 100)).hasUpdate, false);
  assert.equal(pointerUpdateState({ version: '0.6.1-dev.9' }, candidate('0.6.1-dev.1', 100)).behind, undefined);
  // ... an older line is behind, a newer line is an update, and the same line published after the record was written is.
  assert.equal(pointerUpdateState({ version: '0.6.2-dev.1' }, candidate('0.6.1', 100)).behind, true);
  assert.equal(pointerUpdateState({ version: '0.6.0' }, candidate('0.6.1-dev.1', 100)).hasUpdate, true);
  assert.equal(pointerUpdateState({ version: '0.6.1-dev.9', installedAt: new Date(150_000).toISOString() }, candidate('0.6.1-dev.1', 100)).hasUpdate, false);
  assert.equal(pointerUpdateState({ version: '0.6.1-dev.9', installedAt: new Date(150_000).toISOString() }, candidate('0.6.1-dev.1', 200)).hasUpdate, true);
  // Without a recorded release the package decides when both are known: the same one is the same build.
  const pkg = 'c'.repeat(64);
  const samePackage = pointerUpdateState({ version: '0.6.1', artifactSHA256: pkg }, { ...candidate('0.6.1-alpha.1', 100), artifactSHA256: pkg });
  assert.equal(samePackage.hasUpdate, false);
  assert.equal(samePackage.behind, undefined);
  // Another package in the same line with nothing that orders it is not offered (YE-141).
  assert.equal(pointerUpdateState({ version: '0.6.1', artifactSHA256: pkg }, { ...candidate('0.6.1-alpha.1', 100), artifactSHA256: 'd'.repeat(64) }).hasUpdate, false);
});

test('a Pointer check whose channel cannot be read keeps showing the installed version', async () => {
  const { load } = await import('./fixtures/market-world');
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('youeye.lxd-update-cache')];
  const lxd = load('src/lib/apps/lxd-updates.ts', {
    '@/lib/version': { compareReleases: () => 0, releaseKey: () => ({ line: '0.6.3', sequence: 1 }) },
    '@/lib/releases/channel-index': {
      describeReleaseError: (error: unknown) => (error as Error).message,
      readChannelIndex: async () => { throw new Error('the release host is unreachable'); },
    },
    '@/lib/releases/core-release': { loadSelectedCore: () => { throw new Error('unused'); } },
    '@/lib/updates/provenance': { getCoreProvenance: async () => ({ version: '0.6.3', key: { line: '0.6.3', sequence: 50 }, manifest_sha256: 'a'.repeat(64) }) },
    './definitions': { APP_DEFINITIONS: [{ id: 'pointer', lxdConfig: {}, containers: ['pointer'] }] },
  });
  const result = await lxd.checkLxdAppUpdate({ id: 'pointer', lxdConfig: {}, containers: ['pointer'] }, true);
  assert.equal(result.installedVersion, '0.6.3');
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, undefined);
  assert.equal(result.error, 'the release host is unreachable');
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('youeye.lxd-update-cache')];
});
