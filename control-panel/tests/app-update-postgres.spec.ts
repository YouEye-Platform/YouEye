import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  AppUpdatePostgresError, appUpdatePostgresStagingBytes, createAppUpdatePostgresProvider,
  type AppUpdatePostgresIO, type AppUpdatePostgresRuntime, type AppUpdatePostgresScope,
  type AppUpdatePostgresSecurity, type AppUpdatePostgresStaging,
} from '../src/lib/market/update-postgres';

/**
 * Stateful boundary fake: SQL executes against database admission/identity, while
 * files and exec are separate channels. Failure injection models lost replies
 * and interrupted DROP/CREATE. It deliberately never accepts SQL in argv.
 */
function fixture(mode: 'shared' | 'own' = 'shared') {
  const scope: AppUpdatePostgresScope = {
    appId: 'fixture', engine: mode === 'shared' ? 'youeye-postgres' : 'app-fixture-db',
    mode, database: 'fixture', ownerRole: 'fixture', adminRole: 'youeye',
    adminRoles: ['youeye', 'postgres'], maxDumpBytes: 64 * 1024,
    operationId: '11111111-2222-4333-8444-555555555555',
  };
  const runtime: AppUpdatePostgresRuntime = {
    lifecycleExcluded: true, ingressBlocked: true, securityRevision: 'security-4',
    engine: { name: scope.engine, state: 'Running', ownerAppId: 'fixture' },
    credentialUses: [{ appId: 'fixture', engine: scope.engine, database: 'fixture',
      role: 'fixture', container: 'app-fixture', state: 'Stopped', clientAddresses: ['10.1.1.5'] }],
  };
  const catalog = {
    database: 'fixture', ownerRole: 'fixture', allowConnections: true, connectionLimit: -1,
    version: 170010, encoding: 'UTF8', collate: 'C.UTF-8', ctype: 'C.UTF-8',
    admin: true, unsafeOwner: false, sharedOwner: false, unsupported: false,
    foreignOwners: [] as string[], foreignWriters: [] as string[],
    superusers: ['youeye', 'postgres'],
    sessions: [] as Array<{ role: string; address: string | null; backend: string }>,
    acl: [
      { role: 'PUBLIC', privilege: 'CONNECT', grantable: false, grantor: 'fixture' },
      { role: 'PUBLIC', privilege: 'TEMPORARY', grantable: false, grantor: 'fixture' },
      { role: 'fixture', privilege: 'CONNECT', grantable: false, grantor: 'fixture' },
      { role: 'fixture', privilege: 'CREATE', grantable: false, grantor: 'fixture' },
      { role: 'fixture', privilege: 'TEMPORARY', grantable: false, grantor: 'fixture' },
    ],
  };
  const files = new Map<string, Buffer>();
  const directories = new Map<string, { uid: number; mode: string; symlink?: boolean }>();
  const fileModes = new Map<string, string>();
  const archive = Buffer.from('PGDMP-complete-custom-archive-fixture');
  const securitySql = Buffer.from('BEGIN; SET LOCAL search_path=pg_catalog;\nREVOKE ALL ON TABLE public.items FROM PUBLIC;\nGRANT SELECT ON TABLE public.items TO reader;\nCOMMIT;\n');
  const commands: string[][] = [];
  const sqlSteps: string[] = [];
  const scripts: string[] = [];
  const uploads: Array<{ path: string; mode: string }> = [];
  const events: string[] = [];
  const stagingReceipts: AppUpdatePostgresStaging[] = [];
  const state = {
    exists: true, completeArchive: true, dumped: archive, downloaded: undefined as Buffer | undefined,
    failSql: undefined as ((sql: string) => boolean) | undefined,
    failScript: undefined as ((script: string) => boolean) | undefined,
    failUpload: false, failDownload: false, failCleanup: false,
    restoreCount: 0, dropCount: 0, data: 'new data',
    credential: 'current-rotated-secret', currentSecurity: '',
    availableStagingBytes: 1024 ** 3, remoteLockHeld: false,
    disconnected: false, killOnDump: false,
    ownerLoggingSafe: true,
    ownerPreloadSafe: true,
    disconnectAfterInitMkdir: false, disconnectMarkerAfterBytes: undefined as number | undefined,
    disconnectAfterPublish: false,
    securityPrefix: '',
  };
  function executeSql(text: string): string {
    sqlSteps.push(text);
    if (state.failSql?.(text)) throw new Error('SQL secret payload must never escape');
    if (text.includes('youeye-owner-preload-check')) return state.ownerPreloadSafe ? '1' : '0';
    if (text.includes('SELECT CASE WHEN current_user=')) return state.ownerLoggingSafe ? '1' : '0';
    if (text.includes('WITH d AS')) {
      if (!state.exists || !catalog.allowConnections) throw new Error('database cannot connect');
      return JSON.stringify(catalog);
    }
    if (text.includes("SELECT json_build_object('allowConnections'")) {
      return state.exists ? JSON.stringify({
        ownerRole: catalog.ownerRole, allowConnections: catalog.allowConnections,
        connectionLimit: catalog.connectionLimit,
      }) : '';
    }
    if (text.includes('DROP DATABASE')) {
      assert.equal(catalog.allowConnections, false);
      assert.equal(catalog.connectionLimit, 0);
      state.exists = false;
      state.dropCount++;
      events.push('drop');
    }
    if (text.includes('CREATE DATABASE')) {
      assert.equal(state.exists, false);
      state.exists = true;
      catalog.allowConnections = false;
      catalog.connectionLimit = 0;
      state.data = '';
      events.push('create');
    }
    for (const match of text.matchAll(/ALLOW_CONNECTIONS (true|false)/g)) {
      catalog.allowConnections = match[1] === 'true';
    }
    for (const match of text.matchAll(/CONNECTION LIMIT (-?\d+)/g)) {
      catalog.connectionLimit = Number(match[1]);
    }
    if (text.includes('pg_terminate_backend')) catalog.sessions = [];
    if (text.includes('REVOKE CONNECT')) {
      catalog.acl = catalog.acl.filter(g => g.privilege !== 'CONNECT');
    }
    if (text.includes('REVOKE ALL ON DATABASE')) catalog.acl = [];
    for (const match of text.matchAll(/GRANT (CONNECT|CREATE|TEMPORARY) ON DATABASE "fixture" TO (PUBLIC|"[^"]+")/g)) {
      catalog.acl.push({ role: match[2].replaceAll('"', ''), privilege: match[1], grantable: false, grantor: 'fixture' });
    }
    return '';
  }
  const io: AppUpdatePostgresIO = {
    runtime: async () => structuredClone(runtime),
    persistStaging: async receipt => {
      stagingReceipts.push(receipt);
      events.push('persist-staging');
    },
    upload: async (_container, path, bytes, options) => {
      if (state.disconnected) throw new Error('CP disconnected');
      if (state.failUpload) throw new Error('upload secret');
      if (path.endsWith('/owner.json') && state.disconnectMarkerAfterBytes !== undefined) {
        files.set(path, Buffer.from(bytes.subarray(0, state.disconnectMarkerAfterBytes)));
        fileModes.set(path, options.mode.replace(/^0/, ''));
        uploads.push({ path, mode: options.mode });
        state.disconnected = true;
        throw new Error('CP disconnected during marker upload');
      }
      files.set(path, Buffer.from(bytes));
      fileModes.set(path, options.mode.replace(/^0/, ''));
      uploads.push({ path, mode: options.mode });
    },
    download: async (_container, path) => {
      if (state.disconnected) throw new Error('CP disconnected');
      if (state.failDownload) throw new Error('download secret');
      const result = files.get(path);
      assert.ok(result, `missing file ${path}`);
      return path.endsWith('owner.json') ? Buffer.from(result) : (state.downloaded ?? Buffer.from(result));
    },
    exec: async (container, args) => {
      if (state.disconnected) throw new Error('CP disconnected');
      assert.equal(container, scope.engine);
      assert.ok(!args.includes('--command') && !(args[0] !== 'stat' && args.includes('-c')), 'no SQL or shell text in argv');
      commands.push(args);
      if (args[0] === 'timeout') {
        assert.equal(args[1], '-k');
        assert.equal(args[2], '5');
        assert.match(args[3], /^\d+$/);
        args = args.slice(4);
      }
      if (args[0] === 'flock') {
        assert.equal(args[1], '-n');
        if (state.remoteLockHeld) return { exitCode: 1, stdout: '', stderr: '' };
        args = args.slice(3);
      }
      if (args[0] === 'sync') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'mkdir') {
        assert.equal(args[1], '-m0700');
        const path = args.at(-1)!;
        if (directories.has(path)) return { exitCode: 1, stdout: '', stderr: '' };
        directories.set(path, { uid: 0, mode: '700' });
        events.push('mkdir');
        if (path.includes('.init-') && state.disconnectAfterInitMkdir) {
          state.disconnected = true;
          throw new Error('CP disconnected after initializer mkdir');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'find') {
        const root = args[1];
        const entry = [...files.keys(), ...directories.keys()].find(path =>
          path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes('/')
          && path !== `${root}/owner.json`);
        return { exitCode: 0, stdout: entry ? `${entry}\n` : '', stderr: '' };
      }
      if (args[0] === 'rmdir') {
        const target = args.at(-1)!;
        if ([...files.keys(), ...directories.keys()].some(path => path.startsWith(`${target}/`))) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        directories.delete(target);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'mv') {
        const [from, to] = args.slice(-2);
        assert.ok(args.includes('-n') && args.includes('-T'));
        if (!directories.has(to) && !files.has(to)) {
          for (const [path, value] of [...directories.entries()]) if (path === from || path.startsWith(`${from}/`)) {
            directories.delete(path);
            directories.set(`${to}${path.slice(from.length)}`, value);
          }
          for (const [path, value] of [...files.entries()]) if (path.startsWith(`${from}/`)) {
            files.delete(path);
            files.set(`${to}${path.slice(from.length)}`, value);
            const mode = fileModes.get(path)!;
            fileModes.delete(path);
            fileModes.set(`${to}${path.slice(from.length)}`, mode);
          }
        }
        events.push('publish');
        if (state.disconnectAfterPublish) {
          state.disconnected = true;
          throw new Error('CP disconnected after atomic publish');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rm') {
        if (state.failCleanup) { state.failCleanup = false; throw new Error('cleanup secret'); }
        const targets = args.slice(args.indexOf('--') + 1);
        for (const target of targets) {
          for (const path of files.keys()) if (path === target || path.startsWith(`${target}/`)) {
            files.delete(path);
            fileModes.delete(path);
          }
          for (const path of directories.keys()) if (path === target || path.startsWith(`${target}/`)) directories.delete(path);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'stat') {
        assert.ok(args.includes('-c'));
        if (args.includes('-f')) {
          return { exitCode: 0, stdout: `${Math.floor(state.availableStagingBytes / 4096)}:4096`, stderr: '' };
        }
        if (args.includes('%f:%u:%a')) {
          const path = args.at(-1)!;
          const directory = directories.get(path);
          if (directory) return { exitCode: 0,
            stdout: `${directory.symlink ? 'a1ff' : '41c0'}:${directory.uid}:${directory.mode}`, stderr: '' };
          if (files.has(path)) return { exitCode: 0, stdout: `8180:0:${fileModes.get(path) ?? '600'}`, stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: String(files.get(args.at(-1)!)?.length), stderr: '' };
      }
      assert.equal(args[0], 'bash');
      const script = files.get(args[1])!.toString();
      scripts.push(script);
      if (state.failScript?.(script)) throw new Error('script secret SQL');
      let stdout = '';
      for (const line of script.split('\n')) {
        if (line.startsWith("'pg_dump'")) {
          files.set(line.match(/'--file' '([^']+)'/)![1], state.dumped);
          events.push('dump');
          if (state.killOnDump) {
            state.disconnected = true;
            state.remoteLockHeld = true;
            throw new Error('CP killed; remote command continues');
          }
        }
        if (line.startsWith("'pg_restore'")) {
          if (line.includes('--file=/dev/null') && !state.completeArchive) {
            return { exitCode: 1, stdout: '', stderr: 'truncated dump secret' };
          }
          if (line.includes("'--dbname'")) {
            assert.equal(catalog.allowConnections, true);
            assert.equal(catalog.connectionLimit, 0);
            state.restoreCount++;
            state.data = 'checkpoint data';
            events.push('restore');
          }
        }
        if (line.startsWith("'psql'")) {
          const path = line.match(/'--file' '([^']+)'/)![1];
          const text = files.get(path)!.toString();
          if (path.endsWith('/migration.sql') || path.endsWith('/owner-session.sql')) {
            assert.ok(line.includes("'--username' 'fixture'"), 'SQL must connect as owner, not impersonate from admin');
            assert.ok(!script.includes('log_statement=none'), 'nonprivileged owner cannot use superuser-only PGOPTIONS');
          }
          if (text.includes('WITH objects AS')) {
            const output = line.match(/ >'([^']+)'/)![1];
            files.set(output, Buffer.concat([Buffer.from(state.securityPrefix), securitySql]));
            events.push('capture-security');
          } else if (text === securitySql.toString()) {
            state.currentSecurity = text;
            events.push('apply-current-security');
          } else {
            const result = executeSql(text);
            if (!/\s>\/dev\/null/.test(line)) stdout = result;
          }
        }
      }
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
  const provider = createAppUpdatePostgresProvider(scope, io);
  async function fence() {
    return provider.prepareFence(async () => {
      assert.equal(catalog.allowConnections, true, 'receipt precedes mutation');
      events.push('persist-fence');
    });
  }
  async function checkpoint() {
    const f = await fence();
    const cp = await provider.dump(f);
    return { f, cp };
  }
  return { scope, runtime, catalog, files, directories, fileModes, stagingReceipts, scripts, commands,
    sqlSteps, uploads, events, state, io, provider, fence, checkpoint, securitySql };
}
function error(code: string) {
  return (e: unknown) => e instanceof AppUpdatePostgresError && e.code === code;
}

test('read-only preflight works before ingress closure with running app; fence requires stopped writers', async () => {
  const f = fixture();
  f.runtime.ingressBlocked = false;
  f.runtime.credentialUses[0].state = 'Running';
  f.catalog.sessions.push({ role: 'fixture', address: '10.1.1.5', backend: 'client backend' });
  assert.deepEqual(await f.provider.observe(), { engine: 'youeye-postgres', name: 'fixture',
    ownerAppId: 'fixture', ownerRole: 'fixture', writers: ['app-fixture'], logicalRestoreSupported: true });
  await assert.rejects(f.fence(), error('runtime-not-excluded'));
  f.runtime.ingressBlocked = true;
  await assert.rejects(f.fence(), error('writer-closure-unproven'));
  assert.equal(f.catalog.allowConnections, true);
});

test('scope rejects platform databases, maintenance roles, ambiguous engines and unsafe identifiers before exec', () => {
  const f = fixture();
  for (const database of ['postgres', 'template0', 'template1', 'youeye', 'youeye_ui', 'pointer']) {
    assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, database }, f.io), error('platform-resource-excluded'));
  }
  for (const ownerRole of ['youeye', 'postgres']) {
    assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, ownerRole }, f.io), error('platform-resource-excluded'));
  }
  assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, database: "app';DROP ROLE x" }, f.io), error('unsafe-identifier'));
  assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, mode: 'own' }, f.io), error('invalid-engine-scope'));
  assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, maxDumpBytes: Infinity }, f.io), error('invalid-dump-bound'));
  assert.equal(f.commands.length, 0);
});

