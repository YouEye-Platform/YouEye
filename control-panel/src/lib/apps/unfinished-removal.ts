import { appServiceCredentials } from './service-credential-store';
import type { InstallMetadata } from '@/lib/market/types';

/**
 * An app whose removal stopped after its service credential was revoked (YE-225). The uninstall marks the record
 * pending, quiesces the app and revokes the credential before it deletes anything (a failed install's rollback revokes
 * too); when a later step fails (the dashboard down, so the revocation can't be published, or a container that won't
 * go), the app keeps its record with a revoked credential.
 *
 * Revocation is final: no reconcile can bring the credential back (`App credential requires repair`), and a new
 * generation would need the very dashboard publication that failed. The app was being removed, and running the
 * removal again finishes it, so that is what the start refusal, the credential reconcile and Settings say instead of
 * offering a Reconcile that cannot work.
 *
 * The signal: the record says pending while the store's credential is revoked by a revocation (`operationKind`
 * `revoke`): the uninstall and an install's rollback. A failed server restore also leaves a revoked credential and
 * a pending record, but its fence is `operationKind` `restore` and a Reconcile recovers it (alpha.7 review), so it is
 * not this. A deliberate revoke through the credential API records `revoked` on the record. The store is read without
 * its lock (`observeCopyStatus`): this runs for Settings' polls too, and only reads.
 */
export async function removalUnfinished(
  metadata: Pick<InstallMetadata, 'appId' | 'serviceCredentialState'> | null | undefined,
): Promise<boolean> {
  if (!metadata || metadata.serviceCredentialState !== 'pending') return false;
  const credential = await appServiceCredentials.observeCopyStatus(metadata.appId).catch(() => null);
  return credential?.status === 'revoked' && credential.operationKind === 'revoke';
}

/**
 * Names both CLI forms: `youeye app remove` deletes the data unless `--keep-data` is given, and the interrupted
 * removal may have been one that keeps it (Iris's review). Remove in Settings asks.
 */
export function unfinishedRemovalMessage(appId: string): string {
  return `The removal of ${appId} did not finish and its service access is already revoked: remove it again to finish: `
    + `youeye app remove ${appId} --keep-data if you chose to keep its data, youeye app remove ${appId} to delete it `
    + '(or Remove in Settings, which asks)';
}
