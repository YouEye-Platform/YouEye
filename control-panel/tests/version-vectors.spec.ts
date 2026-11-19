/**
 * Version parity with Go.
 *
 * Release ordering: releasecache/testdata/release-order.json, the vectors the
 * releasecache tests read too. Releases are ordered by line (X.Y.Z, numeric),
 * then by the build's sequence; names are labels and never decide; an
 * old-shape document's `build` is ignored; `minimum_release` is line-only.
 *
 * Other versions (`compareVersions`, `formatVersion`, `parseVersionStrict`):
 * spine/internal/version/testdata/vectors.json.
 *
 * Run: CONTROL_PANEL_ROOT="$PWD" node --import tsx --test tests/version-vectors.spec.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as version from '../src/lib/version';

const controlPanelRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const monorepoRoot = join(controlPanelRoot, '..');
const read = <T>(...path: string[]): T => {
  const file = join(monorepoRoot, ...path);
  assert.ok(existsSync(file), `shared vectors not found at ${file}; cannot verify Go/TypeScript parity`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
};

type Release = { version: string; sequence: number; build?: string };
const order = read<{
  compare: { name: string; a: Release; b: Release; want: number }[];
  minimum_release: { name: string; installed: string; minimum: string; ok: boolean }[];
}>('releasecache', 'testdata', 'release-order.json');

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

test('releases are ordered by line, then sequence; names and old-shape builds never decide', () => {
  assert.ok(order.compare.length > 0);
  for (const v of order.compare) {
    assert.equal(sign(version.compareReleases(v.a, v.b)), v.want, `${v.name}: compare(a, b)`);
    assert.equal(sign(version.compareReleases(v.b, v.a)), 0 - v.want || 0, `${v.name}: compare(b, a)`);
    // A recorded key (line, sequence) orders exactly like the document it came from.
    assert.equal(sign(version.compareReleases(version.releaseKey(v.a), v.b)), v.want, `${v.name}: key of a`);
  }
});

test('minimum_release is a line, compared by line only (an old-shape value is read as its line)', () => {
  assert.ok(order.minimum_release.length > 0);
  for (const v of order.minimum_release) {
    assert.equal(version.meetsMinimumRelease(v.installed, v.minimum), v.ok, v.name);
  }
});

test('a release key needs a release version (or line) and a positive sequence', () => {
  assert.deepEqual(version.releaseKey({ version: '0.6.13-beta.1', sequence: 7 }), { line: '0.6.13', sequence: 7 });
  assert.deepEqual(version.releaseKey({ line: '0.6.13', sequence: 7 }), { line: '0.6.13', sequence: 7 });
  for (const bad of [{ version: 'v0.6.13', sequence: 1 }, { version: '0.6.13', sequence: 0 }, { version: '0.6', sequence: 1 }, { line: '0.6.13-dev.1', sequence: 1.5 }]) {
    assert.throws(() => version.releaseKey(bad as never));
  }
  assert.equal(version.validReleaseKey({ line: '0.6.13', sequence: 1 }), true);
  assert.equal(version.validReleaseKey({ line: '0.6.13-dev.1', sequence: 1 }), false);
  assert.equal(version.releaseLine('0.6.13-alpha.2'), '0.6.13');
  assert.equal(version.releaseLine('0.6.13.1'), null);
});

interface Vectors {
  compare: { a: string; b: string; result: number }[];
  format: { input: string; display: string; tag: string }[];
  valid: { input: string; valid: boolean }[];
}
const vectors = read<Vectors>('spine', 'internal', 'version', 'testdata', 'vectors.json');

test('compare vectors match sign of compareVersions', () => {
  for (const v of vectors.compare) {
    assert.equal(sign(version.compareVersions(v.a, v.b)), v.result, `compareVersions(${JSON.stringify(v.a)}, ${JSON.stringify(v.b)}) sign`);
  }
});

test('format vectors match display + tag', () => {
  for (const v of vectors.format) {
    assert.equal(version.formatVersion(v.input), v.display, `formatVersion(${JSON.stringify(v.input)}) display`);
    assert.equal(version.formatVersionTag(v.input), v.tag, `formatVersionTag(${JSON.stringify(v.input)}) tag`);
  }
});

test('valid vectors match parseVersionStrict acceptance', () => {
  for (const v of vectors.valid) {
    assert.equal(version.parseVersionStrict(v.input) !== null, v.valid, `parseVersionStrict(${JSON.stringify(v.input)}) acceptance`);
  }
});
