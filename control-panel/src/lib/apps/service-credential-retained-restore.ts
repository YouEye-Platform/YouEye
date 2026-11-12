import { sameAppCredential, type AppCredentialProjection } from '../../../../shared/app-service-credential';
import type { AppServiceCredentialStore } from './service-credential-store';

export interface RetainedCredentialRestoreEffects {
  readVerifier(): Promise<AppCredentialProjection | null>;
  publish(credential: AppCredentialProjection): Promise<void>;
  publishFence(credential: AppCredentialProjection, expected: AppCredentialProjection | null): Promise<void>;
}

/**
 * Core-only restore keeps target authority outside the restored database.
 * Equal state preserves the secret; a revision gap is crossed only while denied.
 * A durable restore fence can resume, but an explicit revocation stays revoked.
 * Caller must keep the retained runtime stopped under lifecycle exclusion.
 */
export async function reconcileRetainedCredential(
  appId: string,
  store: AppServiceCredentialStore,
  effects: RetainedCredentialRestoreEffects,
): Promise<'revoked' | 'pending'> {
  const current = await store.projection(appId);
  const status = await store.status(appId);
  if (!current || !status) throw new Error('Retained app credential requires repair');
  const observed = await effects.readVerifier();
  if (observed && observed.appId !== appId) throw new Error('Retained app credential identity conflict');

  if (current.status !== 'revoked') {
    // Includes an interrupted activation/publication with a durable outbox.
    try {
      await effects.publish(current);
      return 'pending';
    } catch {
      // Same state plus a transport failure must never mint another generation.
      if (observed && sameAppCredential(current, observed)) throw new Error('Retained credential publication is pending');
    }
  }
  const fence = await store.fenceForRestore(appId, observed, true);
  await effects.publishFence(fence, observed);
  await store.acknowledgePublication(appId, fence.revision);
  const fencedStatus = await store.status(appId);
  if (fencedStatus?.operationKind !== 'restore') return 'revoked';
  // Only the explicit restore marker authorizes this automatic new generation.
  const prepared = await store.prepareRotation(appId, fence.revision);
  await effects.publish(prepared);
  return 'pending';
}
