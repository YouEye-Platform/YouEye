import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { containerOrder, fakeIncus, loadSnapshot, loadSource } from './fixtures/update-provider-harness';

const PENDING = 'user.youeye.env-restart-pending';

const apps = [
  { appId: 'memos', containers: [
    { name: 'main', containerName: 'app-memos', primary: true },
    { name: 'db', containerName: 'app-memos-db', role: 'database' },
  ] },
  { appId: 'notes', containers: [{ name: 'main', containerName: 'app-notes', primary: true }] },
];

function load(platform = { siteName: 'Home', timezone: 'UTC', locale: 'en', version: '0.6.13' }) {
  const incus = fakeIncus();
  incus.addInstance('app-memos', 'Running');
  incus.addInstance('app-memos-db', 'Running');
  incus.addInstance('app-notes', 'Stopped');
  const locks: string[] = [];
  const interrupt = { on: false };
  /** Containers whose mark can't be cleared: Incus refuses the PATCH that unsets it. */
  const unclearable = new Set<string>();
  const snapshot = loadSnapshot(incus);
  const stubs: Record<string, unknown> = {
    '@/lib/incus/server': { incusRequest: async (method: string, url: string, body?: { config?: Record<string, string> }) => {
      const name = decodeURIComponent(url.split('/')[3] ?? '');
      if (method === 'PATCH' && body?.config?.[PENDING] === '' && unclearable.has(name)) {
        return { type: 'error', error_code: 500, status_code: 500, error: 'connection reset' };
      }
      return incus.incusRequest(method, url, body);
    } },
    '@/lib/incus/snapshot': { ...snapshot,
      stopContainerOrForce: async (...args: unknown[]) => {
        if (interrupt.on) throw new Error('socket hang up');
        return snapshot.stopContainerOrForce(...args);
      } },
    '@/lib/apps/container-order': containerOrder(),
    './metadata': { listInstalledApps: async () => apps },
    './platform-env': { getPlatformContext: async () => platform, clearPlatformContextCache() {} },
    './frozen-manifest': { readInstalledAppManifest: async (appId: string) => ({ capabilities: { smtp: appId === 'memos' } }) },
    './update-admission': { withAppLifecycle: async (appId: string, work: () => unknown) => { locks.push(appId); return work(); } },
    '@/lib/settings': { settingsService: { getAll: async () => ({ smtpHost: 'mail.example', smtpPort: 587, smtpFrom: 'box@example' }) } },
    '@/lib/smtp/secrets': { readSmtpPassword: async () => 'secret' },
  };
  const propagation = loadSource('lib/market/propagation.ts', name => stubs[name] ?? {});
  return { incus, locks, platform, propagation, interrupt, unclearable };
}

test('platform settings are written once: the first run restarts what runs in app order, the next changes nothing', async () => {
  const f = load();
  let result = await f.propagation.propagateSettingsToApps();
  assert.deepEqual(result, { appsUpdated: ['memos', 'notes'], appsFailed: [], errors: [] });
  // The app is stopped main first and started database first; a stopped app is written, not started.
  // Each write marks its container as waiting for a restart; the mark goes once the container is stopped.
  assert.deepEqual(f.incus.log, [
    'patch:app-memos', 'patch:app-memos-db', 'stop:app-memos:60', 'patch:app-memos', 'stop:app-memos-db:120',
    'patch:app-memos-db', 'start:app-memos-db', 'start:app-memos', 'patch:app-notes', 'patch:app-notes',
  ]);
  for (const name of ['app-memos', 'app-memos-db', 'app-notes']) assert.notEqual(f.incus.instances.get(name)!.config[PENDING], '1');
  assert.equal(f.incus.instances.get('app-notes')!.config['environment.YOUEYE_SITE_NAME'], 'Home');
  assert.equal(f.incus.instances.get('app-notes')!.status, 'Stopped');

  // Nothing changed: no app is locked, written or restarted.
  f.incus.log.length = 0; f.locks.length = 0;
  result = await f.propagation.propagateSettingsToApps();
  assert.deepEqual(result, { appsUpdated: [], appsFailed: [], errors: [] });
  assert.deepEqual(f.incus.log, []);
  assert.deepEqual(f.locks, [], 'an unchanged app is not even taken (taking it cancels its pending recovery)');

  // One value changed: every app again.
  f.platform.siteName = 'Cabin';
  result = await f.propagation.propagateSettingsToApps();
  assert.deepEqual(result.appsUpdated, ['memos', 'notes']);
  assert.equal(f.incus.log.filter(entry => entry.startsWith('stop:')).length, 2);
});

