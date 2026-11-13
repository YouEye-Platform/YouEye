import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';

import {
  AppFormatError, parseApp, parseAppSource, parseBundle, parseCatalog, parseSetup, parseSystemApp,
} from '../src/lib/market/app-format/parse';
import { loadApp, loadFrozenApp, quoteArgv } from '../src/lib/market/app-format/compile';
import { manifestDigest } from '../src/lib/market/app-format/digest';
import { readYAML } from '../src/lib/market/app-format/parse';
import { youeyeRequirementProblem } from '../src/lib/market/app-format/requires';
import { APP_VARIABLES, checkVariable } from '../src/lib/market/app-format/variables';
import { resolvePath, resolveVariables, hasVariables } from '../src/lib/market/variables';
import { catalogFromFiles } from '../src/lib/market/catalog';
import { parseFrozenAppManifest } from '../src/lib/market/frozen-manifest';
import { PIN, appDocument, appFixture, appYAML } from './fixtures/app-format';

const root = process.env.CONTROL_PANEL_ROOT ?? path.resolve(__dirname, '..');

function rejects(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof AppFormatError, `expected AppFormatError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

const sso = { callback: '/login', env: { OIDC_CLIENT_ID: '${sso.client_id}' } };
const setup = (changes: Record<string, unknown> = {}) => stringify({
  schema: 'youeye.setup.v1', for: 'sso', steps: [{ wait: { http: '/health' } }], ...changes,
});

// ─── Schema ───────────────────────────────────────────────

test('a minimal app parses and compiles into the internal model', () => {
  const manifest = appFixture({ data: ['/app/data', { path: '/config', kind: 'config' }], internet: true });
  assert.equal(manifest.metadata.id, 'demo');
  assert.equal(manifest.integration, 'basic');
  assert.equal(manifest.containers.length, 1);
  const [main] = manifest.containers;
  assert.equal(main.name, 'main');
  assert.equal(main.type, 'oci');
  assert.equal(main.network, 'internet');
  assert.deepEqual(main.volumes.map((volume) => [volume.name, volume.container, volume.type]),
    [['data', '/app/data', 'data'], ['config', '/config', 'config']]);
  assert.deepEqual(main.healthCheck, { type: 'http', path: '/health', timeout: 120_000, retries: 3, startPeriod: 0, autoRestart: true });
  assert.equal(manifest.frozen?.schema, 'youeye.frozen-app.v1');
});

test('an unknown field is refused, at the top level and nested', () => {
  rejects(() => parseApp(appYAML({ bogus: 1 })), /bogus: unknown field "bogus"/);
  rejects(() => parseApp(appYAML({ sso: { ...sso, callback_path: '/x' } })), /sso\.callback_path: unknown field/);
});

test('x- keys are kept and never read', () => {
  const app = parseApp(appYAML({ 'x-notes': { owner: 'me' }, sso: { ...sso, 'x-hint': 1 } }));
  assert.deepEqual((app as Record<string, unknown>)['x-notes'], { owner: 'me' });
  assert.equal((app.sso as Record<string, unknown>)['x-hint'], 1);
});

test('ids follow ^[a-z][a-z0-9-]{0,31}$', () => {
  rejects(() => parseApp(appYAML({ id: '1demo' })), /id must be/);
  rejects(() => parseApp(appYAML({ id: 'a'.repeat(33) })), /id must be/);
  rejects(() => parseApp(appYAML({ id: 'Demo' })), /id must be/);
});

test('an image that is not pinned by digest is refused (tests may allow tags explicitly)', () => {
  rejects(() => parseApp(appYAML({ image: 'ghcr.io/example/demo:latest' })), /image: image must be pinned by digest/);
  rejects(() => parseApp(appYAML({ sidecars: [{ name: 'redis', image: 'redis:7' }] })), /sidecars\[0\]\.image: image must be pinned/);
  assert.equal(parseApp(appYAML({ image: 'ghcr.io/example/demo:latest' }), { allowUnpinned: true }).image, 'ghcr.io/example/demo:latest');
  rejects(() => parseSystemApp(stringify({ schema: 'youeye.system-app.v1', id: 'caddy', version: '2', name: 'Caddy', image: 'caddy:2' })), /pinned/);
});

test('native apps take source.node from {22, 24}; there is no app_dir', () => {
  const native = appDocument({ image: undefined, source: { node: '24' } });
  const manifest = loadApp({ manifest: stringify(native) });
  assert.equal(manifest.integration, 'native');
  assert.deepEqual(manifest.containers[0].source, { node: '24' });
  assert.equal(manifest.containers[0].type, 'lxd');
  rejects(() => parseApp(stringify({ ...native, source: { node: '20' } })), /source\.node/);
  rejects(() => parseApp(stringify({ ...native, source: { node: '24.x' } })), /source\.node/);
  rejects(() => parseApp(stringify({ ...native, source: { node: '24', app_dir: '../../etc' } })), /unknown field "app_dir"/);
  rejects(() => parseApp(stringify({ ...native, image: `x/y${PIN}` })), /exactly one of image .* or source/);
});

test('secret names are [a-z0-9_]{1,40}', () => {
  rejects(() => parseApp(appYAML({ secrets: { '../escape': {} } })), /secrets\.\.\.\/escape: Invalid key/);
  rejects(() => parseApp(appYAML({ env: { X: '${secret.Bad-Name}' } })), /unknown variable/);
  assert.ok(parseApp(appYAML({ secrets: { admin_password: { length: 24 } } })));
});

test('container names: [a-z0-9-]{1,30}, main is reserved for the app', () => {
  rejects(() => parseApp(appYAML({ sidecars: [{ name: 'main', image: `redis${PIN}` }] })), /reserved for the app/);
  rejects(() => parseApp(appYAML({ sidecars: [{ name: 'Redis', image: `redis${PIN}` }] })), /container name/);
  rejects(() => parseApp(appYAML({ files: [{ path: '/x/y', container: 'db', template: '' }] })), /unknown container "db"/);
});

test('file paths are absolute and never contain ".."', () => {
  rejects(() => parseApp(appYAML({ files: [{ path: 'relative/file', template: '' }] })), /absolute path/);
  rejects(() => parseApp(appYAML({ files: [{ path: '/config/../etc/passwd', template: '' }] })), /absolute path/);
  rejects(() => parseApp(appYAML({ data: ['/data/../../host'] })), /absolute path/);
});

// ─── Setup files ──────────────────────────────────────────

test('setup http paths must be relative paths on the app itself', () => {
  for (const bad of ['http://169.254.169.254/latest', '//evil.example/x', 'api/x', '/api/../admin', '/a//b', '/x/%2e%2e/y']) {
    rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: bad } }] })), /path on the app itself/);
  }
  assert.ok(parseSetup(setup({ steps: [{ http: { method: 'DELETE', path: '/api/v3/client/${item.id}', for_each: { path: '/api/v3/client' } } }] })));
});

test('exec runs argv only and file steps write absolute paths', () => {
  rejects(() => parseSetup(setup({ steps: [{ exec: { run: 'rm -rf /' } }] })), /steps\.0\.exec\.run/);
  rejects(() => parseSetup(setup({ steps: [{ exec: { run: [] } }] })), /exec\.run/);
  rejects(() => parseSetup(setup({ steps: [{ file: { path: '../x', text: '' } }] })), /absolute path/);
  rejects(() => parseSetup(setup({ steps: [{ file: { path: '/x', text: 'a', json: {} } }] })), /exactly one of json, yaml, ini or text/);
  rejects(() => parseSetup(setup({ steps: [{ wait: { http: '/' }, exec: { run: ['ls'] } }] })), /exactly one of/);
  rejects(() => parseSetup(setup({ for: 'everything' })), /for is sso/);
  rejects(() => parseSetup(setup({ for: 'ai' })), /for is sso, install, url-change or connect/);
});

test('set and save keys never reach the prototype chain', () => {
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'PUT', path: '/c', body_from: 'cfg', set: { 'a.__proto__.b': 1 } } }] })), /__proto__/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'PUT', path: '/c', body_from: 'cfg', set: { 'constructor.prototype': 1 } } }] })), /__proto__|constructor/);
});

test('__proto__, constructor and prototype keys are refused in strict and lenient mode', () => {
  const text = `${appYAML()}__proto__:\n  polluted: true\n`;
  rejects(() => parseApp(text), /key "__proto__" is not allowed/);
  rejects(() => parseApp(text, { lenient: true }), /key "__proto__" is not allowed/);
  rejects(() => parseApp(appYAML({ env: { constructor: 'x' } }), { lenient: true }), /key "constructor" is not allowed/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'POST', path: '/x', body: { prototype: { a: 1 } } } }] })), /key "prototype"/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('inherited Object property names are unknown keys at every level', () => {
  for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    rejects(() => parseApp(`${appYAML()}${key}: x\n`), new RegExp(`unknown field "${key}"`));
    rejects(() => parseApp(appYAML({ listing: { description: 'Demo', [key]: 'x' } })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseApp(appYAML({ sso: { ...sso, [key]: 'x' } })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseApp(appYAML({ sidecars: [{ name: 'redis', image: `redis${PIN}`, [key]: 1 }] })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseApp(appYAML({ secrets: { api_key: { kind: 'key', [key]: 1 } } })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseSetup(setup({ [key]: 'x' })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseSetup(setup({ steps: [{ [key]: { path: '/x' } }] })), /a step has exactly one of/);
    rejects(() => parseSetup(setup({ steps: [{ http: { path: '/x', [key]: 1 } }] })), new RegExp(`unknown field "${key}"`));
    rejects(() => parseSetup(setup({ steps: [{ http: { path: '/x', if: { empty: 'a', [key]: 'b' } } }] })), new RegExp(`unknown field "${key}"`));
  }
});

test('api_key names a secret the manifest declares or uses; file/regex is gone', () => {
  assert.equal(parseApp(appYAML({ secrets: { api_key: { kind: 'key' } }, api_key: { secret: 'api_key' } })).api_key?.secret, 'api_key');
  assert.ok(parseApp(appYAML({ env: { PW: '${secret.admin_password}' }, api_key: { secret: 'admin_password' } })));
  assert.ok(parseApp(appYAML({ credentials: [{ label: 'Admin', username: 'admin', password: 'admin_pw' }], api_key: { secret: 'admin_pw' } })));
  rejects(() => parseApp(appYAML({ api_key: { secret: 'api_key' } })), /api_key\.secret: "api_key" is not a secret of this app/);
  rejects(() => parseApp(appYAML({ api_key: { file: '/config/config.xml', regex: '<ApiKey>([^<]+)</ApiKey>' } })), /api_key\.secret: Invalid input/);
  rejects(() => parseApp(appYAML({ secrets: { api_key: null }, api_key: { secret: '../x' } })), /secret name/);
});

test('YAML aliases, duplicate keys and documents over 1 MiB are refused', () => {
  rejects(() => parseApp(`${appYAML()}env: &e { A: "1" }\nsmtp: { env: *e }\n`), /alias/i);
  rejects(() => parseApp(`${appYAML()}port: 9090\n`), /unique|duplicate/i);
  rejects(() => parseApp(`${appYAML()}x-pad: "${'a'.repeat(1024 * 1024)}"\n`), /larger than 1 MiB/);
});

// ─── Variables ────────────────────────────────────────────

test('a variable of an undeclared feature is refused', () => {
  rejects(() => parseApp(appYAML({ env: { CLIENT: '${sso.client_id}' } })), /needs `sso:`/);
  rejects(() => parseApp(appYAML({ env: { DB: '${database.url}' } })), /needs `database:`/);
  rejects(() => parseApp(appYAML({ env: { MAIL: '${smtp.host}' } })), /needs `smtp:`/);
  rejects(() => parseApp(appYAML({ env: { KEY: '${ai.api_key}' } })), /needs `ai:`/);
  rejects(() => parseApp(appYAML({ env: { R: '${sidecar.redis.host}' } })), /sidecar the app does not declare/);
  rejects(() => parseApp(appYAML({ sidecars: [{ name: 'redis', image: `redis${PIN}` }], env: { R: '${sidecar.redis.url}' } })), /needs a port/);
  assert.ok(parseApp(appYAML({ sso, database: 'postgres', env: { DB: '${database.url}' } })));
  assert.ok(parseApp(appYAML({ sidecars: [{ name: 'redis', image: `redis${PIN}`, port: 6379 }], env: { R: '${sidecar.redis.url}' } })));
});

test('an unknown or removed variable is refused', () => {
  for (const name of ['secrets.admin_password', 'containers.redis.internal_host', 'integration.app_token',
    'install.url', 'container.ip', 'wire.to.host', 'installParams.x', 'identity.externalUrl', 'ai.apiKey', 'nope.x']) {
    rejects(() => parseApp(appYAML({ env: { X: `\${${name}}` } })), /unknown variable/);
  }
});

test('setup-only variables: vars/item in setup files, peer/self only in connect files', () => {
  rejects(() => parseApp(appYAML({ env: { X: '${vars.token}' } })), /only available in setup files/);
  const app = parseApp(appYAML({ sso }));
  assert.ok(parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', headers: { A: '${vars.token}' } } }] }), { app }));
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', headers: { A: '${peer.api_key}' } } }] }), { app }), /connect:<app>/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', target: 'peer' } }] }), { app }), /target: peer/);
  rejects(() => parseSetup(setup({ steps: [{ restart: 'db' }] }), { app }), /unknown container "db"/);
});

test('a setup file may use only variables it is given', () => {
  const app = parseApp(appYAML({ sso, ai: { env: { KEY: '${ai.api_key}' } }, env: { TOKEN: '${youeye.app_token}' } }));
  const header = (value: string, kind = 'sso') => setup({ for: kind, steps: [{ http: { method: 'GET', path: '/x', headers: { A: value } } }] });
  // Re-runs (url-change, the sign-in toggle) have no gateway token and no Pointer key.
  for (const name of ['youeye.app_token', 'ai.api_key', 'ai.openai_base_url']) {
    rejects(() => parseSetup(header(`\${${name}}`), { app }), /not available in setup files/);
  }
  assert.ok(parseSetup(header('${sso.client_id} ${platform.domain} ${app.internal_url}'), { app }));
  // A connect file gets the consumer's identity and secrets, and the peer/self values; nothing else.
  for (const ok of ['${app.url}', '${app.fqdn}', '${secret.api_key}', '${self.url}', '${peer.api_key}', '${vars.x}']) {
    assert.ok(parseSetup(header(ok, 'connect:prowlarr'), { app }), ok);
  }
  for (const name of ['app.internal_url', 'platform.domain', 'identity.internal_url', 'sso.client_id', 'youeye.gateway_url']) {
    rejects(() => parseSetup(header(`\${${name}}`, 'connect:prowlarr'), { app }), /not available in connect:<app> setup files/);
  }
});

test('setup files: purpose names, connect references, implicit secrets', () => {
  const manifest = appYAML({
    sso,
    connects: [{ app: 'prowlarr', name: 'Prowlarr', setup: 'setup/connect-prowlarr.yaml' }],
  });
  const connect = stringify({ schema: 'youeye.setup.v1', for: 'connect:prowlarr', steps: [
    { http: { method: 'POST', path: '/api/v1/applications', target: 'peer', headers: { 'X-Api-Key': '${peer.api_key}' }, body: { key: '${secret.api_key}' } } },
  ] });
  const parsed = parseAppSource({ manifest, setups: { 'setup/sso.yaml': setup(), 'setup/connect-prowlarr.yaml': connect } });
  assert.deepEqual(parsed.setups.map((item) => item.setup.for), ['connect:prowlarr', 'sso']);
  const compiled = loadApp({ manifest, setups: { 'setup/sso.yaml': setup(), 'setup/connect-prowlarr.yaml': connect } });
  assert.ok(compiled.secrets.some((secret) => secret.name === 'api_key' && secret.file === 'secrets/api_key'));
  assert.equal(compiled.wants[0].setup, 'setup/connect-prowlarr.yaml');
  rejects(() => parseAppSource({ manifest, setups: { 'setup/login.yaml': setup() } }), /named setup\/sso\.yaml/);
  rejects(() => parseAppSource({ manifest, setups: {} }), /connect-prowlarr\.yaml does not exist/);
  rejects(() => parseAppSource({ manifest: appYAML({ sso }), setups: { 'setup/connect-prowlarr.yaml': connect } }), /no connects entry/);
  rejects(() => parseAppSource({ manifest, setups: { '../sso.yaml': setup() } }), /setup files are named/);
});

test('the variable registry and docs/app-environment.md list exactly the same names', () => {
  const doc = readFileSync(path.join(root, '..', 'docs', 'app-environment.md'), 'utf8');
  const documented = new Set<string>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cell = line.split('|')[1];
    let base = '';
    for (const token of cell.match(/`[^`]+`/g) ?? []) {
      const value = token.slice(1, -1);
      if (value.startsWith('${')) {
        const name = value.slice(2, -1);
        documented.add(name);
        base = name.slice(0, name.lastIndexOf('.'));
      } else if (value.startsWith('.')) {
        documented.add(`${base}${value}`);
      }
    }
  }
  assert.deepEqual([...documented].sort(), APP_VARIABLES.map((variable) => variable.doc).sort());
});

