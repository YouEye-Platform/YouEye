import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatformDatabase } from '../src/lib/postgres/platform-transport';

const databaseURL = process.env.YOUEYE_ADMISSION_TEST_DB_URL;
test('install-time public access: manifest default only until an administrator decides; explicit choice wins', { skip: !databaseURL }, async () => {
  const target = new URL(databaseURL!);
  const databaseName = target.pathname.slice(1);
  assert.match(databaseName, /^youeye_admission_test_[a-z0-9_]+$/);
  const database = createPlatformDatabase(async () => ({ host: target.hostname, port: target.port || '5432',
    user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), database: databaseName }));
  const key = Symbol.for('youeye.platform-postgres');
  const state = globalThis as typeof globalThis & { [key]?: typeof database };
  assert.equal(state[key], undefined);
  state[key] = database;
  const directory = await mkdtemp(join(tmpdir(), 'admission-public-'));
  const previousJournal = process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
  process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = directory;
  const schema = `admission_public_${randomUUID().replaceAll('-', '')}`;
  await database.command(`CREATE SCHEMA ${schema}; SET search_path = ${schema}, pg_catalog;`);
  const { ensureIdentitySchema, identityCommand, identityRows } = await import('../src/lib/identity/store');
  const { ensureAppAdmission, updateAdmissionPolicy, applyInstallPublicAccess, getAdmissionPolicy } =
    await import('../src/lib/admission/store');
  const owner = '10000000-0000-4000-8000-000000000001';
  const member = '10000000-0000-4000-8000-000000000002';
  try {
    await ensureIdentitySchema();
    await identityCommand(`INSERT INTO identity_users(id,username,password_hash,first_name,is_admin,groups)
      VALUES ('${owner}','owner','fixture','Owner',true,'[]'), ('${member}','member','fixture','Member',false,'[]');
      UPDATE identity_appliance_claim SET owner_user_id='${owner}' WHERE singleton;`);

    // A fresh install with a manifest default: public, audited as coming from the manifest.
    await ensureAppAdmission({ appId: 'quiz', actorId: owner, routes: [{ host: 'quiz.example.test' }] });
    assert.equal(await applyInstallPublicAccess({ appId: 'quiz', actorId: owner, explicit: false }), true);
    const quiz = (await getAdmissionPolicy('quiz'))!;
    assert.equal(quiz.publicAccess, true);
    assert.equal(quiz.mode, 'owner');
    const audit = await identityRows<{ action: string; source: string }>(`SELECT action, details->>'source' AS source
      FROM admission_audit a JOIN admission_policies p USING (installation_id) WHERE p.app_id = 'quiz' ORDER BY a.id`);
    assert.deepEqual(audit.map((row) => row.action), ['owner_only_baseline', 'public_access_at_install']);
    assert.equal(audit[1].source, 'manifest');
    // Applying again is a no-op that still reports the current state.
    assert.equal(await applyInstallPublicAccess({ appId: 'quiz', actorId: owner, explicit: false }), true);
    assert.equal((await getAdmissionPolicy('quiz'))!.revision, quiz.revision);

    // An administrator closed it once: the manifest default never reopens it; an explicit choice does.
    await ensureAppAdmission({ appId: 'game', actorId: owner, routes: [{ host: 'game.example.test' }] });
    const game = (await getAdmissionPolicy('game'))!;
    await updateAdmissionPolicy({ actorId: owner, expectedRevision: game.revision,
      policy: { ...game, mode: 'users', userIds: [member], publicAccess: false } });
    assert.equal(await applyInstallPublicAccess({ appId: 'game', actorId: owner, explicit: false }), false);
    assert.equal((await getAdmissionPolicy('game'))!.publicAccess, false);
    assert.equal(await applyInstallPublicAccess({ appId: 'game', actorId: owner, explicit: true }), true);
    const reopened = (await getAdmissionPolicy('game'))!;
    assert.equal(reopened.publicAccess, true);
    assert.deepEqual(reopened.userIds, [member], 'public access leaves the chosen users in place');

    // Only an active administrator can apply it.
    await ensureAppAdmission({ appId: 'notes', actorId: owner, routes: [{ host: 'notes.example.test' }] });
    await assert.rejects(() => applyInstallPublicAccess({ appId: 'notes', actorId: 'not-a-uuid', explicit: true }));
    assert.equal(await applyInstallPublicAccess({ appId: 'notes', actorId: member, explicit: true }), false);
    assert.equal((await getAdmissionPolicy('notes'))!.publicAccess, false);
  } finally {
    await database.command(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await database.close();
    delete state[key];
    if (previousJournal === undefined) delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
    else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = previousJournal;
    await rm(directory, { recursive: true, force: true });
  }
});
