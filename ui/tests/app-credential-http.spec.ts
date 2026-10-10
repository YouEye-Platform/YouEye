import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import test from 'node:test';
import { SignJWT } from 'jose';
import type { AppCredentialProjection } from '../../shared/app-service-credential';

const databaseUrl = process.env.APP_CREDENTIAL_TEST_DATABASE_URL;
const enabled = process.env.APP_CREDENTIAL_HTTP_TEST === '1';

test('production HTTP routes deny invalid machine authority even with an administrator cookie',
  { skip: !databaseUrl || !enabled, timeout: 90_000 }, async t => {
    if (!databaseUrl || !/^credential_acceptance_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname.slice(1))) {
      throw new Error('Credential HTTP acceptance requires an isolated database');
    }
    process.env.DATABASE_URL = databaseUrl;
    const { db, ensureSchema } = await import('../src/db');
    t.after(() => db.$client.end());
    const { apps, users, userSettings, pendingTimelineEvents, appServiceCredentials } = await import('../src/db/schema');
    const { eq, sql } = await import('drizzle-orm');
    const { registerApp } = await import('../src/lib/db/queries/app-management');
    const { publishAppServiceCredential, markAppCredentialReady } =
      await import('../src/lib/db/queries/app-service-credentials');
    const { grantPermission } = await import('../src/lib/db/queries/permissions');
    await ensureSchema();
    const appId = 'http-fixture';
    const userId = randomUUID();
    const identityId = randomUUID();
    await db.insert(users).values({
      id: userId, identityId, username: `http-${userId}`, name: 'HTTP fixture', isAdmin: true,
    });
    await db.insert(userSettings).values({
      userId, settings: { [appId]: { sentinel: 'private-fixture-data' } },
    });
    await registerApp({ id: appId, name: 'HTTP fixture', containerUrl: 'http://fixture' });
    await registerApp({ id: 'http-no-hash', name: 'Unprovisioned', containerUrl: 'http://fixture' });
    const secret = `ye_app_v1_${randomBytes(32).toString('base64url')}`;
    const credential: AppCredentialProjection = {
      schema: 'youeye.app-service-credential/1', appId, installationId: randomUUID(),
      generation: 1, revision: 1, status: 'prepared',
      verifierHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      rotatedAt: null, revokedAt: null, expiresAt: null,
    };
    await publishAppServiceCredential(credential, 0);
    const active = { ...credential, revision: 2, status: 'active' as const };
    await publishAppServiceCredential(active, 1);
    await markAppCredentialReady(appId, {
      installationId: active.installationId, generation: active.generation, revision: active.revision,
    });
    const expiredSecret = `ye_app_v1_${randomBytes(32).toString('base64url')}`;
    await registerApp({ id: 'http-expired', name: 'Expired fixture', containerUrl: 'http://fixture' });
    // Seed a formerly acknowledged receipt whose explicit lifetime has elapsed.
    const expired = { ...active, appId: 'http-expired', installationId: randomUUID(),
      verifierHash: createHash('sha256').update(expiredSecret).digest('hex'),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString() };
    await db.insert(appServiceCredentials).values({
      appId: expired.appId, projection: expired, verifierHash: expired.verifierHash, ready: true,
    });

    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const jwtSecret = randomBytes(32).toString('hex');
    const cookie = await new SignJWT({
      userId, identityId, identitySessionId: randomUUID(), username: 'http-admin',
      name: 'HTTP fixture', email: '', isAdmin: true, groups: ['admin'],
    }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(jwtSecret));
    const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start',
      '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret,
        IDENTITY_URL: '', IDENTITY_INTERNAL_URL: '', IDENTITY_CLIENT_ID: '', IDENTITY_CLIENT_SECRET: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Retain output in memory only; never echo cookies, secrets or connection strings.
    let output = '';
    server.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-32_768); });
    server.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-32_768); });
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    t.after(async () => {
      server.kill('SIGTERM');
      await exited;
      assert.equal([secret, expiredSecret, cookie, jwtSecret].some(value => output.includes(value)), false,
        'Production server logs must not contain credential values');
    });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Production HTTP fixture exited before readiness');
      try { ready = (await fetch(`${origin}/api/health`)).ok; } catch { /* Startup. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Production HTTP fixture must start');
    // Integrated positive service requests also require a fresh Household lease.
    // This server and database are isolated; use real bridge authentication without
    // replacing the appliance token or publishing a lease to its running UI.
    const bridgeToken = readFileSync('/etc/youeye/ui-bridge-token', 'utf8').trim();
    assert.ok(bridgeToken, 'HTTP acceptance requires its protected bridge binding');
    const bridgeHeaders = { 'X-UI-Bridge-Token': bridgeToken, 'content-type': 'application/json' };
    const challengeResponse = await fetch(`${origin}/api/ui-bridge/admission`, { headers: bridgeHeaders });
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const now = Date.now();
    const projection = {
      schemaVersion: 1, challenge, sequence: 1, issuedAt: now, expiresAt: now + 60_000,
      policy: { schemaVersion: 1, appId, installationId: randomUUID(), ownerId: identityId,
        mode: 'owner', userIds: [], groupIds: [], revision: 1, state: 'ready', publicAccess: false,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      principals: [{ id: identityId, active: true, deleted: false, groupIds: [], uiUserId: userId }],
    };
    const publication = await fetch(`${origin}/api/ui-bridge/admission`, {
      method: 'POST', headers: bridgeHeaders, body: JSON.stringify(projection),
    });
    assert.equal(publication.status, 200, 'Real HTTP bridge must acknowledge the isolated lease');

    const service = {
      authorization: `Bearer ${secret}`, 'x-youeye-app': appId, 'x-youeye-user': identityId,
    };
    const browser = { cookie: `ye-ui-session=${cookie}` };
    const settingsPath = `/api/v1/apps/${appId}/user-settings`;
    async function call(path: string, headers: Record<string, string>, status: number,
      body?: unknown, method: 'POST' | 'PUT' = 'POST') {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : method,
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      assert.equal(response.status, status, `Unexpected status for ${path}`);
      const text = await response.text();
      assert.equal([secret, expiredSecret, cookie].some(value => text.includes(value)), false,
        'HTTP response disclosed authority');
      return JSON.parse(text);
    }
    assert.equal((await call(settingsPath, service, 200)).settings.sentinel, 'private-fixture-data');
    assert.equal((await call(settingsPath, browser, 200)).settings.sentinel, 'private-fixture-data');
    assert.equal((await call('/api/v1/user', browser, 200)).isAdmin, true);
    await call(settingsPath, {}, 401);
    await call('/api/v1/user', { ...browser, ...service }, 401);
    await call(`/api/v1/admin/apps/${appId}/branding`, { ...browser, ...service }, 403);
    const [beforeBranding] = await db.select().from(apps).where(eq(apps.id, appId));
    for (const authorization of [service.authorization, 'Bearer random']) {
      await call(`/api/v1/admin/apps/${appId}/branding`, { ...browser, ...service, authorization }, 403,
        { headerDisplayMode: 'text' }, 'PUT');
    }
    const [unchanged] = await db.select().from(apps).where(eq(apps.id, appId));
    assert.equal(unchanged.headerDisplayMode, beforeBranding.headerDisplayMode);
    const invalidAttempts: Record<string, string>[] = [
      { 'x-youeye-app': appId, 'x-youeye-user': identityId },
      { authorization: 'Bearer random' },
      { 'x-youeye-user': identityId },
      { ...service, authorization: secret },
      { ...service, authorization: 'Basic fixture' },
      { ...service, authorization: `Bearer ${secret}, Bearer ${secret}` },
      { ...service, authorization: 'Bearer' },
      { ...service, authorization: 'Bearer random' },
      { ...service, authorization: `Bearer ${cookie}` },
      { ...service, authorization: 'Bearer synthetic-ui-bridge-token' },
      { ...service, 'x-youeye-app': `ye-${appId}` },
      { ...service, 'x-youeye-app': 'http-no-hash' },
      { ...service, 'x-ui-bridge-token': 'synthetic-ui-bridge-token' },
      { 'x-app-slug': appId },
    ];
    for (const headers of invalidAttempts) {
      await call(settingsPath, { ...browser, ...headers }, 401);
      await call('/api/v1/timeline', { ...browser, ...headers }, 401,
        { entry_type: 'fixture', title: 'Must be denied' });
    }
    await call(`/api/v1/apps/ye-${appId}/user-settings`, service, 401);
    await call('/api/v1/apps/http-expired/user-settings', {
      ...browser, ...service, 'x-youeye-app': 'http-expired', authorization: `Bearer ${expiredSecret}`,
    }, 401);
    await call('/api/v1/timeline', service, 403, { entry_type: 'fixture', title: 'Permission denied' });
    assert.equal((await db.select().from(pendingTimelineEvents)).length, 0);
    await grantPermission(userId, appId, 'timeline:write');
    await call('/api/v1/timeline', service, 400,
      { app_id: 'system', entry_type: 'fixture', title: 'Cannot impersonate system' });
    await call('/api/v1/timeline', service, 202, { entry_type: 'fixture', title: 'Scoped event' });
    const [queued] = await db.select().from(pendingTimelineEvents);
    assert.equal(queued.appId, appId);
    assert.equal(queued.userId, userId);
    await db.update(apps).set({ enabled: false }).where(eq(apps.id, appId));
    await call(settingsPath, { ...service, ...browser }, 401);
    await db.update(apps).set({ enabled: true }).where(eq(apps.id, appId));
    // Unavailable verifier storage must deny without falling back to the cookie.
    await db.execute(sql`ALTER TABLE app_service_credentials RENAME TO unavailable_credential_fixture`);
    try {
      await call(settingsPath, { ...service, ...browser }, 401);
      await call('/api/v1/user', browser, 200);
      await call('/api/health', {}, 200);
    } finally {
      await db.execute(sql`ALTER TABLE unavailable_credential_fixture RENAME TO app_service_credentials`);
    }
    await call(settingsPath, service, 200);
    // A replay cannot renew authority, and expiry fails closed without denying
    // the browser's independent account route or basic service health.
    const replay = await fetch(`${origin}/api/ui-bridge/admission`, {
      method: 'POST', headers: bridgeHeaders, body: JSON.stringify(projection),
    });
    assert.equal(replay.status, 409);
    const shortLease = { ...projection, sequence: 2, issuedAt: Date.now(), expiresAt: Date.now() + 1_000 };
    assert.equal((await fetch(`${origin}/api/ui-bridge/admission`, {
      method: 'POST', headers: bridgeHeaders, body: JSON.stringify(shortLease),
    })).status, 200);
    await call(settingsPath, service, 200);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    await call(settingsPath, { ...service, ...browser }, 401);
    await call('/api/v1/user', browser, 200);
    await call('/api/health', {}, 200);
    const renewed = { ...projection, sequence: 3, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    assert.equal((await fetch(`${origin}/api/ui-bridge/admission`, {
      method: 'POST', headers: bridgeHeaders, body: JSON.stringify(renewed),
    })).status, 200);
    await call(settingsPath, service, 200);
    await publishAppServiceCredential({
      ...active, revision: 3, status: 'revoked', revokedAt: new Date().toISOString(),
    }, 2);
    await call(settingsPath, { ...service, ...browser }, 401);
    await call('/api/health', {}, 200);
  });