test('variable resolution walks own properties only and has no shared regex state', () => {
  const ctx = { app: { id: 'demo' }, secret: { a: '1' } };
  assert.equal(resolvePath('app.constructor', ctx), undefined);
  assert.equal(resolvePath('app.__proto__', ctx), undefined);
  assert.equal(resolvePath('app.toString', ctx), undefined);
  assert.throws(() => resolveVariables('${app.constructor}', ctx), /Unresolved/);
  assert.equal(hasVariables('${app.id}'), true);
  assert.equal(hasVariables('${app.id}'), true, 'a second call must not depend on lastIndex');
  assert.equal(resolveVariables('${app.id}-${secret.a}', ctx), 'demo-1');
  assert.equal(checkVariable('sso.client_id', { sidecars: new Map(), database: false, sso: true, smtp: false, ai: false }), null);
});

// ─── Compile ──────────────────────────────────────────────

test('compile maps database, shared folders, sidecars, sso/ai/smtp env and connections', () => {
  const manifest = appFixture({
    database: { sidecar: 'db', name: 'immich', user: 'immich' },
    sidecars: [
      { name: 'db', image: `postgres${PIN}`, port: 5432, data: ['/var/lib/postgresql/data'], env: { POSTGRES_PASSWORD: '${secret.db_password}' } },
      { name: 'redis', image: `valkey${PIN}`, command: ['valkey-server', '--save', '60 1'] },
    ],
    shared: { media: '/data' },
    env: { URL: '${app.url}', PORT: 8080 },
    sso: { callback: '/auth/${sso.slug}', extra_callbacks: ['/oauth2/cb'], env: { OIDC: '${sso.discovery_url}' } },
    ai: { env: { OPENAI_API_KEY: '${ai.api_key}' } },
    smtp: { env: { SMTP_HOST: '${smtp.host}' } },
    forward_auth: false,
    provides: [{ type: 'pvr', port: 8080, scope: 'service' }],
    connects: [{ type: 'indexer', name: 'Indexer', port: 9696, proxy: { paths: ['/api/*'] } }],
    secrets: { api_key: { kind: 'key' } },
    api_key: { secret: 'api_key' },
  });
  // Sidecars deploy (and pass their health checks) before main; main stays primary.
  assert.deepEqual(manifest.containers.map((container) => [container.name, container.primary]), [['db', false], ['redis', false], ['main', true]]);
  const container = (name: string) => manifest.containers.find((spec) => spec.name === name)!;
  assert.equal(container('redis').command, "valkey-server --save '60 1'");
  assert.deepEqual(container('main').volumes[0], { name: 'media', container: '/data', type: 'media', read_only: false, storageGroup: 'media' });
  assert.deepEqual(manifest.database, { mode: 'own', container: 'db', name: 'immich', user: 'immich' });
  assert.deepEqual(manifest.backup?.ownPostgres, { container: 'app-demo-db', database: 'immich', user: 'immich' });
  assert.ok(manifest.secrets.some((secret) => secret.name === 'db_password'));
  assert.deepEqual(manifest.env_mapping, {
    URL: '${app.url}', PORT: '8080', SMTP_HOST: '${smtp.host}', OPENAI_API_KEY: '${ai.api_key}', OIDC: '${sso.discovery_url}',
  });
  assert.deepEqual(container('db').environment, { POSTGRES_PASSWORD: '${secret.db_password}' });
  assert.equal(manifest.capabilities?.smtp, true);
  assert.equal(manifest.capabilities?.ai_api, true);
  assert.equal(manifest.forwardAuth, 'disabled');
  assert.deepEqual(manifest.sso, { callback_path: '/auth/${sso.slug}', entry_url: undefined, additional_callbacks: ['/oauth2/cb'], backchannel_logout_path: undefined, admin_group: 'admin', role_claim: undefined });
  assert.deepEqual(manifest.wants[0], { appId: undefined, type: 'indexer', name: 'Indexer', description: undefined, defaultPort: 9696, proxy: { paths: ['/api/*'], methods: ['GET'] }, scope: 'user', setup: undefined });
  assert.deepEqual(manifest.apiKey, { secret: 'api_key' });
  assert.equal(quoteArgv(["it's"]), `'it'\\''s'`);
});

