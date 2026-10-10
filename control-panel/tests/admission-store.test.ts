import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureIdentitySchema, identityCommand, ensureClient, createIdentitySession,
  issueRefreshToken, rotateRefreshToken, enqueueLogoutDelivery, identityRows,
  deleteIdentityUser, createIdentityUser, refreshIdentitySchemaAfterRestore,
  createAuthCode, consumeAuthCode } from '../src/lib/identity/store';
import { ensureAppAdmission, evaluateAppAdmission, getAdmissionSnapshot,
  updateAdmissionPolicy, saveResourceOwnership, evaluateClientAdmission, getAdmissionResourceOwners,
  reserveAppUserData, setAdmissionAppEnabled } from '../src/lib/admission/store';
import { verifyRetainedAuthority } from '../src/lib/admission/retained-data';
import type { InstallMetadata } from '../src/lib/market/types';
import { quarantineAdmissionData } from '../src/lib/admission/management';
import { exportAppAdmission, validateAppAdmissionRestore } from '../src/lib/admission/backup';
import { hasOtherShareConsumers } from '../src/lib/market/storage';

const sshTarget = process.env.YOUEYE_ADMISSION_TEST_SSH_TARGET;
test('actual store SQL preserves grants, enforces administration and restores immutable ownership', { skip: !sshTarget }, async () => {
  // The real store runs through its Incus transport against an isolated schema.
  // The fake transport parses authored shell quoting; it never executes that
  // shell or touches the appliance's live identity schema.
  const schema = `admission_test_${randomUUID().replaceAll('-', '')}`;
  const remoteSql = (sql: string) => spawnSync('ssh', [sshTarget!, 'incus', 'exec', 'youeye-postgres', '--',
    'psql', '-U', 'youeye', '-d', 'youeye', '-v', 'ON_ERROR_STOP=1', '-q', '-tA'], {
    input: sql, encoding: 'utf8', timeout: 30_000,
  });
  const created = remoteSql(`CREATE SCHEMA ${schema};`);
  assert.equal(created.status, 0, created.stderr);
  const directory = await mkdtemp(join(tmpdir(), 'admission-store-'));
  const socket = join(directory, 'incus.sock');
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const command = JSON.parse(Buffer.concat(chunks).toString()).command;
    const parsed = spawnSync('python3', ['-c',
      'import shlex,sys; outer=shlex.split(sys.argv[1]); inner=shlex.split(outer[-1].replace(chr(92)+"$", "$")); assert outer[:4]==["su","-","postgres","-c"]; assert inner[0]=="psql"; print(inner[-1])',
      command[2]], { encoding: 'utf8' });
    const result = parsed.status === 0 ? remoteSql(`SET search_path = ${schema}, pg_catalog;\n${parsed.stdout}`) : parsed;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ type: 'sync', metadata: { metadata: {
      return: result.status ?? 1, output: { '1': result.stdout, '2': result.stderr },
    } } }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const previousSocket = process.env.INCUS_SOCKET;
  const previousHttps = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  const owner = '10000000-0000-4000-8000-000000000001';
  const household = '10000000-0000-4000-8000-000000000002';
  const denied = '10000000-0000-4000-8000-000000000003';
  const uiId = '20000000-0000-4000-8000-000000000001';
  try {
    const legacy = remoteSql(`SET search_path = ${schema}, pg_catalog;
      CREATE TABLE identity_logout_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, client_id text NOT NULL,
        uri text NOT NULL, logout_token text NOT NULL, attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX identity_logout_session_client_idx ON identity_logout_deliveries(session_id,client_id)
        WHERE session_id IS NOT NULL;
      INSERT INTO identity_logout_deliveries(session_id,client_id,uri,logout_token,delivered_at)
        VALUES ('40000000-0000-4000-8000-000000000001','client-a','https://a.example.test/logout','legacy',now());`);
    assert.equal(legacy.status, 0, legacy.stderr);
    await ensureIdentitySchema();
    const logout = { sessionId: '40000000-0000-4000-8000-000000000001', clientId: 'client-a',
      uri: 'https://a.example.test/logout', token: 'fixture' };
    await enqueueLogoutDelivery(logout);
    for (const eventKey of ['admission:revision2', 'admission:revision3']) {
      await enqueueLogoutDelivery({ ...logout, eventKey });
      await enqueueLogoutDelivery({ ...logout, eventKey });
    }
    const deliveries = await identityRows<{ event_key: string; delivered: boolean }>(`
      SELECT event_key, delivered_at IS NOT NULL AS delivered FROM identity_logout_deliveries ORDER BY event_key`);
    assert.equal(deliveries.length, 3, 'retries deduplicate events, not every future revocation of a session');
    assert.equal(deliveries.filter(d => !d.delivered).length, 2, 'old delivered event cannot suppress new revocations');
    assert.ok(deliveries.some(d => d.event_key === `session:${logout.sessionId}:${logout.clientId}` && d.delivered),
      'migration retains historical delivery and normal logout deduplication');
    // Simulate a historical database replacing a newer one while the same
    // CP process retains its schema-ready cache.
    await identityCommand(`DELETE FROM identity_logout_deliveries WHERE event_key LIKE 'admission:%';
      DROP INDEX identity_logout_event_idx;
      ALTER TABLE identity_logout_deliveries DROP COLUMN event_key;
      CREATE UNIQUE INDEX identity_logout_session_client_idx ON identity_logout_deliveries(session_id,client_id)
        WHERE session_id IS NOT NULL;`);
    await refreshIdentitySchemaAfterRestore();
    assert.equal((await identityRows(`SELECT event_key FROM identity_logout_deliveries`)).length, 1);
    await enqueueLogoutDelivery({ ...logout, eventKey: 'admission:after-restore' });
    assert.equal((await identityRows(`SELECT event_key FROM identity_logout_deliveries`)).length, 2,
      'historical restore reapplies current migrations before admitting runtime consumers');
    await identityCommand(`INSERT INTO identity_users(id,username,password_hash,first_name,is_admin,groups)
      VALUES ('${owner}','owner','fixture','Owner',true,'["family"]'),
        ('${household}','household','fixture','Household',false,'["family"]'),
        ('${denied}','denied','fixture','Denied',true,'["other"]');
      UPDATE identity_appliance_claim SET owner_user_id='${owner}' WHERE singleton;
      INSERT INTO admission_ui_mappings VALUES ('${owner}','${uiId}');`);
    await ensureClient({ clientId: 'youeye-ui', clientSecret: '', name: 'UI', scopes: ['openid'], redirectUris: [] });
    assert.equal((await evaluateClientAdmission('youeye-ui', household)).allowed, true, 'fresh core client preserves platform access');
    await ensureClient({ clientId: 'client-a', clientSecret: '', name: 'App A', scopes: ['openid'], redirectUris: [] });
    const first = await ensureAppAdmission({ appId: 'app-a', clientId: 'client-a', routes: [{ host: 'a.example.test' }] });
    assert.equal(first.ownerId, owner);
    assert.equal((await evaluateAppAdmission('app-a', owner)).reason, 'policy_pending');
    const acknowledge = () => identityCommand('UPDATE admission_outbox SET acknowledged_revision=revision');
    await acknowledge();
    assert.equal((await evaluateAppAdmission('app-a', owner)).allowed, true);
    assert.equal((await evaluateAppAdmission('app-a', household)).allowed, false);
    assert.equal((await evaluateAppAdmission('app-a', denied)).allowed, false, 'admin is not an app grant');
    const changed = await updateAdmissionPolicy({ actorId: owner, expectedRevision: first.revision,
      policy: { ...first, mode: 'users', userIds: [household] } });
    assert.equal(changed.revision, first.revision + 1);
    assert.equal((await evaluateAppAdmission('app-a', household)).reason, 'policy_pending');
    await acknowledge();
    assert.equal((await evaluateAppAdmission('app-a', household)).allowed, true);
    const ownerSession = await createIdentitySession(owner);
    const ownerCodeInput = { clientId: 'client-a', userId: owner, sessionId: ownerSession.id,
      redirectUri: 'https://a.example.test/callback', scope: 'openid' };
    const ownerCode = await createAuthCode(ownerCodeInput);
    assert.equal((await consumeAuthCode(ownerCode, 'client-a', ownerCodeInput.redirectUri))?.user_id, owner);
    assert.equal(await consumeAuthCode(ownerCode, 'client-a', ownerCodeInput.redirectUri), null);
    await assert.rejects(createAuthCode({ ...ownerCodeInput, clientId: 'unknown-client' }), /admission changed/);
    await assert.rejects(createAuthCode({ ...ownerCodeInput, userId: household }),
      /admission changed/, 'session subject must match even when both users are admitted');
    const refresh = await issueRefreshToken({ clientId: 'client-a', userId: owner,
      sessionId: ownerSession.id, scope: 'openid' });
    const rotated = await rotateRefreshToken(refresh, 'client-a');
    assert.ok(rotated);
    await ensureAppAdmission({ appId: 'app-b', routes: [{ host: 'b.example.test' }] });
    await acknowledge();
    assert.equal((await evaluateAppAdmission('app-b', household)).allowed, false);
    const stopped = await ensureAppAdmission({ appId: 'restore-stopped', routes: [] });
    await setAdmissionAppEnabled(stopped.appId, stopped.installationId, false);
    const archivedStopped = await exportAppAdmission(stopped.appId);
    await validateAppAdmissionRestore(archivedStopped, stopped.appId);
    await assert.rejects(ensureAppAdmission({ appId: stopped.appId, routes: [] }), /ownership is quarantined/);
    const rebuilt = await ensureAppAdmission({ appId: stopped.appId, routes: [{ host: 'stopped.example.test' }],
      restoredIdentity: { installationId: stopped.installationId, ownerId: owner } });
    assert.equal(rebuilt.state, 'pending');
    await acknowledge();
    assert.equal((await evaluateAppAdmission(stopped.appId, owner)).allowed, false,
      'restoring a stopped installation never makes its pending policy ready');
    await assert.rejects(ensureAppAdmission({ appId: stopped.appId, routes: [],
      restoredIdentity: { installationId: stopped.installationId, ownerId: household } }), /ownership is unavailable/);
    await ensureClient({ clientId: 'native-client', clientSecret: '', name: 'Native', scopes: ['openid'], redirectUris: [] });
    const native = await ensureAppAdmission({ appId: 'private-native', clientId: 'native-client', routes: [] });
    const nativeGrant = await updateAdmissionPolicy({ actorId: owner, expectedRevision: native.revision,
      policy: { ...native, mode: 'users', userIds: [denied] } });
    await identityCommand(`INSERT INTO admission_user_data_contracts VALUES ('${native.installationId}')`);
    await acknowledge();
    assert.equal((await evaluateAppAdmission('private-native', denied)).allowed, true);
    const nativeSession = await createIdentitySession(denied);
    const nativeCode = await createAuthCode({ clientId: 'native-client', userId: denied,
      sessionId: nativeSession.id, redirectUri: 'https://native.example.test/callback', scope: 'openid' });
    const nativeRefresh = await issueRefreshToken({ clientId: 'native-client', userId: denied,
      sessionId: nativeSession.id, scope: 'openid' });
    const privateInventory = await exportAppAdmission('private-native');
    assert.ok(privateInventory.resources.some(r => r.scope === 'per_user'
      && r.identityUserId === denied && r.ownerId === denied && r.enforcement === 'app_native'));
    await assert.rejects(deleteIdentityUser(denied), /explicitly retain\/quarantine/);
    await quarantineAdmissionData({ appId: 'private-native', actorId: owner, principalId: denied,
      expectedRevision: nativeGrant.revision });
    await acknowledge();
    assert.equal((await evaluateAppAdmission('private-native', denied)).allowed, false,
      'quarantine closes admission even while the principal is still active and selected');
    assert.equal((await getAdmissionSnapshot('private-native'))?.principals.find(p => p.id === denied)?.active, false,
      'UI projection denies the same quarantined principal without reverse RPC');
    assert.equal(await rotateRefreshToken(nativeRefresh, 'native-client'), null,
      'resource quarantine also closes refresh admission in the database grant guard');
    assert.equal(await consumeAuthCode(nativeCode, 'native-client', 'https://native.example.test/callback'), null,
      'quarantine invalidates an issued code before exchange');
    await assert.rejects(createAuthCode({ clientId: 'native-client', userId: denied,
      sessionId: nativeSession.id, redirectUri: 'https://native.example.test/callback', scope: 'openid' }),
      /admission changed/, 'the store independently rejects code issuance after quarantine');
    assert.ok((await identityRows(`SELECT user_id FROM admission_logout_outbox
      WHERE client_id='native-client' AND user_id='${denied}'`)).length,
      'quarantine invalidates participating native sessions as part of the policy revision');
    await deleteIdentityUser(denied);
    const recreated = await createIdentityUser({ username: 'denied', firstName: 'Recreated', password: 'fixture-pass-123' });
    assert.notEqual(recreated.id, denied);
    await acknowledge();
    assert.equal((await evaluateAppAdmission('private-native', recreated.id)).allowed, false,
      'recreated labels cannot inherit the old selected-user grant');
    const recreatedInventory = await exportAppAdmission('private-native');
    assert.ok(recreatedInventory.resources.some(r => r.identityUserId === denied && r.state === 'quarantined'));
    assert.ok(recreatedInventory.resources.some(r => r.identityUserId === recreated.id && r.state === 'active'),
      'new UUID receives its own reserved namespace, never the deleted user namespace');
    await validateAppAdmissionRestore(recreatedInventory, 'private-native');
    await identityCommand(`UPDATE admission_policies SET state='retained',revision=revision+1
      WHERE app_id='private-native';
      UPDATE admission_resources SET state='retained',declaration=jsonb_set(declaration,'{state}','"retained"'::jsonb)
      WHERE installation_id='${native.installationId}' AND state='active';`);
    const adoptedNative = await ensureAppAdmission({ appId: 'private-native', actorId: owner,
      adoptRetainedData: true, routes: [] });
    assert.equal(adoptedNative.installationId, native.installationId);
    await acknowledge();
    assert.equal((await evaluateAppAdmission('private-native', recreated.id)).allowed, false);
    assert.ok((await exportAppAdmission('private-native')).resources.some(r =>
      r.identityUserId === denied && r.state === 'quarantined'),
    'adopting the same installation must preserve inaccessible tombstoned namespaces');
    await identityCommand(`UPDATE admission_policies SET state='deleted',revision=revision+1
      WHERE app_id='private-native';
      UPDATE admission_resources SET state='deleted',declaration=jsonb_set(declaration,'{state}','"deleted"'::jsonb)
      WHERE installation_id='${native.installationId}' AND state <> 'quarantined';`);
    const lateUser = await createIdentityUser({ username: 'late-user', firstName: 'Late', password: 'fixture-pass-123' });
    assert.ok(!(await exportAppAdmission('private-native')).resources.some(r => r.identityUserId === lateUser.id),
      'a deleted installation does not reserve new active data');
    const foreignResource = { schemaVersion: 1, appId: 'private-native', installationId: native.installationId,
      resourceId: 'runtime:foreign-deleted', scope: 'app_global', enforcement: 'needs_review',
      ownerId: household, identityUserId: null, uiUserId: null, shareId: null, consumerIds: [], state: 'deleted' };
    // Inject hostile historical metadata directly; the public write API already
    // refuses this foreign owner. Reinstall must independently refuse it too.
    await identityCommand(`INSERT INTO admission_resources
      (installation_id,resource_id,declaration,owner_id,state)
      VALUES ('${native.installationId}','runtime:foreign-deleted',
        '${JSON.stringify(foreignResource)}','${household}','deleted')`);
    await assert.rejects(ensureAppAdmission({ appId: 'private-native', actorId: owner, routes: [] }),
      /explicit data disposition/, 'declared namespace exception must not permit foreign physical-resource ownership');
    await identityCommand(`DELETE FROM admission_resources WHERE installation_id='${native.installationId}'
      AND resource_id='runtime:foreign-deleted'`);
    const freshNative = await ensureAppAdmission({ appId: 'private-native', actorId: owner, routes: [] });
    assert.equal(freshNative.installationId, native.installationId,
      'deleted declared namespaces of other known users must not block a fresh empty reinstall');
    await reserveAppUserData(native.installationId, false);
    await reserveAppUserData(native.installationId);
    const freshInventory = await exportAppAdmission('private-native');
    assert.equal(freshInventory.resources.filter(r => r.identityUserId === lateUser.id).length, 1,
      'idempotent install reconciliation reserves users created while the app was uninstalled');
    assert.equal(freshInventory.resources.find(r => r.identityUserId === denied)?.state, 'quarantined',
      'fresh reinstall never reopens a deletion tombstone');
    await acknowledge();
    assert.equal((await evaluateAppAdmission('private-native', denied)).allowed, false);
    const noop = await updateAdmissionPolicy({ actorId: owner, expectedRevision: changed.revision, policy: changed });
    assert.equal(noop.revision, changed.revision);
    await assert.rejects(updateAdmissionPolicy({ actorId: household, expectedRevision: changed.revision, policy: changed }));
    await assert.rejects(updateAdmissionPolicy({ actorId: owner, expectedRevision: first.revision, policy: first }));
    const snapshot = await getAdmissionSnapshot('app-a');
    assert.equal(snapshot?.principals.find(p => p.id === household)?.groupIds.length, 1);
    const resource = { schemaVersion: 1 as const, appId: 'app-a', installationId: changed.installationId,
      resourceId: 'private-rows', scope: 'per_user' as const, enforcement: 'platform' as const,
      ownerId: owner, identityUserId: owner, uiUserId: uiId, shareId: null, consumerIds: [], state: 'active' as const };
    await saveResourceOwnership(resource);
    for (const resourceId of ['runtime:app-app-a', 'volume:fixture-data']) {
      await saveResourceOwnership({ ...resource, resourceId, scope: 'app_global',
        enforcement: 'needs_review', identityUserId: null, uiUserId: null });
    }
    const backup = await exportAppAdmission('app-a');
    await validateAppAdmissionRestore(backup, 'app-a');
    const transferred = await updateAdmissionPolicy({ actorId: owner, expectedRevision: changed.revision,
      policy: { ...changed, ownerId: household } });
    await acknowledge();
    assert.equal(await rotateRefreshToken(rotated.token, 'client-a'), null, 'removed owner refresh grant stays invalid');
    await assert.rejects(issueRefreshToken({ clientId: 'client-a', userId: owner,
      sessionId: ownerSession.id, scope: 'openid' }));
    assert.equal((await exportAppAdmission('app-a')).resources[0].ownerId, owner);
    await validateAppAdmissionRestore(backup, 'app-a');
    await quarantineAdmissionData({ appId: 'app-a', actorId: owner, principalId: owner,
      expectedRevision: transferred.revision });
    assert.equal((await exportAppAdmission('app-a')).resources[0].state, 'quarantined');
    const tampered = structuredClone(backup);
    tampered.resources[0].uiUserId = household;
    await assert.rejects(validateAppAdmissionRestore(tampered, 'app-a'));
    await identityCommand(`UPDATE admission_policies SET state='retained',revision=revision+1 WHERE app_id='app-a';`);
    await assert.rejects(ensureAppAdmission({ appId: 'app-a', actorId: denied, routes: [] }));
    await assert.rejects(ensureAppAdmission({ appId: 'app-a', actorId: household, routes: [] }));
    await assert.rejects(ensureAppAdmission({ appId: 'app-a', adoptRetainedData: true, routes: [] }));
    await assert.rejects(ensureAppAdmission({ appId: 'app-a', actorId: household, adoptRetainedData: true, routes: [] }),
      /explicit data disposition/, 'app administration cannot reopen quarantined private data');
    assert.equal((await exportAppAdmission('app-a')).resources[0].ownerId, owner);
    const second = (await getAdmissionSnapshot('app-b'))!.policy;
    assert.deepEqual(await getAdmissionResourceOwners('app-a'), { 'fixture-data': owner },
      'data ownership comes from resources, independently of the transferred policy owner');
    await verifyRetainedAuthority({
      appId: 'app-a', installationId: transferred.installationId,
      containers: [{ containerName: 'app-app-a', name: 'main', type: 'oci' }],
      retainedRoots: { schemaVersion: 1, state: 'ready', roots: [{
        sourceName: 'app-app-a', ownerId: owner, pool: 'default',
        retainedName: `ye-retained-${transferred.installationId.replaceAll('-', '')}-0`,
      }] },
    } as InstallMetadata);
    await identityCommand(`UPDATE admission_policies SET state='retained',revision=revision+1 WHERE app_id='app-b';`);
    const adopted = await ensureAppAdmission({ appId: 'app-b', actorId: owner, adoptRetainedData: true, routes: [] });
    assert.equal(adopted.installationId, second.installationId);
    assert.equal(adopted.mode, second.mode);
    const shareId = '30000000-0000-4000-8000-000000000001';
    await identityCommand(`INSERT INTO admission_shares(id, share_key, owner_id)
      VALUES ('${shareId}','shared-fixture','${owner}');`);
    await saveResourceOwnership({ schemaVersion: 1, appId: 'app-b', installationId: second.installationId,
      resourceId: 'volume:shared-fixture', scope: 'shared', enforcement: 'platform', ownerId: owner,
      identityUserId: null, uiUserId: null, shareId, consumerIds: [second.installationId], state: 'retained' });
    assert.equal(await hasOtherShareConsumers({ appId: 'app-a', shareId, sharedGroup: 'shared-fixture' }), true,
      'an offline retained app still owns its shared content');
    await identityCommand(`UPDATE admission_resources SET state='deleted',
      declaration=jsonb_set(declaration,'{state}','"deleted"'::jsonb)
      WHERE installation_id='${second.installationId}' AND resource_id='volume:shared-fixture';`);
    assert.equal(await hasOtherShareConsumers({ appId: 'app-a', shareId, sharedGroup: 'shared-fixture' }), false);
    await identityCommand(`UPDATE admission_policies SET state='deleted',revision=revision+1 WHERE app_id='app-b';`);
    await assert.rejects(ensureAppAdmission({ appId: 'app-b', routes: [] }),
      /explicit owner adoption/, 'fresh CLI reinstall must carry its resolved authenticated actor');
    const fresh = await ensureAppAdmission({ appId: 'app-b', actorId: owner, routes: [] });
    assert.equal(fresh.installationId, second.installationId);
    assert.equal(fresh.ownerId, owner);
  } finally {
    if (previousSocket === undefined) delete process.env.INCUS_SOCKET;
    else process.env.INCUS_SOCKET = previousSocket;
    if (previousHttps === undefined) delete process.env.INCUS_HTTPS_URL;
    else process.env.INCUS_HTTPS_URL = previousHttps;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    const cleaned = remoteSql(`DROP SCHEMA ${schema} CASCADE;`);
    assert.equal(cleaned.status, 0, 'Isolated test schema cleanup failed');
  }
});