test('an app whose containers got the values with another restart is not restarted again; one stale container restarts the app', async () => {
  const f = load();
  // The URL change wrote the platform keys before its own restart of each container.
  const env = await f.propagation.platformEnvironment();
  for (const name of ['app-memos', 'app-memos-db', 'app-notes']) {
    assert.equal(await f.propagation.writeContainerEnvironment(name, env), true);
    assert.equal(f.incus.instances.get(name)!.config[PENDING], '1', 'written with the mark, in one PATCH');
    assert.equal(await f.propagation.writeContainerEnvironment(name, env), false, 'already in place: not written again');
    // ... and the URL change restarted the container.
    await f.propagation.clearEnvRestartPending(name);
  }
  f.incus.log.length = 0;
  assert.deepEqual((await f.propagation.propagateSettingsToApps()).appsUpdated, []);
  assert.deepEqual(f.incus.log, []);

  delete f.incus.instances.get('app-memos-db')!.config['environment.YOUEYE_LOCALE'];
  assert.deepEqual((await f.propagation.propagateSettingsToApps()).appsUpdated, ['memos']);
  assert.deepEqual(f.incus.log, ['patch:app-memos-db', 'stop:app-memos:60', 'stop:app-memos-db:120', 'patch:app-memos-db',
    'start:app-memos-db', 'start:app-memos']);
});

test('a propagation interrupted after the write is finished by the next run', async () => {
  const f = load();
  // The Control Panel dies (or the stop fails) right after the values were written: nothing is restarted.
  f.interrupt.on = true;
  let result = await f.propagation.propagateSettingsToApps();
  assert.deepEqual(result.appsFailed, ['memos']);
  assert.deepEqual(f.incus.log.filter(entry => !entry.startsWith('patch:')), []);
  assert.equal(f.incus.instances.get('app-memos')!.config['environment.YOUEYE_SITE_NAME'], 'Home');
  assert.equal(f.incus.instances.get('app-memos')!.config[PENDING], '1');
  assert.equal(f.incus.instances.get('app-memos-db')!.config[PENDING], '1');

  // The containers hold every value, but still run with the old ones: the next run restarts the app, once.
  f.interrupt.on = false; f.incus.log.length = 0;
  result = await f.propagation.propagateSettingsToApps();
  assert.deepEqual(result, { appsUpdated: ['memos'], appsFailed: [], errors: [] });
  assert.deepEqual(f.incus.log, ['stop:app-memos:60', 'patch:app-memos', 'stop:app-memos-db:120', 'patch:app-memos-db',
    'start:app-memos-db', 'start:app-memos']);
  f.incus.log.length = 0; f.locks.length = 0;
  assert.deepEqual(await f.propagation.propagateSettingsToApps(), { appsUpdated: [], appsFailed: [], errors: [] });
  assert.deepEqual([f.incus.log, f.locks], [[], []]);
});

test('a write whose restart was interrupted half way is finished: the stopped container only loses its mark', async () => {
  const f = load();
  f.interrupt.on = true;
  await f.propagation.propagateSettingsToApps();
  // The main container was stopped by someone else meanwhile; the database still runs with the old values.
  f.incus.instances.get('app-memos')!.status = 'Stopped';
  f.interrupt.on = false; f.incus.log.length = 0;
  assert.deepEqual((await f.propagation.propagateSettingsToApps()).appsUpdated, ['memos']);
  assert.deepEqual(f.incus.log, ['patch:app-memos', 'stop:app-memos-db:120', 'patch:app-memos-db', 'start:app-memos-db']);
  assert.equal(f.incus.instances.get('app-memos')!.status, 'Stopped', 'a stopped container is not started');
});

test('a URL change that threw after writing its keys leaves the restart to the next propagation', async () => {
  const f = load();
  const env = await f.propagation.platformEnvironment();
  for (const name of ['app-memos', 'app-memos-db', 'app-notes']) await f.propagation.writeContainerEnvironment(name, env);
  // No restart followed. app-notes is stopped: it only loses its mark.
  f.incus.log.length = 0;
  assert.deepEqual((await f.propagation.propagateSettingsToApps()).appsUpdated, ['memos', 'notes']);
  assert.deepEqual(f.incus.log, ['stop:app-memos:60', 'patch:app-memos', 'stop:app-memos-db:120', 'patch:app-memos-db',
    'start:app-memos-db', 'start:app-memos', 'patch:app-notes']);
});

