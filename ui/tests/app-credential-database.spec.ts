import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AppCredentialProjection } from '../../shared/app-service-credential';

const databaseUrl = process.env.APP_CREDENTIAL_TEST_DATABASE_URL;

test('real PostgreSQL publication, readiness, metadata refresh and restore preserve credential authority',
  { skip: !databaseUrl }, async t => {
    // This test creates/drops rows only in a deliberately isolated database.
    if (!databaseUrl || !/^credential_acceptance_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname.slice(1))) {
      throw new Error('Credential acceptance requires an isolated database');
    }
    process.env.DATABASE_URL = databaseUrl;
    const { db, ensureSchema } = await import('../src/db');
    t.after(() => db.$client.end());
    const { apps } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const { registerApp, unregisterApp } = await import('../src/lib/db/queries/app-management');
    const { publishAppServiceCredential, publishAppServiceCredentialBatch, markAppCredentialReady,
      readAppCredentialProjection, publishAppCredentialRestoreFence } =
      await import('../src/lib/db/queries/app-service-credentials');
    const { validateAppToken } = await import('../src/lib/auth/app-token');
    await ensureSchema();
    await registerApp({ id: 'wiki', name: 'Fixture', containerUrl: 'http://fixture' });
    let secret = randomBytes(32).toString('base64url');
    const competingSecret = randomBytes(32).toString('base64url');
    const credential: AppCredentialProjection = {
      schema: 'youeye.app-service-credential/1', appId: 'wiki', installationId: randomUUID(),
      generation: 1, revision: 1, status: 'prepared',
      verifierHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: '2026-10-07T00:00:00.000Z', rotatedAt: null, revokedAt: null, expiresAt: null,
    };
    const active = { ...credential, status: 'active' as const, revision: 2 };
    const receipt = { installationId: active.installationId, generation: 1, revision: 2 };
    const request = (authorization = `Bearer ${secret}`, appId = 'wiki') =>
      new Request('http://fixture/private', { headers: { authorization, 'x-youeye-app': appId } });
    assert.equal(await validateAppToken(request()), null); // No-hash registration denies.
    const competed = await Promise.allSettled([
      publishAppServiceCredential(credential, 0),
      publishAppServiceCredential({ ...credential,
        verifierHash: createHash('sha256').update(competingSecret).digest('hex') }, 0),
    ]);
    assert.equal(competed.filter(result => result.status === 'fulfilled').length, 1);
    // Whichever first publisher won, a different same-revision payload cannot overwrite it.
    const winner = await readAppCredentialProjection('wiki');
    assert.ok(winner);
    if (winner.verifierHash !== credential.verifierHash) secret = competingSecret;
    const winningActive = { ...winner, status: 'active' as const, revision: 2 };
    await publishAppServiceCredential(winningActive, 1);
    assert.equal(await validateAppToken(request()), null); // Active but unready denies.
    await markAppCredentialReady('wiki', receipt);
    assert.equal(Boolean(await validateAppToken(request())), true);
    assert.equal(await validateAppToken(request(secret)), null);
    assert.equal(await validateAppToken(request(undefined, 'ye-wiki')), null);
    await markAppCredentialReady('wiki', { ...receipt, ready: false });
    assert.equal(await validateAppToken(request()), null);
    await assert.rejects(() => markAppCredentialReady('wiki', { ...receipt, generation: 2 }));
    await registerApp({ id: 'wiki', name: 'Display refresh', containerUrl: 'http://fixture' });
    assert.ok(JSON.stringify(await readAppCredentialProjection('wiki')) === JSON.stringify(winningActive));
    await markAppCredentialReady('wiki', receipt);
    await db.update(apps).set({ enabled: false }).where(eq(apps.id, 'wiki'));
    assert.equal(await validateAppToken(request()), null);
    await db.update(apps).set({ enabled: true }).where(eq(apps.id, 'wiki'));
    const revoked = { ...winningActive, revision: 3, status: 'revoked' as const, revokedAt: active.createdAt };
    await publishAppServiceCredential(revoked, 2);
    await assert.rejects(() => publishAppServiceCredential(winningActive, 1));
    await assert.rejects(() => markAppCredentialReady('wiki', receipt));
    assert.equal(await validateAppToken(request()), null);
    await unregisterApp('wiki');
    assert.equal((await readAppCredentialProjection('wiki'))?.status, 'revoked');
    // A delayed snapshot/batch cannot resurrect a revoked tombstone.
    await assert.rejects(() => publishAppServiceCredentialBatch([credential, active], 0));
    const fence = { ...revoked, revision: 4 };
    await publishAppCredentialRestoreFence(fence, revoked);
    await publishAppCredentialRestoreFence(fence, revoked); // Lost-ACK replay.
    await publishAppCredentialRestoreFence(fence, fence); // Fresh read observes the existing fence.
    assert.equal((await readAppCredentialProjection('wiki'))?.revision, 4);
    await assert.rejects(() => publishAppCredentialRestoreFence({ ...active, revision: 5 }, fence));
    await assert.rejects(() => publishAppCredentialRestoreFence({ ...fence, revision: 5 }, revoked));
  });
