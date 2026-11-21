/**
 * Field, since version: manifest and setup-file fields that did not exist in the first released
 * version of the app format (`youeye.app.v1` shipped with YouEye 0.6.3), with the YouEye version
 * that first reads them. A box older than that refuses the field as unknown, so an app that uses
 * one must say `requires: { youeye: ">=<version>" }`; the Market generator enforces it for every row
 * newer than the oldest YouEye that reads a generated market at all (`OLDEST_MARKET_READER`): an
 * older box never sees the app, so a row at or below that floor is kept as a record but needs no
 * `requires.youeye`.
 *
 * Add a row whenever schema.ts gains a field (tests/app-format-since.spec.ts checks every row
 * against the schema).
 */

import type { ParsedApp } from './parse';
import { variableReferences } from './variables';

/** The YouEye version that first read `youeye.app.v1`. Fields it knows need no row. */
export const FIRST_FORMAT_VERSION = '0.6.3';

/**
 * The oldest YouEye that reads the static market format (market.json, the index and app bundles; Plan 11) at all.
 * A market built by scripts/market-build.ts reaches no older box, so the generator enforces only rows newer than this.
 */
export const OLDEST_MARKET_READER = '0.6.11';

export interface FieldSince {
  /** `app` is youeye-app.yaml, `setup` any setup file. */
  document: 'app' | 'setup';
  /** Dotted path from the document root; `[]` walks every item of a list. */
  field: string;
  /** The first YouEye version that reads the field (X.Y.Z). */
  since: string;
}

export const FIELDS_SINCE: readonly FieldSince[] = [
  // Stable 0.6.3 is build 0.6.3-dev.20, before the field; the first stable release that reads it is 0.6.4.
  { document: 'app', field: 'public_access', since: '0.6.4' },
  { document: 'setup', field: 'steps[].http.form', since: '0.6.9' },
  { document: 'setup', field: 'remove[].http.form', since: '0.6.9' },
  { document: 'app', field: 'sidecars[].data[].from', since: '0.6.9' },
];

/**
 * Variables (`${…}`) newer than the first format, like FIELDS_SINCE: an older box refuses an unknown variable, so an
 * app that uses one must say `requires: { youeye: ">=<version>" }` (and an older box then lists it from the market's
 * index as "Needs YouEye …" without reading its manifest). Add a row whenever variables.ts gains a name.
 */
export const VARIABLES_SINCE: readonly { variable: string; since: string }[] = [
  { variable: 'app.network_cidr', since: '0.6.15' },
];

export interface FieldUse extends FieldSince {
  /** `youeye-app.yaml` or the setup file's name (`setup/<name>.yaml`). */
  file: string;
}

/** True when `field` (see FieldSince.field) is present anywhere in the raw document `value`. */
export function hasField(value: unknown, field: string): boolean {
  const walk = (node: unknown, parts: string[]): boolean => {
    if (parts.length === 0) return true;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const [head, ...rest] = parts;
    const list = head.endsWith('[]');
    const key = list ? head.slice(0, -2) : head;
    if (!Object.hasOwn(node, key)) return false;
    const child = (node as Record<string, unknown>)[key];
    if (child === undefined) return false;
    if (!list) return walk(child, rest);
    return Array.isArray(child) && child.some((item) => walk(item, rest));
  };
  return walk(value, field.split('.'));
}

/** Every field of the table that the app (manifest and setup files, as raw YAML data) uses. */
export function newerFieldsUsed(app: Pick<ParsedApp, 'raw' | 'setups'>): FieldUse[] {
  const uses: FieldUse[] = [];
  for (const row of FIELDS_SINCE) {
    if (row.document === 'app') {
      if (hasField(app.raw, row.field)) uses.push({ ...row, file: 'youeye-app.yaml' });
    } else {
      for (const setup of app.setups) if (hasField(setup.raw, row.field)) uses.push({ ...row, file: setup.name });
    }
  }
  const referenced = (raw: unknown) => new Set(variableReferences(JSON.stringify(raw) ?? ''));
  for (const row of VARIABLES_SINCE) {
    const field = `\${${row.variable}}`;
    if (referenced(app.raw).has(row.variable)) uses.push({ document: 'app', field, since: row.since, file: 'youeye-app.yaml' });
    for (const setup of app.setups) {
      if (referenced(setup.raw).has(row.variable)) uses.push({ document: 'setup', field, since: row.since, file: setup.name });
    }
  }
  return uses;
}

function triple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not an X.Y.Z version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two X.Y.Z versions. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [triple(a), triple(b)];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

/** The highest YouEye version the app's fields need, and the first field that needs it; null when none. */
export function youeyeVersionNeeded(app: Pick<ParsedApp, 'raw' | 'setups'>): FieldUse | null {
  let highest: FieldUse | null = null;
  for (const use of newerFieldsUsed(app)) {
    if (!highest || compareVersions(use.since, highest.since) > 0) highest = use;
  }
  return highest;
}

/**
 * Problems when the app uses a field newer than its `requires.youeye` (missing counts as the first version). Rows at
 * or below `floor` (the oldest YouEye that can read where the app is published; the generator passes
 * `OLDEST_MARKET_READER`) are not enforced: no box that old reads the app.
 */
export function requiresProblems(app: Pick<ParsedApp, 'app' | 'raw' | 'setups'>, floor: string = FIRST_FORMAT_VERSION): string[] {
  const declared = app.app.requires?.youeye.slice(2) ?? null;
  const problems: string[] = [];
  for (const use of newerFieldsUsed(app)) {
    if (compareVersions(use.since, floor) <= 0) continue;
    if (declared && compareVersions(declared, use.since) >= 0) continue;
    problems.push(`${use.file}: ${use.field} needs YouEye ${use.since}, but requires.youeye is `
      + `${declared ? `">=${declared}"` : 'missing'} (write requires: { youeye: ">=${use.since}" })`);
  }
  return problems;
}
