import { isUuid } from '../../../../shared/admission';
import type { InstallMetadata } from './types';
import type { PointerManagedInstallation } from '../pointer/managed-apps';

export type RestoredManagedAI = NonNullable<InstallMetadata['aiConnection']>;

/** The authenticated app archive supplies identity, never a new provisioning request. */
export function readRestoredManagedAI(appId: string, value: unknown): RestoredManagedAI | undefined {
  if (value === undefined || value === null) return undefined;
  const saved = value as RestoredManagedAI;
  const prefix = `market:${appId}:`;
  if (typeof saved.externalInstallationId !== 'string' || !saved.externalInstallationId.startsWith(prefix)
    || !isUuid(saved.externalInstallationId.slice(prefix.length)) || !isUuid(saved.ownerUserId)
    || !saved.pointerInstallationId || !saved.pointerInstanceId || !saved.pointerOwnerId || !saved.modelGroupId
    || !saved.keyPreview || saved.credentialSecret !== 'pointer_api_key'
    || !['active', 'disabled'].includes(saved.state)) {
    throw new Error('Backup managed AI identity is incomplete or unavailable');
  }
  return saved;
}

export function assertRestoredManagedAI(appId: string, saved: RestoredManagedAI,
  current: PointerManagedInstallation, credential: string | null) {
  if (!credential || current.app.id !== appId || current.externalInstallationId !== saved.externalInstallationId
    || current.pointer.installationId !== saved.pointerInstallationId || current.pointer.instanceId !== saved.pointerInstanceId
    || current.routingOwner?.id !== saved.pointerOwnerId || current.routingOwner.externalSubject !== saved.ownerUserId
    || current.routingOwner.state !== 'active' || current.selectedGroup?.id !== saved.modelGroupId
    || current.state !== saved.state || !current.credential || current.credential.revoked
    || current.credential.preview !== saved.keyPreview || current.drift.codes.length > 0
    || !['acknowledged', 'not_applicable'].includes(current.credential.deliveryState)) {
    throw new Error('Restored Pointer connection does not match the protected app binding');
  }
}