test('database: postgres is the shared database named after the app', () => {
  const manifest = appFixture({ id: 'paperless-ngx', database: 'postgres' });
  assert.deepEqual(manifest.database, { mode: 'shared', name: 'paperless_ngx', user: 'paperless_ngx' });
  assert.ok(manifest.secrets.some((secret) => secret.name === 'db_password'));
});

// ─── Digest and frozen copies ─────────────────────────────

test('the digest ignores listing: and follows the manifest and setup files', () => {
  const digest = (changes: Record<string, unknown>, setups: Array<{ name: string; raw: unknown }> = []) =>
    manifestDigest(readYAML(appYAML(changes)), setups);
  const base = digest({});
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest({ listing: { description: 'Other words', tags: ['x'] } }), base);
  assert.notEqual(digest({ port: 8081 }), base);
  assert.notEqual(digest({}, [{ name: 'setup/sso.yaml', raw: { steps: [] } }]), base);
  // Key order does not matter.
  const reordered = Object.fromEntries(Object.entries(appDocument()).reverse());
  assert.equal(manifestDigest(readYAML(stringify(reordered))), base);
  assert.equal(appFixture().frozen?.digest, base);
});

test('frozen copies are read leniently and compiled', () => {
  const frozen = { schema: 'youeye.frozen-app.v1', manifest: appYAML({ image: 'example/demo:old-tag' }), setups: {}, digest: 'x' };
  const manifest = parseFrozenAppManifest(JSON.stringify({ name: 'demo', frozen }), 'demo', '1.0.0');
  assert.equal(manifest.containers[0].image, 'example/demo:old-tag');
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ frozen }), 'other'), /frozen installed manifest/);
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ metadata: { id: 'demo' } }), 'demo'), /frozen installed manifest/);
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ frozen }), 'demo', '2.0.0'), /disagree/);
  assert.equal(loadFrozenApp({ manifest: frozen.manifest, setups: {}, version: '1.0.0-dev.3' }).version, '1.0.0-dev.3');
});

