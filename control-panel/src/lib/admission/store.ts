import {
  evaluateAdmission, isAdmissionPolicy, isResourceOwnership, isAppId, isUuid,
  type AdmissionPolicy, type AdmissionPrincipal, type AdmissionDecision, type ResourceOwnership,
} from '../../../../shared/admission';
import {
  ensureIdentitySchema, identityRows as rows, identityCommand as command,
  identitySql as sql, identitySqlJson as json,
  identityStatementRows as statementRows,
} from '@/lib/identity/store';

import { withAppLifecycle } from '../market/update-admission';
import { assertRestoredAdmission } from '../backup/app-restore-intent';

export { evaluateAdmission };
const POLICY_SELECT = `
SELECT jsonb_build_object('schemaVersion', p.schema_version, 'appId', p.app_id,
  'installationId', p.installation_id, 'ownerId', p.owner_id, 'mode', p.mode,
  'userIds', p.user_ids, 'groupIds', p.group_ids, 'revision', p.revision,
  'state', p.state, 'publicAccess', p.public_access,
  'createdAt', p.created_at, 'updatedAt', p.updated_at) AS policy,
  COALESCE(o.acknowledged_revision = p.revision, false) AS reconciled
FROM admission_policies p LEFT JOIN admission_outbox o USING (installation_id)`;
function principalSelect(appId?: string) {
  return `
    SELECT a.id::text, (a.active AND COALESCE(u.is_active, false)
      ${appId ? `AND NOT EXISTS (SELECT 1 FROM admission_resources r JOIN admission_policies p USING (installation_id)
        WHERE p.app_id = ${sql(appId)} AND r.private_user_id = a.id AND r.state = 'quarantined')` : ''}) AS active,
      a.deleted_at IS NOT NULL AS deleted, m.ui_user_id::text AS "uiUserId",
      COALESCE((SELECT jsonb_agg(g.id::text ORDER BY g.id) FROM admission_groups g
        WHERE g.deleted_at IS NULL AND u.groups ? g.group_key), '[]'::jsonb) AS "groupIds"
    FROM admission_principals a LEFT JOIN identity_users u ON u.id = a.id
    LEFT JOIN admission_ui_mappings m ON m.identity_id = a.id`;
}

export async function getAdmissionPolicy(appId: string): Promise<AdmissionPolicy | null> {
  await ensureIdentitySchema();
  const result = await rows<{ policy: AdmissionPolicy }>(`${POLICY_SELECT} WHERE p.app_id = ${sql(appId)}`);
  return result[0]?.policy ?? null;
}
export async function getAdmissionPrincipals(): Promise<AdmissionPrincipal[]> {
  await ensureIdentitySchema();
  return rows<AdmissionPrincipal>(principalSelect());
}
/** Policy and membership come from one PostgreSQL statement snapshot. */
export async function getAdmissionSnapshot(appId: string) {
  await ensureIdentitySchema();
  const [snapshot] = await rows<{ policy: AdmissionPolicy; reconciled: boolean; principals: AdmissionPrincipal[] }>(`
    WITH policy AS (${POLICY_SELECT} WHERE p.app_id = ${sql(appId)}),
      principals AS (${principalSelect(appId)})
    SELECT policy.*, COALESCE((SELECT jsonb_agg(principals) FROM principals), '[]'::jsonb) AS principals
    FROM policy`);
  return snapshot ?? null;
}
export async function evaluateAppAdmission(appId: string, identityUserId: string): Promise<AdmissionDecision> {
  if (!isAppId(appId) || !isUuid(identityUserId)) return evaluateAdmission(null, null);
  await ensureIdentitySchema();
  const [record] = await rows<{ policy: AdmissionPolicy; reconciled: boolean; principal: AdmissionPrincipal | null }>(`
    WITH policy AS (${POLICY_SELECT} WHERE p.app_id = ${sql(appId)}),
      principal AS (${principalSelect(appId)} WHERE a.id = ${sql(identityUserId)}::uuid)
    SELECT policy.*, (SELECT to_jsonb(principal) FROM principal) AS principal FROM policy`);
  return evaluateAdmission(record && !record.reconciled
    ? { ...record.policy, state: 'pending' } : record?.policy, record?.principal);
}
export async function evaluateClientAdmission(clientId: string, identityUserId: string): Promise<AdmissionDecision> {
  await ensureIdentitySchema();
  const mapped = await rows<{ app_id: string | null; platform_access: boolean }>(`
    SELECT p.app_id, c.platform_access FROM admission_clients c
    LEFT JOIN admission_policies p USING (installation_id) WHERE c.client_id = ${sql(clientId)}`);
  if (mapped[0]?.platform_access) {
    const principal = (await getAdmissionPrincipals()).find(u => u.id === identityUserId);
    return { allowed: Boolean(principal?.active && !principal.deleted),
      reason: principal?.active && !principal.deleted ? 'allowed' : 'inactive_user',
      installationId: null, revision: null };
  }
  return mapped[0]?.app_id ? evaluateAppAdmission(mapped[0].app_id, identityUserId)
    : { allowed: false, reason: 'unknown_app', installationId: null, revision: null };
}
export async function clientTokenRevoked(clientId: string, userId: string, issuedAt: number): Promise<boolean> {
  await ensureIdentitySchema();
  const cutoff = await rows<{ revoked: boolean }>(`SELECT revoked_before >= to_timestamp(${sql(issuedAt)})
    AS revoked FROM admission_client_cutoffs WHERE client_id = ${sql(clientId)} AND user_id = ${sql(userId)}::uuid`);
  return Boolean(cutoff[0]?.revoked);
}

