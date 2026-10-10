import { isAdmissionPolicy, isAdmissionPrincipal, isResourceOwnership, isUuid,
  type AdmissionPolicy, type AdmissionPrincipal, type ResourceOwnership } from './admission';
export interface AdmissionBackup {
  schemaVersion: 1;
  policy: AdmissionPolicy;
  principals: AdmissionPrincipal[];
  groups: Array<{ id: string; key: string; label: string; deleted: boolean }>;
  shares: Array<{ id: string; key: string; ownerId: string; deleted: boolean; consumerIds: string[] }>;
  resources: ResourceOwnership[];
}
export function readAdmissionBackup(value: unknown, appId: string): AdmissionBackup {
  if (!value || typeof value !== 'object') throw new Error('Missing admission backup metadata');
  const b = value as AdmissionBackup;
  if (b.schemaVersion !== 1 || !isAdmissionPolicy(b.policy) || b.policy.appId !== appId
    || !Array.isArray(b.principals) || !b.principals.every(isAdmissionPrincipal)
    || new Set(b.principals.map(p => p.id)).size !== b.principals.length
    || new Set(b.principals.filter(p => p.uiUserId).map(p => p.uiUserId)).size
      !== b.principals.filter(p => p.uiUserId).length
    || !Array.isArray(b.groups) || !b.groups.every(g => isUuid(g.id) && typeof g.key === 'string'
      && g.key.length > 0 && typeof g.label === 'string' && typeof g.deleted === 'boolean')
    || new Set(b.groups.map(g => g.id)).size !== b.groups.length
    || new Set(b.groups.map(g => g.key)).size !== b.groups.length
    || !Array.isArray(b.shares) || !b.shares.every(s => isUuid(s.id) && isUuid(s.ownerId)
      && typeof s.key === 'string' && s.key.length > 0 && typeof s.deleted === 'boolean'
      && Array.isArray(s.consumerIds) && s.consumerIds.every(isUuid)
      && new Set(s.consumerIds).size === s.consumerIds.length)
    || new Set(b.shares.map(s => s.id)).size !== b.shares.length
    || new Set(b.shares.map(s => s.key)).size !== b.shares.length
    || !Array.isArray(b.resources) || !b.resources.every(r => isResourceOwnership(r)
      && r.appId === appId && r.installationId === b.policy.installationId)
    || new Set(b.resources.map(r => r.resourceId)).size !== b.resources.length) {
    throw new Error('Unsupported or malformed admission backup metadata');
  }
  if (!b.principals.some(p => p.id === b.policy.ownerId)
    || b.policy.userIds.some(id => !b.principals.some(p => p.id === id))
    || b.policy.groupIds.some(id => !b.groups.some(g => g.id === id))
    || b.principals.some(p => p.groupIds.some(id => !b.groups.some(g => g.id === id)))
    || b.resources.some(r => !b.principals.some(p => p.id === r.ownerId)
      || (r.identityUserId && !b.principals.some(p => p.id === r.identityUserId
        && (r.uiUserId === null || p.uiUserId === r.uiUserId)))
      || (r.shareId && !b.shares.some(s => s.id === r.shareId && s.ownerId === r.ownerId
        && r.consumerIds.includes(r.installationId) && r.consumerIds.every(id => s.consumerIds.includes(id)))))) {
    throw new Error('Admission backup principal, share or UI mapping is inconsistent');
  }
  // Unknown principals remain quarantined by the restore authority; do not
  // manufacture accounts, remap subjects or infer ownership through labels.
  return structuredClone(b);
}

/** Restore data only under the current immutable ownership bindings. */
export function validateResourceRestore(
  backup: AdmissionBackup, principals: AdmissionPrincipal[], current: ResourceOwnership[],
  shares: AdmissionBackup['shares'],
): void {
  const binding = (r: ResourceOwnership) => JSON.stringify([
    r.appId, r.installationId, r.resourceId, r.scope, r.enforcement, r.ownerId,
    r.identityUserId, r.uiUserId, r.shareId, [...r.consumerIds].sort(),
  ]);
  if (backup.resources.some(r => {
    const currentResource = current.find(c => binding(c) === binding(r));
    if (!currentResource || currentResource.state === 'deleted') return true;
    // A coherent historical backup can retain a deleted principal's quarantined
    // bytes under the same tombstone. An older active namespace cannot revive
    // a subsequently deleted identity or a physically deleted resource.
    const quarantined = r.state === 'quarantined' && currentResource.state === 'quarantined';
    const known = (id: string) => principals.some(p => p.id === id && (!p.deleted || quarantined));
    return !known(r.ownerId)
      || (r.identityUserId !== null && !principals.some(p => p.id === r.identityUserId
        && (!p.deleted || quarantined) && (r.uiUserId === null || p.uiUserId === r.uiUserId)))
      || (r.shareId !== null && !shares.some(s => s.id === r.shareId && !s.deleted && s.ownerId === r.ownerId
        && r.consumerIds.every(id => s.consumerIds.includes(id))));
  })) {
    throw new Error('Restore contains unknown or foreign data ownership; quarantined disposition is required');
  }
}