test('a frozen copy must match the install record digest', () => {
  const frozen = { schema: 'youeye.frozen-app.v1', manifest: appYAML(), setups: {}, digest: 'stored-values-are-not-trusted' };
  const recorded = loadFrozenApp(frozen).frozen!.digest;
  assert.match(recorded, /^sha256:[0-9a-f]{64}$/);
  assert.equal(parseFrozenAppManifest(JSON.stringify({ frozen }), 'demo', undefined, recorded).frozen!.digest, recorded);
  // Listing text is outside the digest; anything else is a change.
  const relisted = { ...frozen, manifest: appYAML({ listing: { description: 'New text' } }) };
  assert.ok(parseFrozenAppManifest(JSON.stringify({ frozen: relisted }), 'demo', undefined, recorded));
  const changed = { ...frozen, manifest: appYAML({ env: { EXTRA: '1' } }) };
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ frozen: changed }), 'demo', undefined, recorded),
    (error: { code?: string; message: string }) => error.code === 'frozen-digest-mismatch' && /does not match its install record/.test(error.message));
  const withSetup = { ...frozen, setups: { 'setup/install.yaml': setup({ for: 'install' }) } };
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ frozen: withSetup }), 'demo', undefined, recorded), /does not match/);
  assert.throws(() => parseFrozenAppManifest(JSON.stringify({ frozen }), 'demo', undefined, ''), /does not match/);
});