test('actual role owner, membership/privilege restrictions and cluster dedication fail before fence', async () => {
  for (const field of ['ownerRole', 'unsafeOwner', 'sharedOwner', 'unsupported', 'admin'] as const) {
    const f = fixture();
    if (field === 'ownerRole') f.catalog.ownerRole = 'other';
    else f.catalog[field] = field !== 'admin';
    await assert.rejects(f.fence(), error(field === 'ownerRole' ? 'database-identity-changed' : 'dedicated-ownership-unproven'));
    assert.equal(f.catalog.allowConnections, true);
    assert.equal(f.state.dropCount, 0);
  }
});

test('foreign durable writers, foreign owners, untrusted superusers and unidentified sessions refuse', async () => {
  for (const field of ['foreignWriters', 'foreignOwners', 'superusers'] as const) {
    const f = fixture();
    f.catalog[field].push('other_app');
    await assert.rejects(f.provider.observe(), error('foreign-writer'));
  }
  for (const session of [
    { role: 'fixture', address: '10.1.1.9', backend: 'client backend' },
    { role: 'fixture', address: null, backend: 'client backend' },
    { role: 'other', address: '10.1.1.5', backend: 'client backend' },
    { role: 'fixture', address: '10.1.1.5', backend: 'background worker' },
  ]) {
    const f = fixture();
    f.catalog.sessions.push(session);
    await assert.rejects(f.provider.observe(), error('foreign-session'));
  }
});

