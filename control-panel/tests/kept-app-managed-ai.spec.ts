import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);

const OWNER = '10000000-0000-4000-8000-000000000001';
const OLD_ID = 'market:open-webui:20000000-0000-4000-8000-000000000002';
const saved = { externalInstallationId: OLD_ID, pointerInstallationId: 'pi-new', pointerInstanceId: 'inst', ownerUserId: OWNER,
  pointerOwnerId: 'po', modelGroupId: 'group-after-backup', groupName: 'Mine', keyPreview: 'ptr_new…', credentialSecret: 'pointer_api_key',
  defaultModel: 'default', state: 'active' };

function installation(externalInstallationId: string, preview: string, state = 'active') {
  return { externalInstallationId, app: { id: 'open-webui' }, pointer: { installationId: 'pi-' + preview, instanceId: 'inst' },
    routingOwner: { id: 'po', state: 'active', externalSubject: OWNER }, state,
    selectedGroup: { id: 'default-group', name: 'Default' },
    credential: { id: 'c', preview, revoked: false, deliveryState: 'acknowledged', lifecycle: 'active', generation: 1 },
    drift: { codes: [], healthy: true, unavailableRouteCount: 0, recoveryActions: [] } };
}

/** A kept app, its AI connection made after the backup, and the restored Pointer (`pointer`: what it knows). */
function box(pointer: Record<string, any>, connection = saved, groups = [{ id: 'default-group', isDefault: true, enabledModelCount: 2 }]) {
  const calls: string[] = [];
  const secrets: Record<string, string> = { pointer_api_key: 'ptr_new_key' };
  let meta: any = { appId: 'open-webui', subdomain: 'chat', domain: 'box.test', databaseMode: 'none', desiredState: 'stopped',
    enabled: false, containers: [{ name: 'main', containerName: 'app-open-webui', type: 'oci' }], aiConnection: connection };
  const mocks: Record<string, unknown> = {
    './metadata': { readInstallMetadata: async () => structuredClone(meta), saveInstallMetadata: async (m: any) => { meta = structuredClone(m); calls.push('save'); } },
    './frozen-manifest': { readInstalledAppManifest: async () => ({ metadata: { id: 'open-webui', name: 'Open WebUI' }, version: '1',
      capabilities: { ai_api: true }, env_mapping: { OPENAI_API_KEY: '${ai.api_key}' }, configFiles: [] }) },
    './platform-env': { buildCanonicalContext: async () => ({}), resolveEnvMapping: () => ({ OPENAI_API_KEY: secrets.pointer_api_key }) },
    './config-writer': {},
    '@/lib/incus/app-network': { getAppBridgeGatewayIP: async () => '10.0.0.1', addSystemProxyDevices: async () => calls.push('proxy'),
      getSystemServices: async () => [], applyAppEgressAcl: async () => undefined, removeSystemProxyServiceDevices: async () => undefined },
    '@/lib/incus/server': { incusRequest: async (method: string) => { calls.push(`incus:${method}`); return { type: 'sync', metadata: {} }; } },
    '@/lib/infrastructure/oci-deployer': { restartContainerAndWait: async () => calls.push('restart') },
    '@/lib/apps/container-order': { containerRole: () => 'main' },
    '@/lib/infrastructure/secrets': {
      readAppSecret: async (_app: string, name: string) => secrets[name] ?? null,
      writeAppSecret: async (_app: string, name: string, value: string) => { secrets[name] = value; },
      deleteAppSecret: async (_app: string, name: string) => { delete secrets[name]; },
    },
    '@/lib/identity/store': { getUserById: async (id: string) => id === OWNER ? { id, username: 'owner', name: 'Owner', is_admin: true, is_active: true } : null },
    './update-admission': { withAppLifecycle: async (_app: string, fn: () => unknown) => fn() },
    '@/lib/pointer/managed-apps': {
      readPointerManagedApp: async (id: string) => {
        if (!pointer[id]) throw new Error('Not found (installation_not_found)');
        return pointer[id];
      },
      listPointerActorGroups: async () => groups,
      changePointerManagedAppGroup: async (input: any) => {
        calls.push(`group:${input.groupId}`);
        pointer[input.externalInstallationId] = { ...pointer[input.externalInstallationId], selectedGroup: { id: input.groupId, name: 'Mine' } };
        return pointer[input.externalInstallationId];
      },
      archivePointerManagedApp: async (id: string) => { calls.push(`archive:${id}`); },
      ensurePointerManagedApp: async (input: any) => {
        calls.push(`ensure:${input.groupId}`);
        pointer[input.externalInstallationId] = installation(input.externalInstallationId, 'ptr_fresh…');
        return { installation: pointer[input.externalInstallationId], credentialDelivery: { id: 'd', credential: 'ptr_fresh_key' } };
      },
      acknowledgePointerCredential: async () => calls.push('ack'),
      setPointerManagedAppEnabled: async (id: string, enabled: boolean) => {
        calls.push(`enabled:${enabled}`);
        pointer[id] = { ...pointer[id], state: enabled ? 'active' : 'disabled' };
        return pointer[id];
      },
    },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(process.cwd(), 'src/lib/market/managed-ai.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, Error, require(name: string) {
    if (name in mocks) return mocks[name];
    if (name === 'crypto' || name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected module ${name}`);
  } });
  return { reconcile: exports.reconcileKeptManagedAI as (id: string) => Promise<string>, calls, secrets, meta: () => meta };
}

test('a kept app whose AI connection is newer than the restored Pointer gets a new key', async () => {
  // The backup's Pointer never saw this connection.
  const f = box({});
  assert.equal(await f.reconcile('open-webui'), 'reconnected');
  assert.equal(f.secrets.pointer_api_key, 'ptr_fresh_key');
  assert.ok(f.calls.includes('ensure:default-group'), f.calls.join(' '));
  assert.ok(f.calls.includes('ack'));
  assert.notEqual(f.meta().aiConnection.externalInstallationId, OLD_ID);
  assert.equal(f.meta().aiConnection.keyPreview, 'ptr_fresh…');
  assert.equal(f.meta().aiConnection.state, 'active');
});

test('a backup record with an older key is archived, and a disabled connection stays disabled', async () => {
  const f = box({ [OLD_ID]: installation(OLD_ID, 'ptr_old…') }, { ...saved, state: 'disabled' });
  assert.equal(await f.reconcile('open-webui'), 'reconnected');
  assert.ok(f.calls.includes(`archive:${OLD_ID}`));
  assert.equal(f.secrets.pointer_api_key, 'ptr_fresh_key');
  assert.equal(f.calls.at(-1), 'save');
  assert.ok(f.calls.includes('enabled:false'));
  assert.equal(f.meta().aiConnection.state, 'disabled');
});

test('a kept app whose key Pointer still has keeps it; the model group chosen after the backup is chosen again', async () => {
  const groups = [{ id: 'default-group', isDefault: true, enabledModelCount: 2 }, { id: 'group-after-backup', isDefault: false, enabledModelCount: 1 }];
  const f = box({ [OLD_ID]: { ...installation(OLD_ID, 'ptr_new…'), pointer: { installationId: 'pi-new', instanceId: 'inst' } } },
    { ...saved, state: 'disabled' }, groups);
  assert.equal(await f.reconcile('open-webui'), 'kept');
  assert.deepEqual(f.calls, ['group:group-after-backup', 'enabled:false']);
  // A group with no models left is not chosen: the restored one answers.
  const empty = box({ [OLD_ID]: { ...installation(OLD_ID, 'ptr_new…'), pointer: { installationId: 'pi-new', instanceId: 'inst' } } },
    saved, [groups[0], { ...groups[1], enabledModelCount: 0 }]);
  assert.equal(await empty.reconcile('open-webui'), 'kept');
  assert.deepEqual(empty.calls, []);
});

test('a kept app whose key Pointer still has keeps it; only the enabled state is applied again when its group is gone', async () => {
  const f = box({ [OLD_ID]: { ...installation(OLD_ID, 'ptr_new…'), pointer: { installationId: 'pi-new', instanceId: 'inst' } } },
    { ...saved, state: 'disabled' });
  assert.equal(await f.reconcile('open-webui'), 'kept');
  assert.deepEqual(f.calls, ['enabled:false']);
  assert.equal(f.secrets.pointer_api_key, 'ptr_new_key');
});

test("a server restore reconciles the kept apps' AI after their credentials", () => {
  const full = readFileSync(path.join(process.cwd(), 'src/lib/backup/full-restore.ts'), 'utf8');
  assert.match(full, /operateAppCredential\(app\.appId, \{ action: 'reconcile' \}[\s\S]{0,900}reconcileKeptManagedAI\(app\.appId\)/);
});