/** Reconcile reserved namespaces, including identities added while uninstalled. */
export async function reserveAppUserData(installationId: string, declare = true): Promise<void> {
  if (!isUuid(installationId)) throw new Error('Invalid installation identity');
  await ensureIdentitySchema();
  await command(`BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
    ${declare ? `INSERT INTO admission_user_data_contracts (installation_id)
      VALUES (${sql(installationId)}::uuid) ON CONFLICT DO NOTHING;` : ''}
    SELECT admission_register_user_data(id) FROM admission_principals
      WHERE EXISTS (SELECT 1 FROM admission_user_data_contracts
        WHERE installation_id = ${sql(installationId)}::uuid);
    COMMIT;`);
}

/**
 * Explicit baseline/adoption; no first-user fallback. Existing policy survives
 * updates/reinstalls. Retained data may only be reopened by its active owner.
 */
export async function ensureAppAdmission(input: {
  appId: string; actorId?: string; clientId?: string; installed?: boolean;
  adoptRetainedData?: boolean;
  /** Internal backup recovery; validated immutable bindings, never request input. */
  restoredIdentity?: { installationId: string; ownerId: string };
  routes: Array<{ host: string; pathPrefix?: string }>;
}): Promise<AdmissionPolicy> {
  if (!isAppId(input.appId) || (input.actorId && !isUuid(input.actorId))) throw new Error('Invalid installation principal');
  await ensureIdentitySchema();
  if (input.restoredIdentity) {
    assertRestoredAdmission(await getAdmissionPolicy(input.appId), input.restoredIdentity);
  }
  await command(`BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
    WITH inserted AS (INSERT INTO admission_policies (app_id, owner_id, state)
    SELECT ${sql(input.appId)}, u.id, 'ready' FROM identity_users u
    WHERE u.is_active AND u.id = ${input.actorId ? `${sql(input.actorId)}::uuid`
      : '(SELECT owner_user_id FROM identity_appliance_claim WHERE singleton)'}
    ON CONFLICT (app_id) DO NOTHING RETURNING installation_id, owner_id, revision)
    INSERT INTO admission_audit (installation_id, actor_id, action, revision, details)
    SELECT installation_id, owner_id, 'owner_only_baseline', revision, '{"mode":"owner"}'::jsonb FROM inserted;
    COMMIT;`);
  const policy = await getAdmissionPolicy(input.appId);
  if (!isAdmissionPolicy(policy)) throw new Error('Application needs owner resolution');
  if (input.restoredIdentity) assertRestoredAdmission(policy, input.restoredIdentity);
  if (policy.state === 'retained' || policy.state === 'deleted') {
    if (input.installed) throw new Error('Retained data requires a later authenticated adoption');
    const actor = input.actorId;
    if (policy.state === 'retained' && input.adoptRetainedData !== true) {
      throw new Error('Retained application data requires an explicit adoption request');
    }
    if (!actor || actor !== policy.ownerId) throw new Error('Retained application data requires explicit owner adoption');
    const reopened = await statementRows<{ installation_id: string }>(`
      changed AS (
        UPDATE admission_policies SET state = 'ready', revision = revision + 1, updated_at = now()
        WHERE installation_id = ${sql(policy.installationId)}::uuid AND state = ${sql(policy.state)}
          AND revision = ${sql(policy.revision)}
          AND EXISTS (SELECT 1 FROM identity_users WHERE id = ${sql(actor)}::uuid AND is_active)
          AND NOT EXISTS (SELECT 1 FROM admission_resources
            WHERE installation_id = ${sql(policy.installationId)}::uuid AND state = 'quarantined'
              AND NOT COALESCE(
                declaration->>'scope' = 'per_user' AND declaration->>'enforcement' = 'app_native'
                AND resource_id = 'user-data:' || private_user_id::text AND owner_id = private_user_id
                AND EXISTS (SELECT 1 FROM admission_user_data_contracts
                  WHERE installation_id = ${sql(policy.installationId)}::uuid)
                AND EXISTS (SELECT 1 FROM admission_principals a
                  WHERE a.id = private_user_id AND a.deleted_at IS NOT NULL), false))
          ${policy.state === 'deleted' ? `AND NOT EXISTS (SELECT 1 FROM admission_resources
            WHERE installation_id = ${sql(policy.installationId)}::uuid AND (
              (state <> 'deleted' AND NOT COALESCE(
                state = 'quarantined' AND declaration->>'scope' = 'per_user'
                AND declaration->>'enforcement' = 'app_native'
                AND resource_id = 'user-data:' || private_user_id::text AND owner_id = private_user_id
                AND EXISTS (SELECT 1 FROM admission_user_data_contracts
                  WHERE installation_id = ${sql(policy.installationId)}::uuid)
                AND EXISTS (SELECT 1 FROM admission_principals a
                  WHERE a.id = private_user_id AND a.deleted_at IS NOT NULL), false)) OR (
                (owner_id <> ${sql(actor)}::uuid OR (private_user_id IS NOT NULL AND private_user_id <> ${sql(actor)}::uuid))
                AND NOT COALESCE(
                  declaration->>'scope' = 'per_user' AND declaration->>'enforcement' = 'app_native'
                  AND resource_id = 'user-data:' || private_user_id::text AND owner_id = private_user_id
                  AND EXISTS (SELECT 1 FROM admission_user_data_contracts
                    WHERE installation_id = ${sql(policy.installationId)}::uuid)
                  AND EXISTS (SELECT 1 FROM admission_principals a WHERE a.id = private_user_id), false))))` : ''}
        RETURNING installation_id, revision
      ), resources AS (
        UPDATE admission_resources r SET
          state = CASE WHEN r.private_user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM admission_principals a WHERE a.id = r.private_user_id AND a.deleted_at IS NOT NULL)
            THEN 'quarantined' ELSE 'active' END,
          declaration = jsonb_set(declaration, '{state}', CASE WHEN r.private_user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM admission_principals a WHERE a.id = r.private_user_id AND a.deleted_at IS NOT NULL)
            THEN '"quarantined"'::jsonb ELSE '"active"'::jsonb END)
        WHERE installation_id IN (SELECT installation_id FROM changed) AND state = ${sql(policy.state)}
      ), audited AS (
        INSERT INTO admission_audit (installation_id, actor_id, action, revision, details)
        SELECT installation_id, ${sql(actor)}::uuid,
          ${sql(policy.state === 'retained' ? 'retained_data_adopted' : 'empty_data_reinstalled')},
          revision, '{}'::jsonb FROM changed
      )`, 'SELECT installation_id::text FROM changed');
    if (!reopened.length) throw new Error('Reinstall requires active owner and explicit data disposition');
  } else if (policy.state !== 'ready' && !(input.installed && ['pending','quarantined'].includes(policy.state))
    && !(input.restoredIdentity && policy.state === 'pending')) {
    throw new Error('Application ownership is quarantined');
  }
  for (const route of input.routes) {
    const host = route.host.toLowerCase();
    const prefix = route.pathPrefix || '/';
    if (!/^[a-z0-9.-]+$/.test(host) || !prefix.startsWith('/') || prefix.includes('?') || prefix.includes('#')) {
      throw new Error('Invalid installed route');
    }
    // A collision cannot silently move an existing route to another installation.
    await command(`INSERT INTO admission_routes (host, path_prefix, installation_id)
      VALUES (${sql(host)}, ${sql(prefix)}, ${sql(policy.installationId)}::uuid)
      ON CONFLICT (host, path_prefix) DO NOTHING`);
    const verified = await rows<{ installation_id: string }>(`SELECT installation_id::text FROM admission_routes
      WHERE host = ${sql(host)} AND path_prefix = ${sql(prefix)}`);
    if (verified[0]?.installation_id !== policy.installationId) throw new Error('Installed route belongs to another app');
  }
  if (input.clientId) {
    await command(`INSERT INTO admission_clients (client_id, installation_id)
      VALUES (${sql(input.clientId)}, ${sql(policy.installationId)}::uuid)
      ON CONFLICT (client_id) DO NOTHING`);
    const verified = await rows<{ installation_id: string }>(`SELECT installation_id::text FROM admission_clients
      WHERE client_id = ${sql(input.clientId)}`);
    if (verified[0]?.installation_id !== policy.installationId) throw new Error('Client belongs to another app');
  }
  return (await getAdmissionPolicy(input.appId))!;
}