test('all recorded credential uses must be exclusive to this database/app, including stopped consumers', async () => {
  for (const change of [{ appId: 'other' }, { database: 'other' }, { engine: 'other' }]) {
    const f = fixture();
    f.runtime.credentialUses.push({ ...f.runtime.credentialUses[0], ...change });
    await assert.rejects(f.provider.observe(), error('writer-closure-unproven'));
  }
  const f = fixture();
  f.runtime.lifecycleExcluded = false;
  await assert.rejects(f.provider.observe(), error('runtime-not-excluded'));
});

test('own engine must be owned and available; stopped engine refusal never starts it', async () => {
  const f = fixture('own');
  assert.equal((await f.provider.observe()).engine, 'app-fixture-db');
  f.runtime.engine.ownerAppId = 'other';
  await assert.rejects(f.provider.observe(), error('runtime-not-excluded'));
  f.runtime.engine.ownerAppId = 'fixture';
  f.runtime.engine.state = 'Stopped';
  await assert.rejects(f.provider.observe(), error('engine-stopped-start-after-journal'));
  assert.ok(f.commands.every(c => c[0] !== 'incus'));
});

test('persisted fence disables future connections and engine stays available; dump uses admin-only window', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  assert.equal(receipt.originalAllowConnections, true);
  assert.equal(receipt.originalConnectionLimit, -1);
  assert.ok(f.events.indexOf('persist-fence') < f.events.indexOf('dump'));
  assert.ok(f.events.indexOf('persist-staging') < f.events.indexOf('mkdir'));
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.catalog.connectionLimit, 0);
  assert.equal(f.runtime.engine.state, 'Running');
  assert.equal(cp.sha256, createHash('sha256').update(cp.bytes).digest('hex'));
  assert.equal(cp.byteSize, cp.bytes.length);
  assert.equal(f.files.size, 1, 'only the operation ownership marker remains');
  assert.ok(f.uploads.every(u => u.mode === '0600' || u.mode === '0700'));
  const dumpScript = f.scripts.find(s => s.includes("'pg_dump'"))!;
  assert.match(dumpScript, /ulimit -f 64/);
  assert.match(dumpScript, /pg_restore.*--file=\/dev\/null/);
  assert.match(dumpScript, /pg_dump.*>\/dev\/null 2>\/dev\/null/);
  assert.ok(f.commands.every(c => !c.join(' ').includes('PGDMP') && !c.join(' ').includes('PASSWORD')));
  await f.provider.verify('closed', receipt);
  assert.equal(f.catalog.allowConnections, false);
});

