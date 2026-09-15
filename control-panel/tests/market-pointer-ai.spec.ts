import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { AppManifestSchema } from '../src/lib/market/schema';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (filename: string) => readFileSync(path.join(root, filename), 'utf8');

test('Market AI provisioning is actor-routed, one-time delivered, and rollback-safe', () => {
  const engine = read('src/lib/market/engine.ts');
  const pointer = read('src/lib/pointer/managed-apps.ts');
  const tracker = read('src/lib/market/install-tracker.ts');
  assert.match(pointer, /routingOwner: 'actor'/);
  assert.match(engine, /writeSecret\(secretsPath, 'pointer_api_key'/);
  assert.match(engine, /protectedReadBack !== delivery\.credential/);
  assert.match(engine, /acknowledgePointerCredential/);
  assert.match(engine, /readPointerManagedApp\(externalInstallationId, actor\)/);
  assert.match(engine, /archivePointerManagedApp\(ctx\.aiExternalInstallationId\)/);
  assert.match(engine, /\/var\/lib\/youeye\/secrets\/app-\$\{ctx\.appId\}/);
  assert.match(engine, /removeSystemProxyDevices/);
  assert.doesNotMatch(engine, /credential:\s*delivery\.credential/);
  assert.match(pointer, /setExpirationTime|createPointerLifecycleAssertion/);
  assert.match(tracker, /sanitise|sensitivity/i);
});

test('AI app networks expose inference only and reject direct Pointer access', () => {
  const network = read('src/lib/incus/app-network.ts');
  assert.match(network, /containerName: 'youeye-pointer',[\s\S]*port: 4002,[\s\S]*listenPort: 3003/);
  assert.doesNotMatch(
    network.slice(network.indexOf('// Inference only.'), network.indexOf('return services;', network.indexOf('// Inference only.'))),
    /4001/,
  );
  assert.match(network, /block direct Pointer access/i);
  assert.match(network, /needsAI/);
  const acl = network.slice(network.indexOf('async function buildAppEgressRules'), network.indexOf('export async function prepareAppEgressAcl'));
  assert.doesNotMatch(acl, /action: 'allow'[^\n]*destination_port: '4002'/);
  assert.match(acl, /action: 'reject'[^\n]*block direct Pointer access/);
});

test('app AI controls require an administrator, CSRF, explicit takeover, and identity cleanup', () => {
  const route = read('src/app/api/market/app/[appId]/ai/route.ts');
  const settings = read('src/components/settings-shell/apps-client.tsx');
  const provider = read('src/lib/identity/provider.ts');
  const identityStore = read('src/lib/identity/store.ts');
  const identityTokens = read('src/lib/identity/tokens.ts');
  assert.match(route, /requireAdmin/);
  assert.match(route, /verifyCSRFToken/);
  assert.match(route, /installedAppSupportsManagedAI/);
  assert.match(route, /supported: true[\s\S]*status: 503/);
  assert.match(route, /z\.discriminatedUnion\('action'/);
  assert.match(settings, /Take over AI connection/);
  assert.match(settings, /fetchCSRFToken/);
  assert.match(settings, /setAISupported\(Boolean\(aiPayload\?\.supported\)\)/);
  assert.match(provider, /setPointerManagedActorState\(current\.id, 'disabled'\)/);
  assert.match(provider, /setPointerManagedActorState[\s\S]*deleteIdentityUser/);
  assert.match(provider, /input\.is_active !== current\.is_active[\s\S]*setPointerManagedActorState/);
  assert.match(identityStore, /is_active boolean NOT NULL DEFAULT true/);
  assert.match(identityStore, /!user\.is_active \|\| !verifyPassword/);
  assert.match(identityTokens, /return user\?\.is_active \? user : null/);
});

test('OpenWebUI declares the exact Pointer, OIDC, persistence, and pinned-image contract', () => {
  const manifestPath = path.resolve(root, '../../YE-AppMarket/apps/open-webui/youeye-app.yaml');
  const manifest = AppManifestSchema.parse(parseYaml(readFileSync(manifestPath, 'utf8')));
  assert.equal(manifest.metadata.id, 'open-webui');
  assert.equal(manifest.capabilities?.ai_api, true);
  assert.equal(manifest.sso?.callback_path, '/oauth/oidc/callback');
  assert.match(manifest.containers[0].image, /^ghcr\.io\/open-webui\/open-webui@sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.env_mapping.OPENAI_API_BASE_URL, '${ai.openaiBaseUrl}');
  assert.equal(manifest.env_mapping.OPENAI_API_KEY, '${ai.apiKey}');
  assert.equal(manifest.env_mapping.DEFAULT_MODELS, '${ai.defaultModel}');
  assert.equal(manifest.env_mapping.OPENID_PROVIDER_URL, '${sso.discovery_url}');
  assert.equal(manifest.env_mapping.ENABLE_OLLAMA_API, 'false');
});
