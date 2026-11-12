import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// Model the actual Incus contract: snapshots inherit the parent description;
// POST's description field is ignored. Execute the production provider methods.
function fixture() {
  const record = { id: '12345678-1234-4234-8234-123456789abc', appId: 'fixture', originalRunning: { 'app-fixture': true } };
  const resource = { kind: 'volume', scope: 'default', name: 'fixture-data', mutable: true };
  const volume = { description: 'owner description', content_type: 'filesystem', used_by: [],
    config: { 'user.youeye.kind': 'app', 'user.youeye.app_id': 'fixture' } };
  const state = { volume, snapshot: null as typeof volume | null, failCreate: false, effects: [] as string[] };
  const output = ts.transpileModule(readFileSync(join(import.meta.dirname, '../src/lib/market/update-provider.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/lib/incus/server') return {
      incusRequest: async (method: string, url: string, body?: any) => {
        if (method === 'GET') {
          if (url.includes('/snapshots/')) return state.snapshot
            ? { type: 'sync', metadata: state.snapshot } : { type: 'error', error_code: 404 };
          return { type: 'sync', metadata: { ...state.volume } };
        }
        state.effects.push(`${method} ${url}`);
        if (method === 'PUT') state.volume = { ...state.volume, ...body };
        if (method === 'POST') {
          if (state.failCreate) return { type: 'error' };
          state.snapshot = structuredClone(state.volume);
        }
        return { type: 'sync' };
      },
    };
    if (name === './update-journal') return { updateResourceKey: () => 'volume:default:fixture-data' };
    if (name === './update-workspace') return {
      updateDigest: (data: string) => createHash('sha256').update(data).digest('hex'),
    };
    return {};
  }, exports);
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => ({ volumeDescriptions: [{ pool: 'default', name: 'fixture-data', description: 'owner description' }] });
  return { state, provider, record, resource };
}

test('volume checkpoint inherits operation ownership and restores parent metadata', async () => {
  const f = fixture();
  const point = await f.provider.checkpoint(f.record, f.resource);
  assert.equal(point.method, 'volume-snapshot');
  assert.equal(f.state.snapshot?.description, `youeye-app-update:${f.record.id}`);
  assert.equal(f.state.volume.description, 'owner description');
  assert.match(point.sha256, /^[a-f0-9]{64}$/);
});

test('existing checkpoint is refused before changing the parent', async () => {
  const f = fixture();
  f.state.snapshot = { ...f.state.volume };
  await assert.rejects(f.provider.checkpoint(f.record, f.resource), /absence/);
  assert.deepEqual(f.state.effects, []);
  assert.equal(f.state.volume.description, 'owner description');
});

test('interrupted snapshot creation restores the tagged parent on recovery', async () => {
  const f = fixture();
  f.state.failCreate = true;
  await assert.rejects(f.provider.checkpoint(f.record, f.resource), /operation failed/);
  assert.equal(f.state.volume.description, `youeye-app-update:${f.record.id}`);
  await f.provider.restoreVolumeDescription(f.record, f.resource);
  assert.equal(f.state.volume.description, 'owner description');
  const effects = f.state.effects.length;
  await f.provider.restoreVolumeDescription(f.record, f.resource);
  assert.equal(f.state.effects.length, effects);
});

test('recovery never overwrites a foreign parent metadata edit', async () => {
  const f = fixture();
  f.state.volume.description = 'another operation';
  await assert.rejects(f.provider.restoreVolumeDescription(f.record, f.resource), /outside/);
  assert.deepEqual(f.state.effects, []);
});

test('foreign volume ownership is refused before checkpoint or metadata recovery', async () => {
  const f = fixture();
  f.state.volume.config['user.youeye.app_id'] = 'unrelated';
  await assert.rejects(f.provider.checkpoint(f.record, f.resource), /ownership/);
  await assert.rejects(f.provider.restoreVolumeDescription(f.record, f.resource), /ownership/);
  assert.deepEqual(f.state.effects, []);
});