// ─── requires.youeye ──────────────────────────────────────

test('requires.youeye refuses older platforms with a clear message', () => {
  assert.equal(youeyeRequirementProblem(undefined, '0.0.0'), null);
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.0' }, '0.6.0'), null);
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.0' }, '0.6.1-dev.4'), null);
  assert.equal(youeyeRequirementProblem({ youeye: '>=0.6.0' }, '1.0.0'), null);
  assert.equal(youeyeRequirementProblem({ youeye: '>=9.0.0' }, '0.6.2-rc.1'), 'This app needs YouEye ≥ 9.0.0; this box runs 0.6.2-rc.1.');
  assert.match(youeyeRequirementProblem({ youeye: '>=0.6.2' }, 'unknown') ?? '', /needs YouEye ≥ 0\.6\.2/);
  rejects(() => parseApp(appYAML({ requires: { youeye: '^0.6.0' } })), /requires\.youeye must be ">=X\.Y\.Z"/);
  assert.equal(appFixture({ requires: { youeye: '>=9.0.0' } }).requires?.youeye, '>=9.0.0');
});

// ─── Other kinds and catalog discovery ────────────────────

test('bundles, system apps and catalog.yaml use their own strict kinds', () => {
  const bundle = parseBundle(stringify({ schema: 'youeye.bundle.v1', id: 'media', name: 'Media', description: 'd', members: ['sonarr'], connections: [{ from: 'sonarr', to: 'prowlarr' }], shared: ['media'] }));
  assert.deepEqual(bundle.members, ['sonarr']);
  rejects(() => parseBundle(stringify({ schema: 'youeye.bundle.v1', id: 'media', name: 'M', description: 'd', members: ['a'], storageGroups: [] })), /unknown field "storageGroups"/);
  const system = parseSystemApp(stringify({ schema: 'youeye.system-app.v1', id: 'caddy', version: '2.11.4', name: 'Caddy', image: `docker.io/library/caddy${PIN}` }));
  assert.equal(system.id, 'caddy');
  rejects(() => parseCatalog(stringify({ apiVersion: 'v1', kind: 'catalog', apps: [] })), /schema/);
  rejects(() => parseCatalog(stringify({ schema: 'youeye.catalog.v1', apps: [{ id: 'x' }] })), /unknown field "apps"/);
});