test('failed receipt persistence leaves the database untouched', async () => {
  const f = fixture();
  await assert.rejects(f.provider.prepareFence(async () => { throw new Error('disk full'); }), error('fence-persistence-failed'));
  assert.equal(f.catalog.allowConnections, true);
  assert.equal(f.catalog.connectionLimit, -1);
});

test('dump failure, truncation, oversize and transfer mismatch always reestablish hard fence', async () => {
  for (const failure of ['exec', 'truncated', 'oversize', 'mismatch', 'download'] as const) {
    const f = fixture();
    const receipt = await f.fence();
    if (failure === 'exec') f.state.failScript = s => s.includes("'pg_dump'");
    if (failure === 'truncated') f.state.completeArchive = false;
    if (failure === 'oversize') f.state.dumped = Buffer.alloc(f.scope.maxDumpBytes + 1);
    if (failure === 'mismatch') f.state.downloaded = Buffer.from('PGDMP-short');
    if (failure === 'download') f.state.failDownload = true;
    await assert.rejects(f.provider.dump(receipt), (e: unknown) =>
      e instanceof AppUpdatePostgresError && !e.message.includes('secret'));
    assert.equal(f.catalog.allowConnections, false, failure);
    assert.equal(f.catalog.connectionLimit, 0, failure);
    assert.equal(f.files.size, 1);
  }
});

test('apply admits only the app and trusted admins; original fence restores admission state', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  assert.equal(f.catalog.allowConnections, true);
  assert.deepEqual(f.catalog.acl.filter(g => g.privilege === 'CONNECT').map(g => g.role), ['fixture']);
  await f.provider.verify('apply', receipt);
  f.catalog.acl.push({ role: 'reader', privilege: 'CONNECT', grantable: false, grantor: 'fixture' });
  await assert.rejects(f.provider.verify('apply', receipt), error('foreign-connection-grant'));
  await f.provider.unfence(receipt, 'original');
  assert.equal(f.catalog.allowConnections, true);
  assert.deepEqual(f.catalog.acl.filter(g => g.privilege === 'CONNECT').map(g => g.role), ['PUBLIC', 'fixture']);
  await f.provider.verify('original', receipt);
});

test('an existing hard fence is never overwritten by a second prepare receipt', async () => {
  const f = fixture();
  await f.fence();
  let persisted = false;
  await assert.rejects(f.provider.preflightFence(async () => { persisted = true; }),
    error('database-closed-reconcile-existing-fence'));
  assert.equal(persisted, false);
  assert.equal(f.catalog.allowConnections, false);
});

test('unfence failure returns to hard fence and changed security generation cannot regrant old permissions', async () => {
  const f = fixture();
  const receipt = await f.fence();
  f.state.failSql = s => s.includes('GRANT CONNECT');
  await assert.rejects(f.provider.unfence(receipt, 'apply'), error('unfence-failed'));
  assert.equal(f.catalog.allowConnections, false);
  f.state.failSql = undefined;
  f.runtime.securityRevision = 'revoked-5';
  await assert.rejects(f.provider.unfence(receipt, 'original'), error('fence-identity-or-security-changed'));
  assert.equal(f.catalog.allowConnections, false);
});

test('logical rollback persists CURRENT grants before drop and preserves current credentials and role identities', async () => {
  for (const mode of ['shared', 'own'] as const) {
    const f = fixture(mode);
    const { f: receipt, cp } = await f.checkpoint();
    f.catalog.acl.push({ role: 'reader', privilege: 'TEMPORARY', grantable: false, grantor: 'fixture' });
    let retained: AppUpdatePostgresSecurity | undefined;
    await f.provider.restore(receipt, cp, {
      persistSecurity: async s => { retained = s; f.events.push('persist-security'); },
    });
    assert.ok(retained);
    assert.ok(f.events.indexOf('persist-security') < f.events.indexOf('drop'));
    assert.equal(f.state.data, 'checkpoint data');
    assert.equal(f.state.credential, 'current-rotated-secret');
    assert.equal(f.state.currentSecurity, f.securitySql.toString());
    assert.ok(f.catalog.acl.some(g => g.role === 'reader'));
    assert.equal(f.state.restoreCount, 1);
    assert.equal(f.catalog.allowConnections, false);
    assert.ok(!f.sqlSteps.some(s => /\b(?:DROP|ALTER|CREATE) ROLE\b/.test(s)));
    assert.ok(f.scripts.some(s => s.includes("'--single-transaction'") && s.includes("'--no-privileges'") && s.includes("'--role' 'fixture'")));
    assert.ok(!f.commands.some(c => /pg_basebackup|\/var\/lib\/postgresql|snapshot/.test(c.join(' '))));
  }
});

test('failed current-security persistence and corrupt checkpoint never drop the database', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  await assert.rejects(f.provider.restore(receipt, cp, {
    persistSecurity: async () => { throw new Error('encrypted workspace full'); },
  }), error('security-persistence-failed'));
  assert.equal(f.state.dropCount, 0);
  assert.equal(f.catalog.allowConnections, false);
  const corrupt = { ...cp, bytes: Buffer.from('PGDMP-corrupt') };
  await assert.rejects(f.provider.restore(receipt, corrupt, { persistSecurity: async () => undefined }), error('checkpoint-invalid'));
  assert.equal(f.state.dropCount, 0);
});

