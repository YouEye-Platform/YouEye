import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateConfigurationContext, updateEnvironment, resolveUpdateTemplate } from '../src/lib/market/update-configuration';
import type { AppManifest } from '../src/lib/market/types';

const old = {
  containers: [{ name: 'main', environment: { DATABASE_URL: '${database.url}' } }],
  env_mapping: { OIDC_SECRET: '${sso.client_secret}', TOKEN: '${integration.app_token}' },
} as unknown as AppManifest;

test('changed config resolves installed credentials without minting or replacing them', () => {
  const context = updateConfigurationContext(old, { main: {
    DATABASE_URL: 'postgresql://app:fixture-secret@db/app',
    OIDC_SECRET: 'installed-oidc', TOKEN: 'installed-token',
  } }, { database: { url: '' }, sso: { client_secret: '' } } as never);
  assert.equal(resolveUpdateTemplate('db=${database.url}', context), 'db=postgresql://app:fixture-secret@db/app');
  assert.equal(resolveUpdateTemplate('sso=${sso.client_secret}', context), 'sso=installed-oidc');
  const next = updateEnvironment({ TOKEN: '${integration.app_token}', SETTING: 'old', REMOVED: 'gone' },
    { TOKEN: '${integration.app_token}', SETTING: 'new' },
    { TOKEN: 'installed-token', SETTING: 'old', REMOVED: 'gone', PLATFORM_CA: '/ca.pem' }, context);
  assert.deepEqual(next, { TOKEN: 'installed-token', SETTING: 'new', PLATFORM_CA: '/ca.pem' });
});

test('missing, inconsistent or empty new credential declarations fail safely', () => {
  assert.throws(() => updateEnvironment({ TOKEN: '${integration.app_token}' },
    { TOKEN: '${integration.app_token}' }, {}, {}), /missing/);
  assert.throws(() => resolveUpdateTemplate('${database.password}', { database: { password: '' } } as never), /unavailable/);
  assert.throws(() => updateConfigurationContext({ ...old,
    containers: [{ name: 'a' }, { name: 'b' }],
  } as AppManifest, { a: { OIDC_SECRET: 'a' }, b: { OIDC_SECRET: 'b' } }, {}), /inconsistent/);
});

test('unchanged optional empty mappings remain empty and input context stays unmodified', () => {
  const context = { sso: { client_secret: '' } };
  const hydrated = updateConfigurationContext(old, { main: { OIDC_SECRET: 'existing' } }, context as never);
  assert.equal(context.sso.client_secret, '');
  assert.equal(hydrated.sso?.client_secret, 'existing');
  assert.deepEqual(updateEnvironment({ OPTIONAL: '${sso.client_secret}' },
    { OPTIONAL: '${sso.client_secret}' }, { OPTIONAL: '' }, context as never), { OPTIONAL: '' });
});

test('declaration cannot traverse object prototypes', () => {
  const manifest = { ...old, env_mapping: { UNSAFE: '${database.__proto__.x}' } };
  assert.throws(() => updateConfigurationContext(manifest, { main: { UNSAFE: 'bad' } }, {}), /Invalid/);
  assert.equal(({} as Record<string, string>).x, undefined);
});
