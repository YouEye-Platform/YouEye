import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(credential: string | null = 'protected-existing-key', failEnvironment = false) {
  const effects: Array<{ name: string; value?: any }> = [];
  const actor = { id: 'owner', name: 'Owner', isAdmin: true };
  const installation: any = { externalInstallationId: 'original-install', state: 'disabled',
    routingOwner: { id: 'pointer-owner', externalSubject: actor.id, state: 'active' },
    selectedGroup: { id: 'original-group', name: 'Original' }, credential: { preview: 'redacted' },
    pointer: { installationId: 'pointer-install', instanceId: 'original-instance' }, drift: { codes: [] } };
  const meta: any = { appId: 'fixture', subdomain: 'fixture', domain: 'example.test',
    enabled: true, desiredState: 'running', containers: [{ name: 'main', containerName: 'app-fixture', type: 'oci' }],
    aiConnection: { externalInstallationId: 'original-install', modelGroupId: 'original-group' } };
  const manifest = { capabilities: { ai_api: true }, configFiles: [],
    env_mapping: { OPENAI_API_KEY: '${ai.apiKey}', TASK_MODEL_EXTERNAL: '${ai.utilityModel}' } };
  const mocks: Record<string, any> = {
    './metadata': { readInstallMetadata: async () => meta, saveInstallMetadata: async () => effects.push({ name: 'save' }) },
    './catalog': { fetchManifestFromSource: async () => manifest },
    './platform-env': { buildCanonicalContext: async (_m: any, config: any) => {
      assert.equal(config.aiSettings.runtimeCredential, credential); return {};
    }, resolveEnvMapping: () => ({ OPENAI_API_KEY: credential, TASK_MODEL_EXTERNAL: 'utility' }) },
    './update-admission': { withAppLifecycle: async (_id: string, run: () => any) => run() },
    '@/lib/infrastructure/secrets': { readSecret: async () => credential },
    '@/lib/pointer/managed-apps': { readPointerManagedApp: async () => installation,
      setPointerManagedAppEnabled: async (id: string, enabled: boolean) => {
        assert.equal(id, 'original-install'); assert.equal(enabled, true);
        effects.push({ name: 'enable' }); return { ...installation, state: 'active' };
      } },
    '@/lib/incus/app-network': { getAppBridgeGatewayIP: async () => '10.0.0.1',
      addSystemProxyDevices: async () => {}, getSystemServices: async () => [], applyAppEgressAcl: async () => {} },
    '@/lib/incus/server': { incusRequest: async (method: string, _path: string, value: any) => {
      if (method === 'GET') return { metadata: { config: {} } };
      effects.push({ name: 'environment', value }); return failEnvironment ? { type: 'error' } : {};
    } },
    '@/lib/infrastructure/oci-deployer': { restartContainerAndWait: async () => effects.push({ name: 'restart' }) },
  };
  const exports: any = {};
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(), 'src/lib/market/managed-ai.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require(name: string) { return mocks[name] ?? {}; } });
  return { effects, run: () => exports.enableManagedAI('fixture', actor, 'original-group') };
}
test('existing enable reapplies utility mapping before activation and preserves installation/instance', async () => {
  const f = fixture(); const connection = await f.run();
  assert.equal(connection.externalInstallationId, 'original-install');
  assert.equal(connection.pointerInstanceId, 'original-instance');
  assert.equal(connection.state, 'active');
  assert.deepEqual(f.effects.map(x => x.name), ['environment', 'restart', 'enable', 'save']);
  assert.equal(f.effects[0].value.config['environment.TASK_MODEL_EXTERNAL'], 'utility');
  assert.equal(f.effects[0].value.config['environment.OPENAI_API_KEY'], 'protected-existing-key');
});
test('missing protected credential refuses enable without replacement or runtime effects', async () => {
  const f = fixture(null); await assert.rejects(f.run(), /credential needs recovery/);
  assert.deepEqual(f.effects, []);
});
test('failed environment convergence does not activate a disabled connection or report success', async () => {
  const f = fixture('protected-existing-key', true);
  await assert.rejects(f.run(), /environment could not be updated/);
  assert.deepEqual(f.effects.map(x => x.name), ['environment']);
});