test('current security capture suppresses psql command tags and reconciles exact earlier receipt prefix', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  f.state.securityPrefix = 'SET\n';
  let retained: AppUpdatePostgresSecurity | undefined;
  await f.provider.restore(receipt, cp, { persistSecurity: async s => { retained = s; } });
  assert.ok(retained);
  const original = Buffer.from(retained.bytes);
  assert.ok(original.toString().startsWith('SET\nBEGIN; SET LOCAL search_path=pg_catalog;\n'));
  assert.equal(f.state.currentSecurity, f.securitySql.toString());
  await f.provider.restore(receipt, cp, { security: retained, persistSecurity: async () => assert.fail('must reuse receipt') });
  assert.deepEqual(retained.bytes, original);
  assert.equal(f.state.currentSecurity, f.securitySql.toString());
  assert.ok(f.scripts.some(s => s.includes("'--quiet'")));
});

test('unknown command-tag prefixes are refused before dropping the database', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  let retained: AppUpdatePostgresSecurity | undefined;
  await f.provider.restore(receipt, cp, { persistSecurity: async s => { retained = s; } });
  const bytes = Buffer.from('SET\nSELECT 1;');
  const drops = f.state.dropCount;
  await assert.rejects(f.provider.restore(receipt, cp, {
    security: { ...retained!, bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
    persistSecurity: async () => undefined,
  }), error('security-checkpoint-invalid'));
  assert.equal(f.state.dropCount, drops);
});

test('rollback accepts the open apply state after writers stop and establishes its own fence', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  await f.provider.unfence(receipt, 'apply');
  assert.equal(f.catalog.allowConnections, true);
  await f.provider.restore(receipt, cp, { persistSecurity: async () => undefined });
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.catalog.connectionLimit, 0);
  assert.equal(f.state.data, 'checkpoint data');
});

test('full archive validation precedes destructive replacement; backward logical restore refuses', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  f.state.completeArchive = false;
  await assert.rejects(f.provider.restore(receipt, cp, { persistSecurity: async () => undefined }), error('execution-failed'));
  assert.equal(f.state.dropCount, 0);
  f.state.completeArchive = true;
  f.catalog.version = 160010;
  await assert.rejects(f.provider.restore(receipt, cp, { persistSecurity: async () => undefined }), error('logical-downgrade-unsupported'));
  assert.equal(f.state.dropCount, 0);
});

test('interrupted DROP/CREATE retries with retained current security, without recapturing a partial database', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  let retained: AppUpdatePostgresSecurity | undefined;
  f.state.failSql = s => s.includes('CREATE DATABASE');
  await assert.rejects(f.provider.restore(receipt, cp, {
    persistSecurity: async s => { retained = s; },
  }), error('execution-failed'));
  assert.equal(f.state.exists, false);
  assert.ok(retained);
  f.state.failSql = undefined;
  await f.provider.restore(receipt, cp, {
    security: retained,
    persistSecurity: async () => { assert.fail('must not replace retained security'); },
  });
  assert.equal(f.state.data, 'checkpoint data');
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.state.currentSecurity, f.securitySql.toString());
});

test('failure during logical restore leaves database fenced and current-security checkpoint reusable', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  let retained: AppUpdatePostgresSecurity | undefined;
  f.state.failScript = s => s.includes("'pg_restore'") && s.includes("'--single-transaction'");
  await assert.rejects(f.provider.restore(receipt, cp, {
    persistSecurity: async s => { retained = s; },
  }), error('execution-failed'));
  assert.equal(f.catalog.allowConnections, false);
  assert.ok(retained);
  f.state.failScript = undefined;
  await f.provider.restore(receipt, cp, { security: retained, persistSecurity: async () => assert.fail() });
  assert.equal(f.state.data, 'checkpoint data');
});

test('wrong scope/fence and tampered retained-security snapshot fail before effects', async () => {
  const f = fixture();
  const { f: receipt, cp } = await f.checkpoint();
  await assert.rejects(f.provider.dump({ ...receipt, database: 'other' }), error('fence-identity-or-security-changed'));
  await assert.rejects(f.provider.restore(receipt, { ...cp, engine: 'other' }, {
    persistSecurity: async () => undefined,
  }), error('checkpoint-invalid'));
  const retained: AppUpdatePostgresSecurity = {
    schema: 'youeye.app-postgres-security.v1', engine: f.scope.engine, database: 'fixture', ownerRole: 'fixture',
    securityRevision: 'security-4', encoding: 'UTF8', collate: 'C.UTF-8', ctype: 'C.UTF-8',
    version: 170010, acl: [], bytes: f.securitySql, sha256: 'tampered',
  };
  await assert.rejects(f.provider.restore(receipt, cp, { security: retained, persistSecurity: async () => undefined }),
    error('security-checkpoint-invalid'));
  assert.equal(f.state.dropCount, 0);
});

test('cleanup failure is explicit rather than a falsely successful dump', async () => {
  const f = fixture();
  const receipt = await f.fence();
  // Fail only cleanup of the archive workspace, leaving SQL/fence cleanup usable.
  f.state.failScript = s => {
    if (s.includes("'pg_dump'")) {
      f.state.failCleanup = true;
      return false;
    }
    f.state.failCleanup = false;
    return false;
  };
  await assert.rejects(f.provider.dump(receipt), error('execution-failed'));
  assert.equal(f.catalog.allowConnections, false);
});

test('refence closes a failed verification apply state and kills lingering clients without replaying grants', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  f.catalog.sessions.push({ role: 'fixture', address: '10.1.1.5', backend: 'client backend' });
  const currentAcl = structuredClone(f.catalog.acl);
  const before = f.sqlSteps.length;
  await f.provider.refence(receipt);
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.catalog.connectionLimit, 0);
  assert.deepEqual(f.catalog.sessions, []);
  assert.deepEqual(f.catalog.acl, currentAcl);
  assert.ok(!f.sqlSteps.slice(before).some(s => /\b(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|DROP ROLE)\b/.test(s)));
});

