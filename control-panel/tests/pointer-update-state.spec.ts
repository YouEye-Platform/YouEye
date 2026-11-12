import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerUpdateState } from '../src/lib/apps/lxd-updates';
import type { ChannelEntry } from '../src/lib/releases/channel-index';

const entry = (version: string, build: string): ChannelEntry => ({
  repository: 'https://github.com/YouEye-Platform/Pointer', tag: `v${version}`, version, build, document: 'product-release.json', sha256: 'a'.repeat(64),
});

test('Pointer updates are detected by build, never by release name', () => {
  const installed = { version: '0.6.1-dev.2', build: '0.6.1-dev.2' };
  const newer = pointerUpdateState(installed, entry('0.6.1-alpha.1', '0.6.1-dev.3'));
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.behind, undefined);
  assert.equal(newer.installedVersion, '0.6.1-dev.2');
  assert.equal(newer.latestVersion, '0.6.1-alpha.1');
  assert.equal(newer.latestTag, 'v0.6.1-alpha.1');

  const older = pointerUpdateState(installed, entry('0.6.1', '0.6.1-dev.1'));
  assert.equal(older.hasUpdate, false);
  assert.equal(older.behind, true);

  // The same build: up to date under its own name, a label-only update under another name.
  assert.equal(pointerUpdateState(installed, entry('0.6.1-dev.2', '0.6.1-dev.2')).hasUpdate, false);
  const renamed = pointerUpdateState({ version: '0.6.1-alpha.1', build: '0.6.1-dev.2' }, entry('0.6.1-beta.1', '0.6.1-dev.2'));
  assert.equal(renamed.hasUpdate, true);
  assert.equal(renamed.behind, undefined);

  // Nothing on the channel; nothing installed yet; an install without a recorded build.
  assert.deepEqual(pointerUpdateState(installed, undefined), { appId: 'pointer', installedVersion: '0.6.1-dev.2', latestVersion: undefined, hasUpdate: false });
  assert.equal(pointerUpdateState(undefined, entry('0.6.1-dev.1', '0.6.1-dev.1')).hasUpdate, true);
  assert.equal(pointerUpdateState({ version: '0.6.1-dev.9' }, entry('0.6.1-dev.1', '0.6.1-dev.1')).hasUpdate, true);
});