export async function resolveAdmissionRoute(host: string, path: string): Promise<AdmissionPolicy | null> {
  await ensureIdentitySchema();
  if (!/^[a-z0-9.-]+$/.test(host) || !path.startsWith('/')) return null;
  const match = await rows<{ app_id: string }>(`
    SELECT p.app_id FROM admission_routes r JOIN admission_policies p USING (installation_id)
    WHERE r.host = ${sql(host)} AND (${sql(path)} = r.path_prefix OR r.path_prefix = '/'
      OR left(${sql(path)}, length(r.path_prefix) + 1) = r.path_prefix || '/')
    ORDER BY length(r.path_prefix) DESC LIMIT 1`);
  return match[0] ? getAdmissionPolicy(match[0].app_id) : null;
}
export async function updateAdmissionPolicy(input: {
  actorId: string; expectedRevision: number; policy: AdmissionPolicy;
}): Promise<AdmissionPolicy> {
  return withAppLifecycle(input.policy.appId, () => updateAdmissionPolicyUnderLifecycle(input));
}
async function updateAdmissionPolicyUnderLifecycle(input: {
  actorId: string; expectedRevision: number; policy: AdmissionPolicy;
}): Promise<AdmissionPolicy> {
  if (!isUuid(input.actorId) || !isAdmissionPolicy(input.policy)
    || input.expectedRevision !== input.policy.revision) throw new Error('Invalid admission policy');
  await ensureIdentitySchema();
  const p = input.policy;
  const changed = await statementRows<{ installation_id: string }>(`
    actor AS (
      SELECT id FROM identity_users WHERE id = ${sql(input.actorId)}::uuid AND is_admin AND is_active FOR UPDATE
    ), valid_owner AS (
      SELECT id FROM identity_users WHERE id = ${sql(p.ownerId)}::uuid AND is_active FOR UPDATE
    ), eligible AS (
      SELECT * FROM admission_policies WHERE app_id = ${sql(p.appId)}
        AND installation_id = ${sql(p.installationId)}::uuid
        AND revision = ${sql(input.expectedRevision)} AND state IN ('ready','quarantined')
        AND EXISTS (SELECT 1 FROM actor) AND EXISTS (SELECT 1 FROM valid_owner)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${json(p.userIds)}) ids(id)
          WHERE NOT EXISTS (SELECT 1 FROM identity_users u WHERE u.id::text = ids.id AND u.is_active))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${json(p.groupIds)}) ids(id)
          WHERE NOT EXISTS (SELECT 1 FROM admission_groups g WHERE g.id::text = ids.id AND g.deleted_at IS NULL))
      FOR UPDATE
    ), changed AS (
      UPDATE admission_policies SET owner_id = ${sql(p.ownerId)}::uuid, mode = ${sql(p.mode)},
        user_ids = ${json(p.userIds)}, group_ids = ${json(p.groupIds)}, public_access = ${sql(p.publicAccess)},
        revision = revision + 1, updated_at = now()
      WHERE installation_id IN (SELECT installation_id FROM eligible)
        AND (owner_id <> ${sql(p.ownerId)}::uuid OR mode <> ${sql(p.mode)}
          OR public_access <> ${sql(p.publicAccess)}
          OR NOT (user_ids @> ${json(p.userIds)} AND user_ids <@ ${json(p.userIds)})
          OR NOT (group_ids @> ${json(p.groupIds)} AND group_ids <@ ${json(p.groupIds)}))
      RETURNING installation_id, revision
    ), audited AS (
      INSERT INTO admission_audit (installation_id, actor_id, action, revision, details)
      SELECT installation_id, ${sql(input.actorId)}::uuid, 'policy_changed', revision,
        ${json({ mode: p.mode, ownerId: p.ownerId, userIds: p.userIds, groupIds: p.groupIds, publicAccess: p.publicAccess })}
      FROM changed
    )`, 'SELECT installation_id::text FROM eligible');
  if (!changed.length) throw new Error('Policy conflict, invalid principal, or administrator required');
  return (await getAdmissionPolicy(p.appId))!;
}
export async function saveResourceOwnership(resource: ResourceOwnership): Promise<void> {
  if (!isResourceOwnership(resource)) throw new Error('Invalid persistent resource declaration');
  await ensureIdentitySchema();
  const saved = await rows<{ resource_id: string }>(`
    INSERT INTO admission_resources (installation_id, resource_id, declaration, owner_id, private_user_id, state)
    SELECT installation_id, ${sql(resource.resourceId)}, ${json(resource)}, ${sql(resource.ownerId)}::uuid,
      ${resource.identityUserId ? `${sql(resource.identityUserId)}::uuid` : 'NULL'}, ${sql(resource.state)}
    FROM admission_policies p WHERE installation_id = ${sql(resource.installationId)}::uuid
      AND app_id = ${sql(resource.appId)} AND (
        owner_id = ${sql(resource.ownerId)}::uuid
        OR (${sql(resource.scope)} = 'per_user' AND ${sql(resource.ownerId)} = ${sql(resource.identityUserId)})
        OR EXISTS (
          SELECT 1 FROM admission_shares s WHERE s.id::text = ${sql(resource.shareId)}
            AND s.owner_id = ${sql(resource.ownerId)}::uuid AND s.deleted_at IS NULL
        ))
      AND EXISTS (SELECT 1 FROM admission_principals a WHERE a.id = ${sql(resource.ownerId)}::uuid
        AND a.active AND a.deleted_at IS NULL)
      AND (${sql(resource.identityUserId)} IS NULL OR EXISTS (
        SELECT 1 FROM admission_principals a LEFT JOIN admission_ui_mappings m ON m.identity_id = a.id
        WHERE a.id::text = ${sql(resource.identityUserId)} AND a.active AND a.deleted_at IS NULL
          AND (${sql(resource.uiUserId)} IS NULL OR m.ui_user_id::text = ${sql(resource.uiUserId)})
      ))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${json(resource.consumerIds)}) consumer(id)
        WHERE NOT EXISTS (SELECT 1 FROM admission_policies p WHERE p.installation_id::text = consumer.id))
    ON CONFLICT (installation_id, resource_id) DO UPDATE SET declaration = EXCLUDED.declaration
      WHERE admission_resources.declaration = EXCLUDED.declaration
    RETURNING resource_id`);
  if (!saved.length) throw new Error('Resource ownership mismatch; explicit disposition required');
}

export async function getAdmissionResourceOwners(appId: string): Promise<Record<string, string>> {
  await ensureIdentitySchema();
  const resources = await rows<{ resource_id: string; owner_id: string }>(`
    SELECT r.resource_id, r.owner_id::text FROM admission_resources r
    JOIN admission_policies p USING (installation_id) WHERE p.app_id = ${sql(appId)}`);
  return Object.fromEntries(resources.filter(r => r.resource_id.startsWith('volume:'))
    .map(r => [r.resource_id.slice('volume:'.length), r.owner_id]));
}
export async function setAdmissionAppEnabled(appId: string, installationId: string, enabled: boolean) {
  await ensureIdentitySchema();
  await command(`UPDATE admission_policies SET state = ${sql(enabled ? 'ready' : 'pending')},
    revision = revision + 1, updated_at = now()
    WHERE app_id = ${sql(appId)} AND installation_id = ${sql(installationId)}::uuid
      AND state = ${sql(enabled ? 'pending' : 'ready')}`);
}