test('newer security blocks recovery but refence still closes the exact database and keeps current ACLs', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  f.runtime.securityRevision = 'security-revoked-5';
  // Old owner credentials may no longer have a recorded use.
  f.runtime.credentialUses[0].role = 'rotated_owner';
  const currentAcl = structuredClone(f.catalog.acl);
  await assert.rejects(f.provider.refence(receipt), error('fence-identity-or-security-changed'));
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.catalog.connectionLimit, 0);
  assert.deepEqual(f.catalog.acl, currentAcl);
  assert.equal(f.state.credential, 'current-rotated-secret');
});

test('refence refuses a foreign target identity and requires stopped app writers with a running engine', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  await assert.rejects(f.provider.refence({ ...receipt, database: 'other' }), error('fence-identity-or-security-changed'));
  assert.equal(f.catalog.allowConnections, true);
  f.catalog.ownerRole = 'foreign_owner';
  await assert.rejects(f.provider.refence(receipt), error('database-identity-changed'));
  assert.equal(f.catalog.allowConnections, true);
  f.catalog.ownerRole = 'fixture';
  f.runtime.credentialUses[0].state = 'Running';
  await assert.rejects(f.provider.refence(receipt), error('writers-not-stopped'));
  f.runtime.credentialUses[0].state = 'Stopped';
  f.runtime.engine.state = 'Stopped';
  await assert.rejects(f.provider.refence(receipt), error('engine-stopped-start-after-journal'));
});

test('newly discovered foreign credential use blocks recovery after emergency containment', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  f.runtime.credentialUses.push({ ...f.runtime.credentialUses[0], appId: 'foreign',
    container: 'app-foreign', state: 'Running' });
  await assert.rejects(f.provider.refence(receipt), error('writer-closure-unproven'));
  assert.equal(f.catalog.allowConnections, false);
  assert.equal(f.catalog.connectionLimit, 0);
});

test('transaction staging requires a journal UUID and durable receipt; read-only observation needs neither', async () => {
  const f = fixture();
  assert.throws(() => createAppUpdatePostgresProvider({ ...f.scope, operationId: '../../foreign' }, f.io),
    error('invalid-operation-id'));
  const observe = createAppUpdatePostgresProvider({ ...f.scope, operationId: undefined },
    { ...f.io, persistStaging: undefined });
  assert.equal((await observe.observations()).name, 'fixture');
  await assert.rejects(observe.preflightFence(async () => undefined), error('operation-staging-receipt-required'));
  await assert.rejects(observe.cleanupStaging(), error('operation-staging-receipt-required'));
  const noPersist = createAppUpdatePostgresProvider(f.scope, { ...f.io, persistStaging: undefined });
  await assert.rejects(noPersist.preflightFence(async () => undefined), error('operation-staging-receipt-required'));
});

test('staging reservation reports engine /tmp capacity and refuses insufficient space before mkdir or database mutation', async () => {
  const f = fixture();
  const capacity = await f.provider.stagingCapacity();
  assert.equal(capacity.root, '/tmp');
  assert.equal(capacity.engine, 'youeye-postgres');
  assert.equal(capacity.reservedBytes, appUpdatePostgresStagingBytes(f.scope.maxDumpBytes));
  assert.equal(appUpdatePostgresStagingBytes(64 * 1024 * 1024), 128 * 1024 * 1024 + 128 * 1024);
  f.state.availableStagingBytes = capacity.reservedBytes - 4096;
  await assert.rejects(f.provider.observe(), error('insufficient-staging-capacity'));
  assert.equal(f.directories.size, 0);
  assert.equal(f.catalog.allowConnections, true);
  const failedPersist = createAppUpdatePostgresProvider(f.scope, {
    ...f.io, persistStaging: async () => { throw new Error('journal unavailable'); },
  });
  await assert.rejects(failedPersist.observe(), error('staging-persistence-failed'));
  assert.equal(f.directories.size, 0);
});

test('CP kill retains only one operation directory; restart blocks an active orphan then removes stale payloads exactly', async () => {
  const f = fixture();
  const receipt = await f.fence();
  const root = f.stagingReceipts[0].directory;
  f.state.killOnDump = true;
  await assert.rejects(f.provider.dump(receipt), error('execution-failed'));
  assert.ok([...f.files.keys()].some(p => p.endsWith('checkpoint.dump')));
  assert.equal(f.directories.get(root)?.mode, '700');
  f.state.disconnected = false;
  const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
  const before = [...f.files.keys()];
  await assert.rejects(resumed.refence(receipt), error('execution-failed'));
  assert.deepEqual([...f.files.keys()], before, 'active remote command must not lose files');
  assert.ok(f.commands.some(c => c[0] === 'timeout' && c[1] === '-k' && c[2] === '5'),
    'remote work has its own deadline after CP polling disappears');
  // Simulate the remote timeout killing the old process group.
  f.state.remoteLockHeld = false;
  f.state.killOnDump = false;
  await resumed.refence(receipt);
  assert.equal(f.catalog.allowConnections, false);
  assert.ok(![...f.files.keys()].some(p => p.endsWith('checkpoint.dump')));
  const otherRoot = '/tmp/youeye-app-pg-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  f.directories.set(otherRoot, { uid: 0, mode: '700' });
  f.files.set(`${otherRoot}/foreign.dump`, Buffer.from('do not touch'));
  await resumed.cleanupStaging();
  assert.ok(!f.directories.has(root));
  assert.ok(f.files.has(`${otherRoot}/foreign.dump`));
  await resumed.cleanupStaging(); // absent directory is an idempotent success
  assert.equal(new Set(f.stagingReceipts.map(r => r.directory)).size, 1);
});

test('staging cleanup validates full scope marker, root ownership, mode, and symlink status before deletion', async () => {
  for (const failure of ['marker', 'owner', 'mode', 'symlink'] as const) {
    const f = fixture();
    await f.fence();
    const root = f.stagingReceipts[0].directory;
    if (failure === 'marker') {
      const marker = JSON.parse(f.files.get(`${root}/owner.json`)!.toString());
      marker.ownerRole = 'foreign';
      f.files.set(`${root}/owner.json`, Buffer.from(JSON.stringify(marker)));
    }
    if (failure === 'owner') f.directories.get(root)!.uid = 1000;
    if (failure === 'mode') f.directories.get(root)!.mode = '755';
    if (failure === 'symlink') f.directories.get(root)!.symlink = true;
    await assert.rejects(f.provider.cleanupStaging(), error('staging-ownership-unproven'));
    assert.ok(f.directories.has(root), failure);
  }
});

