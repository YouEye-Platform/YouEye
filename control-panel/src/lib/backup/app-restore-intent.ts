import { isUuid, type AdmissionPolicy } from '../../../../shared/admission';

/** Archive identity is an input only after the current ownership check passes. */
export function readAppRestoreIntent(metadata: Record<string, unknown> | null, policy: AdmissionPolicy,
  current: AdmissionPolicy | null) {
  if (!metadata || metadata.appId !== policy.appId
    || metadata.installationId !== policy.installationId
    || metadata.admissionOwnerId !== policy.ownerId) {
    throw new Error('Backup install metadata does not match admission ownership');
  }
  const desiredState = metadata.enabled === false || metadata.desiredState === 'stopped'
    ? 'stopped' as const : 'running' as const;
  // Ordinary historical restore retains a later legitimate administrator takeover.
  // Data-resource ownership was independently validated against current bindings.
  const admission = { installationId: policy.installationId, ownerId: current?.ownerId ?? '' };
  assertRestoredAdmission(current, admission);
  return { desiredState, admission };
}

/** A pending restored installation may be rebuilt, never made ready here. */
export function assertRestoredAdmission(policy: AdmissionPolicy | null,
  identity: { installationId: string; ownerId: string }) {
  if (!isUuid(identity.installationId) || !isUuid(identity.ownerId) || !policy
    || policy.installationId !== identity.installationId || policy.ownerId !== identity.ownerId
    || !['ready', 'pending'].includes(policy.state)) {
    throw new Error('Restore installation ownership is unavailable or quarantined');
  }
}