test('the catalog app list is discovered from the folders', () => {
  const catalogYaml = stringify({
    schema: 'youeye.catalog.v1',
    categories: [{ id: 'media', label: 'Media', order: 2 }],
    curation: { spotlight: { apps: ['notes'] } },
    native: ['notes', 'wiki'],
  });
  const catalog = catalogFromFiles(catalogYaml, [
    'catalog.yaml',
    'apps/sonarr/youeye-app.yaml', 'apps/sonarr/icon.svg', 'apps/sonarr/setup/connect-prowlarr.yaml',
    'apps/mealie/youeye-app.yaml', 'apps/mealie/screenshots/a.png',
    'apps/Bad/youeye-app.yaml', 'apps/stray.yaml',
    'bundles/media-automation/bundle.yaml',
    'system/caddy.yaml', 'system/postgresql.yaml',
  ]);
  assert.deepEqual(catalog.apps, [
    { id: 'mealie', integration: 'basic', path: 'apps/mealie' },
    { id: 'notes', integration: 'native' },
    { id: 'sonarr', integration: 'basic', path: 'apps/sonarr' },
    { id: 'wiki', integration: 'native' },
  ]);
  assert.deepEqual(catalog.bundles, ['media-automation']);
  assert.deepEqual(catalog.system, ['caddy', 'postgresql']);
  assert.deepEqual(catalog.curation, { spotlight: { title: undefined, apps: ['notes'] }, collections: [] });
  assert.throws(() => catalogFromFiles(stringify({ schema: 'youeye.catalog.v1', native: ['mealie'] }), ['apps/mealie/youeye-app.yaml']), /also has an app folder/);
});