test("a mark only a Frozen container keeps restarts nothing: the app's other containers are left alone", async () => {
  const f = load();
  const env = await f.propagation.platformEnvironment();
  for (const name of ['app-memos', 'app-memos-db', 'app-notes']) await f.propagation.writeContainerEnvironment(name, env);
  await f.propagation.clearEnvRestartPending('app-memos');
  await f.propagation.clearEnvRestartPending('app-notes');
  f.incus.instances.get('app-memos-db')!.status = 'Frozen';
  for (let run = 0; run < 2; run++) {
    f.incus.log.length = 0;
    assert.deepEqual(await f.propagation.propagateSettingsToApps(), { appsUpdated: [], appsFailed: [], errors: [] });
    assert.deepEqual(f.incus.log, [], 'app-memos is not restarted again for its frozen database');
  }
  assert.equal(f.incus.instances.get('app-memos-db')!.config[PENDING], '1', 'the frozen container keeps its mark');

  // Once it runs again, the next propagation restarts the app and clears the mark.
  f.incus.instances.get('app-memos-db')!.status = 'Running';
  assert.deepEqual((await f.propagation.propagateSettingsToApps()).appsUpdated, ['memos']);
  assert.deepEqual(f.incus.log, ['stop:app-memos:60', 'stop:app-memos-db:120', 'patch:app-memos-db', 'start:app-memos-db',
    'start:app-memos']);
  assert.notEqual(f.incus.instances.get('app-memos-db')!.config[PENDING], '1');
});

test('a mark that cannot be cleared does not leave the stopped containers stopped', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const f = load();
  f.unclearable.add('app-memos');
  assert.deepEqual(await f.propagation.propagateSettingsToApps(), { appsUpdated: ['memos', 'notes'], appsFailed: [], errors: [] });
  assert.deepEqual(f.incus.log.filter(entry => !entry.startsWith('patch:')), ['stop:app-memos:60', 'stop:app-memos-db:120',
    'start:app-memos-db', 'start:app-memos']);
  assert.equal(f.incus.instances.get('app-memos')!.status, 'Running');
  assert.equal(f.incus.instances.get('app-memos')!.config[PENDING], '1', 'it costs one more restart at the next run');
  assert.ok(warn.mock.calls.some(call => /memos: restart mark not cleared on app-memos/.test(String(call.arguments[0]))));
});

test("the owner's start clears the mark of what it starts, and a restart of every container", async () => {
  const f = load();
  const env = await f.propagation.platformEnvironment();
  f.incus.instances.get('app-memos-db')!.status = 'Stopped';
  for (const name of ['app-memos', 'app-memos-db']) await f.propagation.writeContainerEnvironment(name, env);
  const meta = { appId: 'memos', containers: apps[0].containers };
  const stubs: Record<string, unknown> = {
    '@/lib/incus/server': { incusRequest: f.incus.incusRequest },
    '@/lib/incus/snapshot': loadSnapshot(f.incus),
    '@/lib/market/metadata': { readInstallMetadata: async () => meta, saveInstallMetadata: async () => {} },
    './container-order': containerOrder(),
    '@/lib/pointer/managed-apps': {},
    '@/lib/ui/app-status': { pushAppRuntimeStatusToUI: async () => true },
    crypto: await import('node:crypto'),
    '@/lib/market/update-admission': { withAppLifecycle: async (_appId: string, work: () => unknown) => work() },
    './app-reconciler': { appReconciler: () => ({ resetCrashLoop() {} }) },
    '@/lib/market/propagation': f.propagation,
    '@/lib/bridges/manager': { refreshConnectionGrants: async () => {} },
  };
  const lifecycle = loadSource('lib/apps/lifecycle.ts', name => stubs[name] ?? {});
  await lifecycle.controlInstalledApp('memos', 'start', 'owner');
  // app-memos already ran: its process still has the old values, so it keeps its mark.
  assert.equal(f.incus.instances.get('app-memos')!.config[PENDING], '1');
  assert.notEqual(f.incus.instances.get('app-memos-db')!.config[PENDING], '1');
  await lifecycle.controlInstalledApp('memos', 'restart', 'owner');
  assert.notEqual(f.incus.instances.get('app-memos')!.config[PENDING], '1');
  f.incus.log.length = 0;
  assert.deepEqual(await f.propagation.propagateSettingsToApps(), { appsUpdated: ['notes'], appsFailed: [], errors: [] });
  assert.ok(!f.incus.log.some(entry => entry.includes('app-memos')), 'nothing is owed to memos any more');
});

