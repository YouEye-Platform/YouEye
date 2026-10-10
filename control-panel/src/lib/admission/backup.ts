import { getAdmissionPolicy, getAdmissionPrincipals } from './store';
import { ensureIdentitySchema, identityRows as rows, identitySql as sql } from '@/lib/identity/store';
import { readAdmissionBackup, validateResourceRestore, type AdmissionBackup } from '../../../../shared/admission-backup';
import type { ResourceOwnership } from '../../../../shared/admission';
async function getAdmissionShares(): Promise<AdmissionBackup['shares']> {
  return rows<AdmissionBackup['shares'][number]>(`
    SELECT s.id::text, s.share_key AS key, s.owner_id::text AS "ownerId",
      s.deleted_at IS NOT NULL AS deleted,
      COALESCE((SELECT jsonb_agg(DISTINCT consumer.id) FROM admission_resources r,
        LATERAL jsonb_array_elements_text(r.declaration->'consumerIds') consumer(id)
        WHERE r.declaration->>'shareId' = s.id::text AND EXISTS (
          SELECT 1 FROM admission_policies p WHERE p.installation_id::text = consumer.id
        )), '[]'::jsonb) AS "consumerIds"
    FROM admission_shares s`);
}
export async function exportAppAdmission(appId: string): Promise<AdmissionBackup> {
  await ensureIdentitySchema();
  const policy = await getAdmissionPolicy(appId);
  const principals = await getAdmissionPrincipals();
  const [groups, resources, shares] = await Promise.all([
    rows<AdmissionBackup['groups'][number]>(`SELECT id::text, group_key AS key, label,
      deleted_at IS NOT NULL AS deleted FROM admission_groups`),
    rows<{ declaration: ResourceOwnership }>(`SELECT r.declaration FROM admission_resources r
      JOIN admission_policies p USING (installation_id) WHERE p.app_id = ${sql(appId)}`),
    getAdmissionShares(),
  ]);
  return readAdmissionBackup({ schemaVersion: 1, policy, principals, groups,
    shares, resources: resources.map(r => r.declaration) }, appId);
}
/**
 * Ordinary app restore/rollback never rewinds newer grants or creates a
 * principal. Full restore restores the coherent identity DB before this check.
 */
export async function validateAppAdmissionRestore(value: unknown, appId: string): Promise<AdmissionBackup> {
  const backup = readAdmissionBackup(value, appId);
  const current = await getAdmissionPolicy(appId);
  if (!current || current.installationId !== backup.policy.installationId) {
    throw new Error('Restore needs the matching identity/ownership core backup; app data is quarantined');
  }
  const principals = await getAdmissionPrincipals();
  const resources = await rows<{ declaration: ResourceOwnership }>(`
    SELECT declaration FROM admission_resources
    WHERE installation_id = ${sql(current.installationId)}::uuid`);
  if (!principals.some(p => p.id === current.ownerId && !p.deleted)) {
    throw new Error('Restore contains an unknown or foreign data principal; explicit quarantined disposition is required');
  }
  validateResourceRestore(backup, principals, resources.map(r => r.declaration), await getAdmissionShares());
  return backup;
}
