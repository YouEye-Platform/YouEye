import { withAppLifecycle, withAppLifecycles } from '../market/update-admission';
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

/** What keeps a user from being deleted (`assertIdentityDisposition`), by app. */
export interface UserDataDisposition {
  /** Apps the user administers (owner of the access policy). */
  administers: string[];
  /** Apps whose app-wide data (volumes, containers, database, shares) the user owns: they installed it. */
  ownsAppData: string[];
  /** Apps that keep data private to the user only, with their policy revision. */
  privateData: Array<{ appId: string; revision: number }>;
}

export async function userDataDisposition(userId: string): Promise<UserDataDisposition> {
  if (!isUuid(userId)) throw new Error('Invalid user');
  await ensureIdentitySchema();
  const [policies, resources] = await Promise.all([
    rows<{ app_id: string }>(`SELECT app_id FROM admission_policies
      WHERE owner_id = ${sql(userId)}::uuid AND state <> 'deleted' ORDER BY app_id`),
    rows<{ app_id: string; revision: number; app_wide: boolean }>(`
      SELECT p.app_id, p.revision, bool_or(r.declaration->>'scope' IN ('app_global','shared')) AS app_wide
      FROM admission_resources r JOIN admission_policies p USING (installation_id)
      WHERE (r.owner_id = ${sql(userId)}::uuid OR r.private_user_id = ${sql(userId)}::uuid)
        AND r.state IN ('active','retained')
      GROUP BY p.app_id, p.revision ORDER BY p.app_id`),
  ]);
  return {
    administers: policies.map(policy => policy.app_id),
    ownsAppData: resources.filter(resource => resource.app_wide).map(resource => resource.app_id),
    privateData: resources.filter(resource => !resource.app_wide)
      .map(resource => ({ appId: resource.app_id, revision: Number(resource.revision) })),
  };
}

/**
 * Before a user is deleted: retain (quarantine) the data apps keep private to them, the per-app "retain" choice of
 * an app's Access settings (`quarantineAdmissionData`), for every app at once, installed or retained. The data stays,
 * held for no one; the apps go on for everyone else. Refused, with nothing changed, while the user administers an app
 * or owns an app's app-wide data: retaining that would close the app for everyone, so it stays a per-app decision.
 *
 * Retained data cannot be handed back, so a refusal must leave nothing retained: YouEye ID's lifecycle and every
 * app's are taken first (a busy one refuses here), what the user holds is read again under them, and only then is
 * anything retained. `thenDelete` (the deletion) runs under the same locks, so nothing new can appear in between.
 * Returns the apps whose data was retained.
 */
export async function retainUserPrivateData(
  userId: string, actorId: string, thenDelete?: () => Promise<void>,
): Promise<string[]> {
  const planned = await userDataDisposition(userId);
  refuseAppWideOwner(planned);
  const apps = new Set(planned.privateData.map(entry => entry.appId));
  return withAppLifecycles(['identity', ...apps], async () => {
    const disposition = await userDataDisposition(userId);
    refuseAppWideOwner(disposition);
    if (disposition.privateData.some(entry => !apps.has(entry.appId))) {
      throw dispositionError('What apps keep for this user changed meanwhile; nothing was retained. Try again');
    }
    for (const { appId, revision } of disposition.privateData) {
      await quarantineAdmissionDataUnderLifecycle({ appId, actorId, principalId: userId, expectedRevision: revision });
    }
    await thenDelete?.();
    return [...new Set(disposition.privateData.map(entry => entry.appId))];
  });
}

function dispositionError(message: string): Error {
  return Object.assign(new Error(message), { name: 'IdentityDispositionError' });
}

function refuseAppWideOwner(disposition: UserDataDisposition): void {
  const blocking = [...new Set([...disposition.administers, ...disposition.ownsAppData])].sort();
  if (blocking.length) {
    throw dispositionError(`This user administers or installed ${blocking.join(', ')}. Transfer each app's `
      + 'administration in its Access settings, and remove an app whose app-wide data they own (or retain that data '
      + 'there, which closes the app), before deleting this user');
  }
}
