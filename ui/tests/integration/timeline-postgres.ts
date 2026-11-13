import assert from 'node:assert/strict';
import { db, sql, ensureSchema, cleanup, namespace } from './timeline-db';
import { users, userEncryptionKeys, timelineEntries, systemSettings } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { getTimelineCollection, setTimelineCollection } from '../../src/lib/db/queries/timeline-collection';
import { createTimelineEntry, createHybridTimelineEntry } from '../../src/lib/db/queries/timeline';
import { createPIN, verifyPIN, changePIN, getActiveDerivedKey, getPublicKey, getPrivateKey } from '../../src/lib/crypto/pin-session';
import { decrypt, hybridDecrypt } from '../../src/lib/crypto/encryption';
import { withTimelineUserLock } from '../../src/lib/db/timeline-lock';
const request = () => crypto.randomUUID();
const event = () => ({ app_id: 'test', entry_type: 'test', title: 'private fixture', timestamp: new Date().toISOString(), tags: {}, data: {} });
async function main() {
  try {
    await ensureSchema();
    const [a, b] = await db.insert(users).values([{ username: 'timeline-a' }, { username: 'timeline-b' }]).returning();
    assert.deepEqual(await getTimelineCollection(a.id), { configured: false, enabled: false, revision: null, enabledAt: null });
    await assert.rejects(setTimelineCollection(a.id, { enabled: true, expected_revision: null, request_id: request(), complete: true }), /key_required/);
    assert.equal((await db.select().from(users).where(eq(users.id, a.id)))[0].onboardingCompleted, false);
    const secret = '  слово 家 🔑 e\u0301!  ';
    await createPIN(a.id, secret);
    const firstKey = (await db.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, a.id)))[0];
    await createPIN(a.id, secret);
    assert.equal((await db.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, a.id)))[0].publicKey, firstKey.publicKey);
    await assert.rejects(createPIN(a.id, secret.trim()), /already exists/);
    assert.equal(await verifyPIN(a.id, secret.trim()), null);
    const key = await getActiveDerivedKey(a.id); assert.ok(key);
    const turnOn = { enabled: true, expected_revision: null, request_id: request(), complete: true };
    const on = await setTimelineCollection(a.id, turnOn);
    assert.deepEqual(await setTimelineCollection(a.id, turnOn), on);
    await assert.rejects(setTimelineCollection(a.id, { ...turnOn, enabled: false }), /collection_changed/);
    assert.equal((await db.select().from(users).where(eq(users.id, a.id)))[0].onboardingCompleted, true);
    const publicKey = await getPublicKey(a.id); assert.ok(publicKey);
    await createTimelineEntry(a.id, 'history', event(), key, on.revision!);
    await createHybridTimelineEntry(a.id, 'history', event(), publicKey, on.revision!);
    await assert.rejects(createTimelineEntry(a.id, 'history', event(), key), /collection_changed/);
    const beforeDisable = event();
    // Hold the real database lock, queue disable first, then a late writer.
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(r => { entered = r; });
    const latch = new Promise<void>(r => { release = r; });
    const hold = withTimelineUserLock(a.id, async () => { entered(); await latch; });
    await held;
    const disabled = setTimelineCollection(a.id, { enabled: false, expected_revision: on.revision, request_id: request() });
    // PostgreSQL waiters are observable: don't rely on timing to arrange the race.
    for (let i = 0; i < 100; i++) {
      const blocked = await sql`select count(*)::int as n from pg_stat_activity where wait_event = 'advisory' and application_name = ${namespace} and pid <> pg_backend_pid()`;
      if (blocked[0].n > 0) break;
      if (i === 99) throw new Error('Disable did not reach advisory lock');
    }
    const late = createTimelineEntry(a.id, 'history', event(), key, on.revision!);
    const lateRejected = assert.rejects(late, /collection_off/);
    release(); await hold;
    const off = await disabled; await lateRejected;
    assert.equal((await db.select().from(timelineEntries)).length, 2);
    const bOff = await setTimelineCollection(b.id, { enabled: false, expected_revision: null, request_id: request(), complete: true });
    assert.equal(bOff.enabled, false);
    assert.equal((await db.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, b.id))).length, 0);
    const again = await setTimelineCollection(a.id, { enabled: true, expected_revision: off.revision, request_id: request() });
    await assert.rejects(createTimelineEntry(a.id, 'history', beforeDisable, key, again.revision!), /collection_changed/);
    await assert.rejects(createTimelineEntry(a.id, 'history', event(), key, on.revision!), /collection_changed/);
    assert.equal((await getTimelineCollection(b.id)).enabled, false);
    const newSecret = 'different 字 🔒 secret';
    assert.equal(await changePIN(a.id, secret, newSecret), true);
    assert.equal(await getActiveDerivedKey(a.id), null);
    assert.equal(await verifyPIN(a.id, secret), null);
    await verifyPIN(a.id, newSecret);
    const rotated = await getActiveDerivedKey(a.id); assert.ok(rotated);
    const privateKey = await getPrivateKey(a.id, rotated); assert.ok(privateKey);
    const rows = await db.select().from(timelineEntries);
    for (const row of rows) {
      const plain: string = row.encryptionType === 'hybrid' ? await hybridDecrypt(row.encryptedBlob, row.nonce, row.wrappedKey!, privateKey) : await decrypt(row.encryptedBlob, row.nonce, rotated);
      assert.equal(JSON.parse(plain).title, 'private fixture');
    }
    await assert.rejects(createTimelineEntry(a.id, 'history', event(), key, again.revision!), /session changed/);
    // Corruption after a valid row forces rollback of all prior reencryption work.
    await db.insert(timelineEntries).values({ userId: a.id, collection: 'history', encryptedBlob: 'corrupt', nonce: 'corrupt' });
    const before = await db.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, a.id));
    await assert.rejects(changePIN(a.id, newSecret, 'failed transition'));
    assert.deepEqual(await db.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, a.id)), before);
    assert.ok(await verifyPIN(a.id, newSecret));
    const preserved = (await db.select().from(timelineEntries)).find(row => row.encryptionType === 'pin' && row.encryptedBlob !== 'corrupt')!;
    assert.equal(JSON.parse(await decrypt(preserved.encryptedBlob, preserved.nonce, rotated)).title, 'private fixture');
    const [c] = await db.insert(users).values({ username: 'timeline-c' }).returning();
    await sql.unsafe(`ALTER TABLE ${namespace}.users ADD CONSTRAINT reject_fixture_completion CHECK (username <> 'timeline-c' OR onboarding_completed = false)`);
    await assert.rejects(setTimelineCollection(c.id, { enabled: false, expected_revision: null, request_id: request(), complete: true }));
    assert.equal((await getTimelineCollection(c.id)).configured, false);
    await db.update(systemSettings).set({ value: { enabled: true } }).where(eq(systemSettings.key, `timeline_collection:${a.id}`));
    await assert.rejects(getTimelineCollection(a.id), /state_unknown/);
    await assert.rejects(createTimelineEntry(a.id, 'history', event(), rotated, again.revision!), /state_unknown/);
    console.log('PASS: PostgreSQL consent/completion, per-user race, interval fencing, exact-secret retries, hybrid/symmetric rotation and rollback');
  } finally { await cleanup(); }
}
main().catch(() => { console.error('FAIL: isolated Timeline PostgreSQL checks (details withheld to protect payloads)'); process.exitCode = 1; });
