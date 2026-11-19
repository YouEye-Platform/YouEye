/**
 * Plan 12: release names are labels. The fallbacks for records written before releases carried a sequence order two
 * build names (`X.Y.Z-dev.N`) by the old build rule, never a release name (`-beta.1`, `X.Y.Z`) against a build;
 * `minimum_release` and `requires.youeye` are line floors that never throw.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isBuildName, meetsMinimumRelease } from '../src/lib/version';
import { youeyeRequirementProblem } from '../src/lib/market/app-format/requires';
import { compareToProductFloor, productReleaseFloor, verifyProductRelease } from '../src/lib/releases/product-release';
import { assessBackupCompatibility } from '../src/lib/backup/compatibility';
import { productFixture } from './fixtures/release-fixtures';

test('a line floor is met by any release of the line; bad input is not met and never throws', () => {
  assert.equal(meetsMinimumRelease('0.6.12-beta.1', '0.6.12'), true);
  assert.equal(meetsMinimumRelease('0.6.13', '0.6.12-dev.4'), true);
  assert.equal(meetsMinimumRelease('0.6.11', '0.6.12'), false);
  for (const [installed, minimum] of [['unknown', '0.6.12'], ['0.6.12', ''], ['', ''], ['development', 'x'], ['0.6', '0.6.0']]) {
    assert.equal(meetsMinimumRelease(installed, minimum), false, `${installed} / ${minimum}`);
  }
  assert.equal(meetsMinimumRelease(undefined as never, '0.6.0'), false);
  // requires.youeye uses it.
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.12' }, '0.6.12-alpha.1'), null);
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.13' }, '0.6.12'), 'This app needs YouEye ≥ 0.6.13; this box runs 0.6.12.');
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.13' }, 'development'), 'This app needs YouEye ≥ 0.6.13; this box runs an unknown version.');
});

test('only dev names are build names', () => {
  assert.equal(isBuildName('0.6.12-dev.3'), true);
  for (const label of ['0.6.12-alpha.1', '0.6.12-beta.1', '0.6.12', 'unknown', undefined]) assert.equal(isBuildName(label), false, String(label));
});

test('a product floor with a build name only never orders a release name as a build', () => {
  const repository = 'https://github.com/YouEye-Platform/Pointer';
  const assets = (bytes: string) => ({ 'standalone.tar': Buffer.from(bytes), 'pointer-build-contract.json': Buffer.from('contract') });
  const release = (version: string, bytes: string, options: { build?: string; clean?: boolean; sequence?: number } = {}) => {
    const fixture = productFixture('pointer', version, repository, assets(bytes), { sequence: 100, ...options });
    return verifyProductRelease(fixture.raw, { product: 'pointer', repository, tag: fixture.tag });
  };
  // The floor a 0.6.11 Control Panel wrote (build name only); the installed document it names is not at hand.
  const installed = release('0.6.4-alpha.1', 'installed', { build: '0.6.4-dev.3' });
  const { line: _line, sequence: _sequence, ...floor } = productReleaseFloor(installed);
  assert.deepEqual(Object.keys(floor), ['build', 'buildSHA256', 'manifestSHA256']);
  const order = (selected: ReturnType<typeof release>) => Math.sign(compareToProductFloor(floor, selected));

  // Two build names of one line: the old build rule.
  assert.equal(order(release('0.6.4-beta.1', 'newer', { build: '0.6.4-dev.5' })), 1);
  assert.equal(order(release('0.6.4', 'older', { build: '0.6.4-dev.2' })), -1);
  // Another line decides first.
  assert.equal(order(release('0.6.5-dev.1', 'next line')), 1);
  assert.equal(order(release('0.6.3', 'previous line', { clean: true })), -1);
  // A release without a build name (new shape) is never ordered as a build: `-beta.1` is not older than `-dev.3`.
  assert.equal(order(release('0.6.4-beta.1', 'clean', { clean: true })), 1);
  assert.equal(order(release('0.6.4', 'clean', { clean: true })), 1);
  // The floor's own build under a new name is the same build.
  assert.equal(order(release('0.6.4-beta.2', 'installed', { build: '0.6.4-dev.3' })), 0);
});

test('a backup\'s old build fields are ordered by the build rule only between two build names', () => {
  const identity = (cp: string) => ({ schema: 'youeye.backup.source.v1', runtime_kind: 'mutable-host', spine_version: '0.6.13', control_panel_version: cp });
  // Two build names of one line: the old rule.
  assert.equal(assessBackupCompatibility(identity('0.6.13-dev.5'), identity('0.6.13-dev.4')).compatible, false);
  assert.equal(assessBackupCompatibility(identity('0.6.13-dev.4'), identity('0.6.13-dev.5')).compatible, true);
  // A release name or a line in the old field is a label: compared by line only.
  assert.equal(assessBackupCompatibility(identity('0.6.13-dev.9'), identity('0.6.13-beta.1')).compatible, true);
  assert.equal(assessBackupCompatibility(identity('0.6.13'), identity('0.6.13-dev.5')).compatible, true);
  assert.equal(assessBackupCompatibility(identity('0.6.14-beta.1'), identity('0.6.13-dev.5')).compatible, false, 'a newer line is newer');
});
