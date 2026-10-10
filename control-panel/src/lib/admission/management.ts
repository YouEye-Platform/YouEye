import { withAppLifecycle } from '../market/update-admission';
import { ensureIdentitySchema, identityRows as rows, identitySql as sql, identityStatementRows as statementRows } from '@/lib/identity/store';
import type { SessionPayload } from '@/lib/auth/session';
import { isUuid, type ResourceOwnership } from '../../../../shared/admission';

export async function admissionAdministrator(session: SessionPayload): Promise<string | null> {
  await ensureIdentitySchema();
  const identity = session.identityId || (session.authMethod === 'cli' || session.authMethod === 'pam'
    ? (await rows<{ id: string }>(`SELECT owner_user_id::text AS id FROM identity_appliance_claim WHERE singleton`))[0]?.id : null);
  if (!identity || !isUuid(identity)) return null;
  const active = await rows(`SELECT id FROM identity_users
    WHERE id = ${sql(identity)}::uuid AND is_active AND is_admin`);
  return active.length ? identity : null;
}
export async function admissionManagementData(appId: string) {
  await ensureIdentitySchema();
  const [users, groups, resources] = await Promise.all([
    rows<{ id: string; label: string; username: string; active: boolean }>(`
      SELECT id::text, COALESCE(NULLIF(name,''),username) AS label, username, is_active AS active
      FROM identity_users ORDER BY username`),
    rows<{ id: string; label: string; key: string }>(`
      SELECT id::text, label, group_key AS key FROM admission_groups WHERE deleted_at IS NULL ORDER BY group_key`),
    rows<{ resourceId: string; declaration: ResourceOwnership; state: string }>(`
      SELECT r.resource_id AS "resourceId", r.declaration, r.state FROM admission_resources r
      JOIN admission_policies p USING (installation_id) WHERE p.app_id = ${sql(appId)} ORDER BY r.resource_id`),
  ]);
  return { users, groups, resources };
}
/** Retention preserves the original data principal; it never transfers rows. */
export async function quarantineAdmissionData(input: {
  appId: string; actorId: string; principalId: string; expectedRevision: number;
}) {
  return withAppLifecycle(input.appId, () => quarantineAdmissionDataUnderLifecycle(input));
}

async function quarantineAdmissionDataUnderLifecycle(input: {
  appId: string; actorId: string; principalId: string; expectedRevision: number;
}) {
  if (!isUuid(input.actorId) || !isUuid(input.principalId) || !Number.isSafeInteger(input.expectedRevision)) {
    throw new Error('Invalid disposition');
  }
  await ensureIdentitySchema();
  const result = await statementRows<{ installation_id: string }>(`
    authorized AS (
      SELECT p.installation_id FROM admission_policies p
      WHERE p.app_id = ${sql(input.appId)} AND p.revision = ${sql(input.expectedRevision)}
        AND EXISTS (SELECT 1 FROM identity_users WHERE id = ${sql(input.actorId)}::uuid AND is_admin AND is_active)
      FOR UPDATE
    ), retained AS (
      UPDATE admission_resources SET state = 'quarantined',
        declaration = jsonb_set(declaration, '{state}', '"quarantined"'::jsonb)
      WHERE installation_id IN (SELECT installation_id FROM authorized)
        AND (owner_id = ${sql(input.principalId)}::uuid OR private_user_id = ${sql(input.principalId)}::uuid)
        AND state IN ('active','retained') RETURNING installation_id, declaration
    ), changed AS (
      UPDATE admission_policies p SET revision = revision + 1, updated_at = now(),
        state = CASE WHEN EXISTS (SELECT 1 FROM retained r WHERE r.installation_id = p.installation_id
          AND r.declaration->>'scope' IN ('app_global','shared')) THEN 'quarantined' ELSE p.state END
      WHERE installation_id IN (SELECT installation_id FROM retained) RETURNING installation_id, revision
    ), audited AS (
      INSERT INTO admission_audit (installation_id,actor_id,action,revision,details)
      SELECT installation_id,${sql(input.actorId)}::uuid,'data_retained_quarantined',revision,
        jsonb_build_object('principalId',${sql(input.principalId)}) FROM changed
    )`, 'SELECT installation_id::text FROM changed');
  if (!result.length) throw new Error('Disposition conflict or no unresolved resources');
}
