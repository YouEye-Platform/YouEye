import { eq, sql } from 'drizzle-orm';
import { db, ensureSchema } from '@/db';
import { apps, appServiceCredentials } from '@/db/schema';
import {
  checkAppCredentialBatch,
  checkAppCredentialRestoreFence,
  parseAppCredentialProjection,
  isActiveAppCredential,
  type AppCredentialProjection,
} from '../../../../../shared/app-service-credential';
import { AppCredentialPublicationConflict } from '@/lib/auth/app-credential-publication';

/** Serialize first publication as well as updates; there may be no row to lock. */
export async function publishAppServiceCredential(
  incoming: AppCredentialProjection,
  expectedRevision: number,
): Promise<'apply' | 'unchanged'> {
  return publishAppServiceCredentialBatch([incoming], expectedRevision);
}

export async function publishAppServiceCredentialBatch(
  incoming: AppCredentialProjection[],
  expectedRevision: number,
): Promise<'apply' | 'unchanged'> {
  const credential = parseAppCredentialProjection(incoming[incoming.length - 1]);
  await ensureSchema();
  return db.transaction(async transaction => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app-service-credential'), hashtext(${credential.appId}))`);
    const [record] = await transaction.select()
      .from(appServiceCredentials).where(eq(appServiceCredentials.appId, credential.appId)).limit(1);
    let result: 'apply' | 'unchanged';
    try {
      const current = record ? parseAppCredentialProjection(record.projection) : null;
      result = checkAppCredentialBatch(current, incoming, expectedRevision).result;
    } catch {
      throw new AppCredentialPublicationConflict();
    }
    if (result === 'unchanged') return result;
    const [app] = await transaction.select({ id: apps.id })
      .from(apps).where(eq(apps.id, credential.appId)).limit(1);
    // Revocation remains possible after app data is removed; activation does not.
    if (!app && credential.status !== 'revoked') throw new AppCredentialPublicationConflict();
    const values = {
      appId: credential.appId, projection: credential,
      verifierHash: credential.verifierHash, updatedAt: new Date(),
      ready: false,
    };
    if (record) {
      await transaction.update(appServiceCredentials).set(values)
        .where(eq(appServiceCredentials.appId, credential.appId));
    } else {
      await transaction.insert(appServiceCredentials).values(values);
    }
    return result;
  });
}

export async function markAppCredentialReady(
  appId: string,
  expected: { installationId: string; generation: number; revision: number; ready?: boolean },
): Promise<void> {
  await ensureSchema();
  await db.transaction(async transaction => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app-service-credential'), hashtext(${appId}))`);
    const [record] = await transaction.select().from(appServiceCredentials)
      .where(eq(appServiceCredentials.appId, appId)).limit(1);
    if (!record) throw new AppCredentialPublicationConflict();
    const credential = parseAppCredentialProjection(record.projection);
    if (credential.status !== 'active' || (expected.ready !== false && !isActiveAppCredential(credential))
      || credential.installationId !== expected.installationId
      || credential.revision !== expected.revision || credential.generation !== expected.generation) {
      throw new AppCredentialPublicationConflict();
    }
    await transaction.update(appServiceCredentials).set({ ready: expected.ready !== false, updatedAt: new Date() })
      .where(eq(appServiceCredentials.appId, appId));
  });
}

export async function readAppCredentialProjection(appId: string): Promise<AppCredentialProjection | null> {
  await ensureSchema();
  const [record] = await db.select().from(appServiceCredentials)
    .where(eq(appServiceCredentials.appId, appId)).limit(1);
  return record ? parseAppCredentialProjection(record.projection) : null;
}

export async function publishAppCredentialRestoreFence(
  credential: AppCredentialProjection, expected: AppCredentialProjection | null,
): Promise<void> {
  await ensureSchema();
  await db.transaction(async transaction => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app-service-credential'), hashtext(${credential.appId}))`);
    const [record] = await transaction.select().from(appServiceCredentials)
      .where(eq(appServiceCredentials.appId, credential.appId)).limit(1);
    try {
      if (checkAppCredentialRestoreFence(record ? parseAppCredentialProjection(record.projection) : null,
        credential, expected) === 'unchanged') return;
    } catch { throw new AppCredentialPublicationConflict(); }
    const values = { appId: credential.appId, projection: credential,
      verifierHash: credential.verifierHash, ready: false, updatedAt: new Date() };
    if (record) await transaction.update(appServiceCredentials).set(values)
      .where(eq(appServiceCredentials.appId, credential.appId));
    else await transaction.insert(appServiceCredentials).values(values);
  });
}
