import { isUuid } from './admission';
export interface ProfileBinding { id: string; identityId: string | null }
export function decideProfileBinding(identityId: string, existing: ProfileBinding | null,
  conflicts: ProfileBinding[], deletedIds: string[]): { reuseId: string | null; releaseLabelIds: string[] } {
  if (!isUuid(identityId) || deletedIds.includes(identityId)) throw new Error('Invalid or deleted identity');
  if (existing) {
    if (existing.identityId !== identityId || !isUuid(existing.id)) throw new Error('Immutable profile mapping conflict');
    return { reuseId: existing.id, releaseLabelIds: [] };
  }
  if (conflicts.some(p => !p.identityId || !deletedIds.includes(p.identityId))) {
    throw new Error('Display identifier belongs to another identity; explicit profile resolution is required');
  }
  return { reuseId: null, releaseLabelIds: [...new Set(conflicts.map(p => p.id))] };
}