// ─── Gaps found by the catalog conversion ─────────────────

test('proxy hosts may have one leading wildcard label', () => {
  const native = (host: string) => parseApp(stringify(appDocument({ image: undefined, source: { node: '24' }, proxy: [{ host, paths: ['/w/api.php*'] }] })));
  assert.equal(native('*.wikipedia.org').proxy?.[0].host, '*.wikipedia.org');
  rejects(() => native('*.*.wikipedia.org'), /proxy host/);
  rejects(() => native('en.*.org'), /proxy host/);
  rejects(() => native('*'), /proxy host/);
  const manifest = loadApp({ manifest: stringify(appDocument({ image: undefined, source: { node: '24' }, proxy: [{ host: '*.wikipedia.org', paths: ['/api/*'] }] })) });
  assert.deepEqual(manifest.internet?.proxy, [{ host: '*.wikipedia.org', paths: ['/api/*'], methods: ['GET'], scope: 'user' }]);
});

test('sso.role_claim marks admins by a claim value and excludes admin_group', () => {
  const role = { claim: 'immich_role', admin_value: 'admin', default_value: 'user' };
  assert.deepEqual(appFixture({ sso: { callback: '/auth/login', role_claim: role } }).sso?.role_claim, role);
  rejects(() => parseApp(appYAML({ sso: { callback: '/x', admin_group: 'admin', role_claim: role } })), /admin_group or role_claim, not both/);
  rejects(() => parseApp(appYAML({ sso: { callback: '/x', role_claim: { claim: 'r' } } })), /role_claim\.admin_value/);
  const roles = { claim: 'kavita_roles', admin_value: ['Admin', 'Login'], default_value: ['Login', 'Change Password'] };
  assert.deepEqual(appFixture({ sso: { callback: '/x', role_claim: roles } }).sso?.role_claim, roles);
  rejects(() => parseApp(appYAML({ sso: { callback: '/x', role_claim: { ...roles, default_value: 'user' } } })),
    /both strings or both lists/);
  rejects(() => parseApp(appYAML({ sso: { callback: '/x', role_claim: { ...roles, admin_value: [] } } })), /role_claim/);
  for (const claim of ['sub', 'groups', 'is_admin', 'email', 'Email', 'openid']) {
    rejects(() => parseApp(appYAML({ sso: { callback: '/x', role_claim: { ...role, claim } } })), /standard claim or scope/);
  }
});

test('sso.extra_callbacks are app paths or custom-scheme URIs, never http(s) URLs', () => {
  const manifest = appFixture({ sso: { callback: '/auth/login', extra_callbacks: ['/user-settings', 'app.immich:///oauth-callback'] } });
  assert.deepEqual(manifest.sso?.additional_callbacks, ['/user-settings', 'app.immich:///oauth-callback']);
  for (const bad of ['https://evil.example/cb', 'http://10.0.0.1/cb', 'javascript:alert(1)', '//evil.example/cb', 'cb']) {
    rejects(() => parseApp(appYAML({ sso: { callback: '/x', extra_callbacks: [bad] } })), /extra callbacks/);
  }
});