test('repeated retries reuse fixed work slots and do not accumulate plaintext archives', async () => {
  const f = fixture();
  const receipt = await f.fence();
  const root = f.stagingReceipts[0].directory;
  f.state.completeArchive = false;
  for (let retry = 0; retry < 4; retry++) {
    const provider = createAppUpdatePostgresProvider(f.scope, f.io);
    await assert.rejects(provider.dump(receipt), error('execution-failed'));
    assert.equal(f.files.size, 1);
    assert.deepEqual([...f.directories.keys()], [root]);
  }
  await f.provider.cleanupStaging();
  assert.equal(f.files.size, 0);
});

test('executeSQL uses bounded operation staging and a direct owner connection with suppressed diagnostics', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  const migration = "INSERT INTO public.items VALUES ('private-payload');";
  await f.provider.executeSQL(receipt, Buffer.from(migration));
  assert.ok(f.sqlSteps.includes(migration));
  assert.equal(f.files.size, 1, 'migration plaintext removed, operation marker retained');
  assert.ok(f.scripts.some(s => /migration\.sql' >\/dev\/null 2>\/dev\/null/.test(s)));
  assert.ok(f.commands.every(c => !c.join(' ').includes('private-payload')));
  assert.ok(!f.sqlSteps.some(s => /^SET ROLE/.test(s) && s.includes(migration)));
  assert.equal(f.catalog.allowConnections, true);
  assert.equal(f.state.credential, 'current-rotated-secret');
});

test('executeSQL refuses non-apply admission, oversized input and psql metacommands before sending payload', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await assert.rejects(f.provider.executeSQL(receipt, 'SELECT 1;'), error('sql-requires-apply-phase'));
  await f.provider.unfence(receipt, 'apply');
  const before = f.sqlSteps.length;
  for (const input of ['', Buffer.alloc(f.scope.maxDumpBytes + 1), Buffer.from([0]),
    Buffer.from([0xff])]) {
    await assert.rejects(f.provider.executeSQL(receipt, input), error('sql-payload-invalid'));
  }
  await assert.rejects(f.provider.executeSQL(receipt, '\\! print-private-data'), error('sql-metacommands-unsupported'));
  assert.equal(f.sqlSteps.length, before);
  f.catalog.acl.push({ role: 'PUBLIC', privilege: 'CONNECT', grantable: false, grantor: 'fixture' });
  await assert.rejects(f.provider.executeSQL(receipt, 'SELECT 1;'), error('sql-requires-exclusive-admission'));
  assert.ok(!f.sqlSteps.includes('SELECT 1;'));
});

test('executeSQL refuses unsafe server logging without uploading the migration or changing role policy', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  f.state.ownerLoggingSafe = false;
  const before = f.uploads.length;
  await assert.rejects(f.provider.executeSQL(receipt, 'SELECT secret_payload();'), error('sql-owner-session-logging-unsafe'));
  assert.ok(!f.uploads.slice(before).some(u => u.path.endsWith('/migration.sql')));
  assert.ok(!f.sqlSteps.includes('SELECT secret_payload();'));
  assert.equal(f.files.size, 1);
});

test('executeSQL inspects restricted preload settings through maintenance without granting owner privileges', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  await f.provider.executeSQL(receipt, 'SELECT 1;');
  const privileged = f.sqlSteps.find(s => s.includes('youeye-owner-preload-check'))!;
  assert.match(privileged, /pg_db_role_setting/);
  assert.match(privileged, /has_parameter_privilege/);
  const owner = f.sqlSteps.find(s => s.includes('SELECT CASE WHEN current_user='))!;
  assert.ok(!owner.includes("current_setting('session_preload_libraries')"));
  assert.ok(!owner.includes("current_setting('shared_preload_libraries')"));
  assert.match(owner, /local_preload_libraries/);
  assert.ok(!f.sqlSteps.some(s => /GRANT.*pg_read_all_settings|GRANT.*ON PARAMETER|ALTER ROLE/.test(s)));
});

test('executeSQL refuses unsafe owner startup preload settings before uploading SQL payload', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  f.state.ownerPreloadSafe = false;
  const before = f.uploads.length;
  await assert.rejects(f.provider.executeSQL(receipt, 'SELECT secret_payload();'), error('sql-owner-session-logging-unsafe'));
  assert.ok(!f.uploads.slice(before).some(u => u.path.endsWith('/migration.sql')));
  assert.ok(!f.sqlSteps.includes('SELECT secret_payload();'));
});

test('executeSQL failure reports only a safe code and leaves staging recoverable', async () => {
  const f = fixture();
  const receipt = await f.fence();
  await f.provider.unfence(receipt, 'apply');
  const migration = 'SELECT rejected_migration();';
  f.state.failSql = s => s === migration;
  await assert.rejects(f.provider.executeSQL(receipt, migration), error('execution-failed'));
  assert.equal(f.files.size, 1);
  f.state.failSql = undefined;
  await f.provider.refence(receipt);
  assert.equal(f.catalog.allowConnections, false);
  await f.provider.cleanupStaging();
  assert.equal(f.files.size, 0);
});

test('disconnection after initializer mkdir leaves no unmarked final root and retries remain bounded', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 4; attempt++) {
    f.state.disconnectAfterInitMkdir = true;
    const interrupted = createAppUpdatePostgresProvider(f.scope, f.io);
    await assert.rejects(interrupted.preflightFence(async () => undefined), error('execution-failed'));
    const receipt = f.stagingReceipts[0];
    assert.ok(receipt.initializationDirectory);
    assert.ok(!f.directories.has(receipt.directory), 'final directory must not exist without its complete marker');
    assert.deepEqual([...f.directories.keys()], [receipt.initializationDirectory]);
    assert.equal(f.files.size, 0);
    assert.equal(f.sqlSteps.length, 0, 'no PG effect before atomic marker publication');
    assert.ok(f.events.indexOf('persist-staging') < f.events.indexOf('mkdir'));
    f.state.disconnected = false;
  }
  f.state.disconnectAfterInitMkdir = false;
  const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
  const fence = await resumed.preflightFence(async () => undefined);
  assert.equal(f.catalog.allowConnections, false);
  assert.deepEqual([...f.directories.keys()], [f.stagingReceipts[0].directory]);
  assert.equal(new Set(f.stagingReceipts.map(r => r.initializationDirectory)).size, 1);
  await resumed.verify('closed', fence);
  await resumed.cleanupStaging();
  assert.equal(f.directories.size, 0);
  assert.ok(!f.commands.some(c => c.includes('rm') && c.includes('-rf')
    && c.includes(f.stagingReceipts[0].initializationDirectory)), 'initializer removal must not be recursive');
});