test('SMTP settings restart only apps that use them, and only when a value changed', async () => {
  const f = load();
  assert.deepEqual((await f.propagation.propagateSmtpToApps()).appsUpdated, ['memos']);
  assert.equal(f.incus.instances.get('app-memos')!.config['environment.SMTP_HOST'], 'mail.example');
  f.incus.log.length = 0;
  assert.deepEqual((await f.propagation.propagateSmtpToApps()).appsUpdated, []);
  assert.deepEqual(f.incus.log, []);
});

test('a URL change writes the platform keys before its own restart of each app', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/lib/reconfigure/index.ts'), 'utf8');
  const locked = source.slice(source.indexOf('async function updateInstalledAppLocked('), source.indexOf('// 4. Persist the new domain'));
  const write = locked.indexOf('writeContainerEnvironment(containerName, platformEnv)');
  assert.ok(write > 0 && write < locked.indexOf('restartContainerAndWait('), 'written before the restart');
  // The domain keys are written with the restart mark in one PATCH; an env file change marks too; each container's
  // restart (or, for a stopped app, its being stopped) clears it.
  assert.match(source, /config: \{ \.\.\.updates, \[ENV_RESTART_PENDING\]: '1' \} \}/);
  assert.match(locked, /await updateContainerEnvFile\(containerName, oldDomain, newDomain, identityOrigins, async \(\) => \{\s+const \{ markEnvRestartPending \}[^\n]*\n\s+await markEnvRestartPending\(containerName\);/);
  assert.match(locked, /await restartContainerAndWait\(container\.containerName, [^\n]*\n\s+await envRestartDone\(appId, container\.containerName\);/);
  assert.match(locked, /if \(await containerState\(containerName\) === 'Stopped'\) await envRestartDone\(appId, containerName\);/);
  assert.match(source, /platformEnv = await \(await import\('@\/lib\/market\/propagation'\)\)\.platformEnvironment\(\);/);
  assert.match(source, /req\.installedManifests\?\.get\(app\.appId\), platformEnv\);/);
});

test('a URL change marks a container before it rewrites its env file; a mark that fails leaves the file as it was', async () => {
  const files: Record<string, string> = { 'app-notes': 'APP_URL=https://notes.old.test\n' };
  const log: string[] = [];
  const execShell = async (container: string, command: string) => {
    if (command.startsWith('cat ')) return { exitCode: 0, stdout: files[container], stderr: '' };
    const encoded = /echo '([^']*)'/.exec(command)![1];
    files[container] = Buffer.from(encoded, 'base64').toString();
    log.push(`write:${container}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const stubs: Record<string, unknown> = {
    '@/lib/incus/server': { execShell, incusRequest: async () => ({ type: 'sync', metadata: {} }) },
    './urls': loadSource('lib/reconfigure/urls.ts', () => ({})),
  };
  const reconfigure = loadSource('lib/reconfigure/index.ts', name => stubs[name] ?? {});
  let fail = true;
  const mark = async () => {
    log.push('mark:app-notes');
    if (fail) throw new Error('Incus is not answering');
  };
  await assert.rejects(reconfigure.updateContainerEnvFile('app-notes', 'old.test', 'new.test', undefined, mark), /not answering/);
  assert.deepEqual(log, ['mark:app-notes']);
  assert.equal(files['app-notes'], 'APP_URL=https://notes.old.test\n', 'unchanged without its mark');
  fail = false; log.length = 0;
  assert.equal(await reconfigure.updateContainerEnvFile('app-notes', 'old.test', 'new.test', undefined, mark), true);
  assert.deepEqual(log, ['mark:app-notes', 'write:app-notes']);
  assert.equal(files['app-notes'], 'APP_URL=https://notes.new.test\n');
});