test('an Immich-like app deploys its sidecars, healthy, before main', () => {
  const manifest = appFixture({
    id: 'immich',
    port: 2283,
    health: { path: '/api/server/ping', timeout: 120 },
    env: { DB_HOSTNAME: '${sidecar.postgres.host}', REDIS_HOSTNAME: '${sidecar.redis.host}' },
    database: { sidecar: 'postgres', name: 'immich', user: 'immich' },
    sidecars: [
      { name: 'postgres', image: `postgres${PIN}`, port: 5432, data: ['/var/lib/postgresql/data'], health: { postgres: 'postgres', timeout: 60 } },
      { name: 'redis', image: `valkey${PIN}`, port: 6379 },
      { name: 'machine-learning', image: `ml${PIN}`, port: 3003 },
    ],
  });
  // The engine creates, starts and health-checks containers in manifest order
  // (engine.ts installApp), so this order is the deploy order.
  assert.deepEqual(manifest.containers.map((spec) => spec.name), ['postgres', 'redis', 'machine-learning', 'main']);
  assert.deepEqual(manifest.containers.filter((spec) => spec.primary).map((spec) => spec.name), ['main']);
  assert.equal(manifest.containers.at(-1)!.healthCheck?.path, '/api/server/ping');
  assert.equal(manifest.containers[0].healthCheck?.type, 'postgres');
  assert.deepEqual(manifest.database, { mode: 'own', container: 'postgres', name: 'immich', user: 'immich' });
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const loop = engine.indexOf('for (const containerSpec of manifest.containers) {', engine.indexOf('async function installAppLocked'));
  assert.ok(loop !== -1 && loop < engine.indexOf('Health check failed for ${containerName}', loop));
});

test('a sidecar health check may be pg_isready as a user', () => {
  const manifest = appFixture({ sidecars: [{ name: 'db', image: `postgres${PIN}`, health: { postgres: 'postgres', timeout: 60 } }] });
  assert.deepEqual(manifest.containers.find((spec) => spec.name === 'db')!.healthCheck, { type: 'postgres', user: 'postgres', timeout: 60_000, retries: 3, startPeriod: 0, autoRestart: true });
  rejects(() => parseApp(appYAML({ health: { postgres: 'postgres' } })), /health/);
  rejects(() => parseApp(appYAML({ sidecars: [{ name: 'db', image: `postgres${PIN}`, health: { postgres: 'bad user' } }] })), /health/);
});

test('files take mode and dir_mode as octal strings', () => {
  const manifest = appFixture({ data: ['/config'], files: [
    { path: '/config/a.sh', mode: '0755', dir_mode: '0750', template: 'x' },
    { path: '/config/b.conf', template: 'y' },
  ] });
  assert.deepEqual(manifest.configFiles.map((file) => [file.permission, file.directoryPermission]), [['0o755', '0o750'], ['0o644', '0o700']]);
  rejects(() => parseApp(appYAML({ files: [{ path: '/c/a', dir_mode: '777x', template: '' }] })), /octal/);
});

test('setup conditions: equals, not_equals, empty, not_empty (exactly one)', () => {
  for (const condition of [{ equals: ['a', 'b'] }, { not_equals: ['a', 'b'] }, { empty: '${vars.x}' }, { not_empty: '${vars.x}' }]) {
    assert.ok(parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', if: condition } }] })));
  }
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', if: { empty: 'a', not_empty: 'b' } } }] })), /exactly one of equals/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', if: {} } }] })), /exactly one of equals/);
});

test('for_each.items and save take "$" or a dotted response path', () => {
  assert.ok(parseSetup(setup({ steps: [
    { http: { method: 'GET', path: '/config', save: { config: '$', token: 'data.items[0].token' } } },
    { http: { method: 'DELETE', path: '/idp/${item.id}', for_each: { path: '/config', items: 'identityProviders', where: { name: 'YouEye' } } } },
  ] })));
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', save: { all: '' } } }] })), /"\$" or a dotted path/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', save: { a: 'x.__proto__' } } }] })), /__proto__/);
  rejects(() => parseSetup(setup({ steps: [{ http: { method: 'GET', path: '/x', for_each: { path: '/x', items: '../x' } } }] })), /"\$" or a dotted path/);
});

test('public_access: true compiles to publicAccess; false or absent leaves it unset', () => {
  assert.equal(appFixture({ public_access: true }).publicAccess, true);
  assert.equal(appFixture({ public_access: false }).publicAccess, undefined);
  assert.equal(appFixture({}).publicAccess, undefined);
  assert.throws(() => appFixture({ public_access: 'yes' }));
});