test('partial and fully uploaded markers with lost acknowledgements recover only from the exact initializer', async () => {
  for (const uploadedBytes of [0, 27, 1_000_000]) {
    const f = fixture();
    f.state.disconnectMarkerAfterBytes = uploadedBytes;
    await assert.rejects(f.fence(), error('staging-marker-write-failed'));
    const receipt = f.stagingReceipts[0];
    assert.ok(!f.directories.has(receipt.directory));
    assert.deepEqual([...f.directories.keys()], [receipt.initializationDirectory]);
    assert.equal(f.files.size, 1);
    assert.equal(f.sqlSteps.length, 0);
    assert.equal(f.catalog.allowConnections, true);
    const foreignInit = `${receipt.directory}.init-${'a'.repeat(64)}`;
    f.directories.set(foreignInit, { uid: 0, mode: '700' });
    f.files.set(`${foreignInit}/foreign.dump`, Buffer.from('foreign recovery data'));
    f.state.disconnected = false;
    f.state.disconnectMarkerAfterBytes = undefined;
    const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
    await resumed.preflightFence(async () => undefined);
    assert.ok(!f.directories.has(receipt.initializationDirectory));
    assert.ok(f.directories.has(receipt.directory));
    assert.ok(f.files.has(`${foreignInit}/foreign.dump`));
    await resumed.cleanupStaging();
    assert.deepEqual([...f.directories.keys()], [foreignInit]);
    assert.deepEqual([...f.files.keys()], [`${foreignInit}/foreign.dump`]);
  }
});

test('cleanup reconciles empty or partial initializer without creating a final staging directory', async () => {
  for (const partialMarker of [false, true]) {
    const f = fixture();
    if (partialMarker) f.state.disconnectMarkerAfterBytes = 21;
    else f.state.disconnectAfterInitMkdir = true;
    await assert.rejects(f.fence(), error(partialMarker ? 'staging-marker-write-failed' : 'execution-failed'));
    f.state.disconnected = false;
    const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
    await resumed.cleanupStaging();
    assert.equal(f.directories.size, 0);
    assert.equal(f.files.size, 0);
    assert.equal(f.sqlSteps.length, 0);
    assert.equal(f.catalog.allowConnections, true);
    await resumed.cleanupStaging();
  }
});

test('lost atomic-publish acknowledgement leaves a complete final marker and restart resumes safely', async () => {
  const f = fixture();
  f.state.disconnectAfterPublish = true;
  await assert.rejects(f.fence(), error('execution-failed'));
  const receipt = f.stagingReceipts[0];
  assert.deepEqual([...f.directories.keys()], [receipt.directory]);
  assert.deepEqual(JSON.parse(f.files.get(`${receipt.directory}/owner.json`)!.toString()), receipt);
  assert.equal(f.sqlSteps.length, 0);
  f.state.disconnected = false;
  f.state.disconnectAfterPublish = false;
  const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
  await resumed.preflightFence(async () => undefined);
  assert.equal(f.catalog.allowConnections, false);
  await resumed.cleanupStaging();
  assert.equal(f.directories.size, 0);
});

test('initializer reconciliation rejects unknown entries, foreign marker bytes and unsafe ownership without deletion', async () => {
  for (const failure of ['entry', 'marker', 'owner', 'mode', 'symlink', 'marker-mode'] as const) {
    const f = fixture();
    f.state.disconnectMarkerAfterBytes = 20;
    await assert.rejects(f.fence(), error('staging-marker-write-failed'));
    const initializer = f.stagingReceipts[0].initializationDirectory;
    f.state.disconnected = false;
    if (failure === 'entry') f.files.set(`${initializer}/foreign.dump`, Buffer.from('foreign'));
    if (failure === 'marker') f.files.set(`${initializer}/owner.json`, Buffer.from('foreign scope'));
    if (failure === 'owner') f.directories.get(initializer)!.uid = 1000;
    if (failure === 'mode') f.directories.get(initializer)!.mode = '755';
    if (failure === 'symlink') f.directories.get(initializer)!.symlink = true;
    if (failure === 'marker-mode') f.fileModes.set(`${initializer}/owner.json`, '644');
    const files = [...f.files.entries()].map(([path, bytes]) => [path, bytes.toString()]);
    const resumed = createAppUpdatePostgresProvider(f.scope, f.io);
    await assert.rejects(resumed.cleanupStaging(), error('staging-initialization-unproven'));
    assert.deepEqual([...f.files.entries()].map(([path, bytes]) => [path, bytes.toString()]), files);
    assert.ok(f.directories.has(initializer));
    await assert.rejects(resumed.observe(), error('staging-initialization-unproven'));
  }
});

test('arbitrary unmarked final directories are never accepted or reclaimed as interrupted initialization', async () => {
  const f = fixture();
  const { directory, initializationDirectory } = await f.provider.stagingCapacity();
  f.directories.set(directory, { uid: 0, mode: '700' });
  f.files.set(`${directory}/foreign.dump`, Buffer.from('foreign data'));
  await assert.rejects(f.provider.observe(), error('staging-ownership-unproven'));
  await assert.rejects(f.provider.cleanupStaging(), error('staging-ownership-unproven'));
  assert.deepEqual([...f.directories.keys()], [directory]);
  assert.ok(f.files.has(`${directory}/foreign.dump`));
  assert.ok(!f.directories.has(initializationDirectory));
  assert.ok(!f.commands.some(c => c.includes('rm') || c.includes('rmdir')));
});
