/**
 * Shared version-semantics parity test.
 *
 * Loads the SAME vector file that spine (Go) consumes
 * (spine/internal/version/testdata/vectors.json) and asserts that BOTH TypeScript
 * implementations — control-panel/src/lib/version.ts and ui/src/lib/version.ts —
 * agree with it on every vector. Because the two TS files are byte-identical and
 * both are checked here, the three implementations (Go + 2×TS) cannot drift.
 *
 * Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/version-vectors.spec.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as cpVersion from '../src/lib/version';
import * as uiVersion from '../../ui/src/lib/version';

// control-panel root: env override (how the suite is normally run) or two dirs up
// from this file (tests/ -> control-panel/).
const controlPanelRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
// monorepo root is the parent of control-panel/.
const monorepoRoot = join(controlPanelRoot, '..');
const vectorsPath = join(monorepoRoot, 'spine', 'internal', 'version', 'testdata', 'vectors.json');

assert.ok(
  existsSync(vectorsPath),
  `shared version vectors not found at ${vectorsPath} — cannot verify Go/TS parity`,
);

interface Vectors {
  compare: { a: string; b: string; result: number }[];
  format: { input: string; display: string; tag: string }[];
  valid: { input: string; valid: boolean }[];
}

const vectors: Vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

// Run every assertion against both implementations so parity is guaranteed.
const impls: Array<{ name: string; mod: typeof cpVersion }> = [
  { name: 'control-panel', mod: cpVersion },
  { name: 'ui', mod: uiVersion },
];

for (const { name, mod } of impls) {
  test(`[${name}] compare vectors match sign of compareVersions`, () => {
    for (const v of vectors.compare) {
      assert.equal(
        sign(mod.compareVersions(v.a, v.b)),
        v.result,
        `compareVersions(${JSON.stringify(v.a)}, ${JSON.stringify(v.b)}) sign`,
      );
    }
  });

  test(`[${name}] format vectors match display + tag`, () => {
    for (const v of vectors.format) {
      assert.equal(
        mod.formatVersion(v.input),
        v.display,
        `formatVersion(${JSON.stringify(v.input)}) display`,
      );
      assert.equal(
        mod.formatVersionTag(v.input),
        v.tag,
        `formatVersionTag(${JSON.stringify(v.input)}) tag`,
      );
    }
  });

  test(`[${name}] valid vectors match parseVersionStrict acceptance`, () => {
    for (const v of vectors.valid) {
      const parsed = mod.parseVersionStrict(v.input);
      assert.equal(
        parsed !== null,
        v.valid,
        `parseVersionStrict(${JSON.stringify(v.input)}) acceptance`,
      );
    }
  });
}

// Cross-implementation agreement: CP and UI must produce identical output for
// every vector input (defence-in-depth against the two files ever diverging).
test('control-panel and ui implementations agree on every vector', () => {
  for (const v of vectors.compare) {
    assert.equal(
      sign(cpVersion.compareVersions(v.a, v.b)),
      sign(uiVersion.compareVersions(v.a, v.b)),
      `compareVersions parity for ${v.a} vs ${v.b}`,
    );
  }
  for (const v of vectors.format) {
    assert.equal(cpVersion.formatVersion(v.input), uiVersion.formatVersion(v.input));
    assert.equal(cpVersion.formatVersionTag(v.input), uiVersion.formatVersionTag(v.input));
  }
  for (const v of vectors.valid) {
    assert.equal(
      cpVersion.parseVersionStrict(v.input) !== null,
      uiVersion.parseVersionStrict(v.input) !== null,
    );
  }
});
