import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const sourcePath = join(repoRoot, 'src/lib/market/migration-planner.ts');

async function loadPlanner() {
  const source = readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  }).outputText;

  const dir = mkdtempSync(join(tmpdir(), 'youeye-market-planner-'));
  const modulePath = join(dir, 'migration-planner.mjs');
  writeFileSync(modulePath, output, 'utf8');
  return import(pathToFileURL(modulePath).href);
}

const step = {
  type: 'exec',
  container: 'app',
  command: 'true',
  timeout: 60_000,
};

test('ordinary versions can skip directly to the latest when no required gates apply', async () => {
  const { describeUpdatePath, findApplicableMigrations } = await loadPlanner();

  const migrations = findApplicableMigrations([], '0.1.0', '0.5.0', []);

  assert.deepEqual(migrations, []);
  assert.equal(describeUpdatePath('0.1.0', '0.5.0', migrations), '0.1.0 -> 0.5.0');
});

test('durable required gates are selected between an old install and newest target', async () => {
  const { describeUpdatePath, findApplicableMigrations, mergeMigrationSources } = await loadPlanner();

  const migrations = mergeMigrationSources([], [
    {
      fromVersion: '0.2.0',
      toVersion: '0.3.0',
      required: true,
      idempotencyKey: 'demo-0.2-to-0.3',
      description: 'Required schema gate',
      steps: [step],
    },
    {
      fromVersion: '0.4.0',
      toVersion: '0.4.1',
      required: false,
      idempotencyKey: 'demo-optional',
      description: 'Optional cleanup',
      steps: [step],
    },
  ]);

  const applicable = findApplicableMigrations(migrations, '0.1.0', '0.5.0', []);

  assert.equal(applicable.length, 1);
  assert.equal(applicable[0].idempotencyKey, 'demo-0.2-to-0.3');
  assert.equal(applicable[0].source, 'update-plan');
  assert.equal(describeUpdatePath('0.1.0', '0.5.0', applicable), '0.1.0 -> 0.3.0 -> 0.5.0');
});

test('already-applied idempotency keys are skipped during later catch-up updates', async () => {
  const { findApplicableMigrations, mergeMigrationSources } = await loadPlanner();

  const migrations = mergeMigrationSources([], [
    {
      fromVersion: '0.2.0',
      toVersion: '0.3.0',
      required: true,
      idempotencyKey: 'demo-0.2-to-0.3',
      steps: [step],
    },
    {
      fromVersion: '0.3.0',
      toVersion: '0.4.0',
      required: true,
      idempotencyKey: 'demo-0.3-to-0.4',
      steps: [step],
    },
  ]);

  const applicable = findApplicableMigrations(migrations, '0.1.0', '0.5.0', [
    { key: 'demo-0.2-to-0.3', fromVersion: '0.2.0', toVersion: '0.3.0', appliedAt: '2026-06-10T00:00:00.000Z' },
  ]);

  assert.deepEqual(applicable.map((migration) => migration.idempotencyKey), ['demo-0.3-to-0.4']);
});

test('durable update-plan gates override manifest-local duplicate identities', async () => {
  const { findApplicableMigrations, mergeMigrationSources } = await loadPlanner();

  const migrations = mergeMigrationSources([
    {
      fromVersion: '0.2.0',
      toVersion: '0.3.0',
      required: true,
      idempotencyKey: 'same-gate',
      description: 'Manifest copy',
      steps: [step],
    },
  ], [
    {
      fromVersion: '0.2.0',
      toVersion: '0.3.0',
      required: true,
      idempotencyKey: 'same-gate',
      description: 'Durable catalog copy',
      steps: [{ ...step, command: 'echo durable' }],
    },
  ]);

  const applicable = findApplicableMigrations(migrations, '0.1.0', '0.5.0', []);

  assert.equal(applicable.length, 1);
  assert.equal(applicable[0].source, 'update-plan');
  assert.equal(applicable[0].description, 'Durable catalog copy');
  assert.equal(applicable[0].steps[0].command, 'echo durable');
});
