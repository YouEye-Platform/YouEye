import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveInstallAISettings } from '../src/lib/market/install-ai-settings';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const owner = { id: '7f1c9c1e-3c55-4b4e-9d7a-0d6b1c2a9e11', username: 'tester', name: 'Tester' };

test('a CLI install (no YouEye user, no AI choice) installs with AI Settings off', () => {
  assert.deepEqual(resolveInstallAISettings(undefined, null), { aiSettings: { enabled: false } });
  assert.deepEqual(resolveInstallAISettings({} as never, null), { aiSettings: { enabled: false } });
});

test('a signed-in administrator gets AI Settings by default, owned by themselves', () => {
  assert.deepEqual(resolveInstallAISettings(undefined, owner), {
    aiSettings: { enabled: true, modelGroupId: undefined, ownerUserId: owner.id, ownerDisplayName: 'Tester' },
  });
  const chosen = resolveInstallAISettings({ enabled: true, modelGroupId: 'group-1', ownerUserId: 'forged' }, { ...owner, name: '' });
  assert.deepEqual(chosen, {
    aiSettings: { enabled: true, modelGroupId: 'group-1', ownerUserId: owner.id, ownerDisplayName: 'tester' },
  });
});

test('AI Settings off is honoured for everyone; on without a user is still refused', () => {
  assert.deepEqual(resolveInstallAISettings({ enabled: false, ownerUserId: 'forged' }, owner), { aiSettings: { enabled: false } });
  assert.deepEqual(resolveInstallAISettings({ enabled: false }, null), { aiSettings: { enabled: false } });
  const refused = resolveInstallAISettings({ enabled: true }, null);
  assert.ok('error' in refused && /requires a YouEye user account/.test(refused.error));
});

test('the install route never maps the CLI session to a YouEye ID user by name', () => {
  const route = readFileSync(path.join(root, 'src/app/api/market/install/route.ts'), 'utf8');
  assert.match(route, /auth\.session\.authMethod === 'cli' \? null : await getUserByUsername\(auth\.session\.username\)/);
  assert.match(route, /resolveInstallAISettings\(config\.aiSettings, user\)/);
});

test('every ${ai.*} value is empty while AI Settings are off', () => {
  const env = readFileSync(path.join(root, 'src/lib/market/platform-env.ts'), 'utf8');
  const ai = env.slice(env.indexOf('    ai: {'), env.indexOf('    },', env.indexOf('    ai: {')));
  for (const field of ['openai_base_url', 'anthropic_base_url', 'google_base_url']) assert.match(ai, new RegExp(`${field}: pointerInferenceBase`));
  assert.match(env, /const pointerInferenceBase = aiEnabled && systemProxyHost/);
  assert.match(ai, /api_key: aiEnabled \?/);
  assert.match(ai, /default_model: aiEnabled \? 'default' : ''/);
  assert.match(ai, /utility_model: aiEnabled \? 'utility' : ''/);
});
