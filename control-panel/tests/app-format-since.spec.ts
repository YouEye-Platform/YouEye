// "Field, since version" (src/lib/market/app-format/since.ts): every row names a field the strict
// parser knows, the walker finds it, and an app that uses it must require that YouEye version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';

import { AppFormatError, parseAppSource } from '../src/lib/market/app-format/parse';
import {
  FIELDS_SINCE, FIRST_FORMAT_VERSION, OLDEST_MARKET_READER, compareVersions, hasField, newerFieldsUsed, requiresProblems, youeyeVersionNeeded,
} from '../src/lib/market/app-format/since';
import { PIN, appDocument } from './fixtures/app-format';

const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false });
const installSetup = (extra: Record<string, unknown>) => ({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/health' } }], ...extra });
const formStep = { http: { method: 'POST', path: '/settings', form: { 'settings-general-enabled': 'true' } } };

/** One example per row: a manifest (+ setup files) that uses the field. A new row needs a new example. */
const EXAMPLES: Record<string, { manifest: Record<string, unknown>; setups?: Record<string, Record<string, unknown>> }> = {
  'app:public_access': { manifest: appDocument({ public_access: true }) },
  'setup:steps[].http.form': { manifest: appDocument(), setups: { 'setup/install.yaml': installSetup({ steps: [formStep] }) } },
  'setup:remove[].http.form': { manifest: appDocument(), setups: { 'setup/install.yaml': installSetup({ remove: [formStep] }) } },
  'app:sidecars[].data[].from': {
    manifest: appDocument({
      data: ['/data'],
      sidecars: [{ name: 'worker', image: `ghcr.io/example/worker${PIN}`, data: ['/cache', { path: '/data', from: 'main' }] }],
    }),
  },
};

function parse(example: (typeof EXAMPLES)[string], requires?: string) {
  const manifest = requires ? { ...example.manifest, requires: { youeye: requires } } : example.manifest;
  return parseAppSource({
    manifest: yaml(manifest),
    setups: Object.fromEntries(Object.entries(example.setups ?? {}).map(([name, value]) => [name, yaml(value)])),
  });
}

/** The example with the field's last key renamed, everywhere the path reaches. */
function renamed(example: (typeof EXAMPLES)[string], document: 'app' | 'setup', field: string) {
  const copy = structuredClone(example);
  const parts = field.split('.');
  const rename = (node: unknown, rest: string[]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const [head, ...tail] = rest;
    const record = node as Record<string, unknown>;
    if (tail.length === 0) {
      if (Object.hasOwn(record, head)) { record.zz_not_a_field = record[head]; delete record[head]; }
      return;
    }
    const key = head.endsWith('[]') ? head.slice(0, -2) : head;
    const child = record[key];
    if (head.endsWith('[]') && Array.isArray(child)) child.forEach((item) => rename(item, tail));
    else if (!head.endsWith('[]')) rename(child, tail);
  };
  if (document === 'app') rename(copy.manifest, parts);
  else for (const setup of Object.values(copy.setups ?? {})) rename(setup, parts);
  return copy;
}

test('every row of the table names a field of the strict schema, found where it is used', () => {
  assert.ok(FIELDS_SINCE.length >= 3);
  for (const row of FIELDS_SINCE) {
    const key = `${row.document}:${row.field}`;
    const example = EXAMPLES[key];
    assert.ok(example, `${key}: add an example document that uses the field`);
    assert.match(row.since, /^\d+\.\d+\.\d+$/, key);
    assert.ok(compareVersions(row.since, FIRST_FORMAT_VERSION) > 0, `${key}: fields of the first version need no row`);

    // The schema knows the field: an app that uses it parses strictly ...
    const parsed = parse(example, `>=${row.since}`);
    assert.ok(newerFieldsUsed(parsed).some((use) => use.field === row.field && use.document === row.document), `${key}: not found`);
    assert.deepEqual(requiresProblems(parsed), [], key);
    // ... and the same document with the key renamed is refused, so the key itself is what the schema reads.
    assert.throws(() => parse(renamed(example, row.document, row.field), `>=${row.since}`), AppFormatError, `${key}: renamed key accepted`);
  }
});

test('an app needs the highest version its fields need, and must require it', () => {
  const example = EXAMPLES['setup:steps[].http.form'];
  const parsed = parse(example);
  assert.deepEqual(youeyeVersionNeeded(parsed), { document: 'setup', field: 'steps[].http.form', since: '0.6.9', file: 'setup/install.yaml' });
  assert.match(requiresProblems(parsed).join('\n'), /setup\/install\.yaml: steps\[\]\.http\.form needs YouEye 0\.6\.9, but requires\.youeye is missing/);
  assert.match(requiresProblems(parse(example, '>=0.6.8')).join('\n'), /requires\.youeye is ">=0\.6\.8"/);
  assert.deepEqual(requiresProblems(parse(example, '>=0.6.9')), []);
  assert.deepEqual(requiresProblems(parse(example, '>=0.7.0')), []);

  const plain = parseAppSource({ manifest: yaml(appDocument({ sidecars: [{ name: 'worker', image: `ghcr.io/example/worker${PIN}`, data: ['/cache'] }] })) });
  assert.equal(youeyeVersionNeeded(plain), null);
  assert.deepEqual(requiresProblems(plain), []);
});

test('public_access is a row: stable 0.6.3 (build 0.6.3-dev.20) did not read it, 0.6.4 does', () => {
  const parsed = parse(EXAMPLES['app:public_access']);
  assert.deepEqual(youeyeVersionNeeded(parsed), { document: 'app', field: 'public_access', since: '0.6.4', file: 'youeye-app.yaml' });
  assert.match(requiresProblems(parsed).join('\n'), /youeye-app\.yaml: public_access needs YouEye 0\.6\.4, but requires\.youeye is missing/);
});

test('rows at or below the floor are not enforced: no box that old reads where the app is published', () => {
  assert.equal(OLDEST_MARKET_READER, '0.6.11');
  for (const row of FIELDS_SINCE) {
    const parsed = parse(EXAMPLES[`${row.document}:${row.field}`]);
    assert.notDeepEqual(requiresProblems(parsed), [], `${row.field}: enforced from the first format version`);
    const enforced = compareVersions(row.since, OLDEST_MARKET_READER) > 0;
    assert.equal(requiresProblems(parsed, OLDEST_MARKET_READER).length > 0, enforced, row.field);
    // At the row's own version as the floor it is not enforced; just below, it is.
    assert.deepEqual(requiresProblems(parsed, row.since), []);
  }
  const example = EXAMPLES['setup:steps[].http.form'];
  assert.deepEqual(requiresProblems(parse(example), '0.6.9'), []);
  assert.equal(requiresProblems(parse(example), '0.6.8').length, 1);
});

test('the walker reads only keys of objects, through lists', () => {
  assert.equal(hasField({ steps: [{ http: { form: {} } }] }, 'steps[].http.form'), true);
  assert.equal(hasField({ steps: [{ http: { body: 'form' } }, 'form'] }, 'steps[].http.form'), false);
  assert.equal(hasField({ steps: { http: { form: {} } } }, 'steps[].http.form'), false);
  assert.equal(hasField({ sidecars: [{ data: ['/from'] }] }, 'sidecars[].data[].from'), false);
  assert.equal(hasField({ 'x-steps': [{ http: { form: {} } }] }, 'steps[].http.form'), false);
});
