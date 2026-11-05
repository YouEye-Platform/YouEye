import { readFileSync } from 'node:fs';
import { getAdmissionSnapshot } from './store';
import { ensureIdentitySchema, identityRows as rows, identitySql as sql } from '@/lib/identity/store';
import type { AdmissionProjection } from '../../../../shared/admission';
import { isAdmissionPolicy, isUuid } from '../../../../shared/admission';

function bridgeToken(): string | null {
  try { return readFileSync('/etc/youeye/ui-bridge-token', 'utf8').trim(); }
  catch { return process.env.UI_BRIDGE_TOKEN || null; }
}
let running: Promise<void> | null = null;
export async function reconcileAdmissionProjections(): Promise<void> {
  if (running) return running;
  running = reconcile();
  try { await running; } finally { running = null; }
}
async function reconcile() {
  await ensureIdentitySchema();
  const { reconcileAdmissionLogouts } = await import('./logout');
  await reconcileAdmissionLogouts();
  const token = bridgeToken();
  if (!token) throw new Error('Admission bridge is not configured');
  const base = process.env.UI_INTERNAL_URL || 'http://youeye-ui.youeye:3000';
  const headers = { 'X-UI-Bridge-Token': token, 'Content-Type': 'application/json' };
  const challengeResponse = await fetch(`${base}/api/ui-bridge/admission`, {
    headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!challengeResponse.ok) throw new Error(`Admission bridge challenge failed (${challengeResponse.status})`);
  const { challenge, schemaVersion } = await challengeResponse.json();
  if (schemaVersion !== 1 || !isUuid(challenge)) throw new Error('Unsupported admission bridge');
  const pending = await rows<{ app_id: string }>(`
    SELECT app_id FROM admission_policies ORDER BY app_id`);
  for (const { app_id: appId } of pending) {
    const snapshot = await getAdmissionSnapshot(appId);
    const policy = snapshot?.policy;
    if (!isAdmissionPolicy(policy)) continue;
    const principals = snapshot!.principals;
    // Reservation is conditional on the snapshot's revision. A stale load can
    // neither issue a new lease nor extend the revocation propagation window.
    const [reservation] = await rows<{ sequence: number; issued: number; expires: number }>(`
      UPDATE admission_outbox SET lease_sequence = lease_sequence + 1, lease_expires_at = now() + interval '60 seconds'
      WHERE installation_id = ${sql(policy.installationId)}::uuid AND revision = ${sql(policy.revision)}
      RETURNING lease_sequence AS sequence, floor(extract(epoch FROM now()) * 1000)::bigint AS issued,
        floor(extract(epoch FROM lease_expires_at) * 1000)::bigint AS expires`);
    if (!reservation) continue;
    const payload: AdmissionProjection = {
      schemaVersion: 1, challenge, policy, principals, sequence: Number(reservation.sequence),
      issuedAt: Number(reservation.issued), expiresAt: Number(reservation.expires),
    };
    try {
      const response = await fetch(`${base}/api/ui-bridge/admission`, {
        method: 'POST', headers, body: JSON.stringify(payload), cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Projection rejected (${response.status})`);
      const ack = await response.json();
      if (ack.challenge !== challenge || ack.installationId !== policy.installationId
        || ack.revision !== policy.revision || ack.sequence !== payload.sequence) throw new Error('Projection acknowledgement mismatch');
      if (!Array.isArray(ack.mappings)) throw new Error('Missing principal mapping acknowledgement');
      for (const mapping of ack.mappings) {
        if (!isUuid(mapping.identityId) || !isUuid(mapping.uiUserId)
          || !principals.some(p => p.id === mapping.identityId)) throw new Error('Invalid principal mapping');
        const bound = await rows<{ ui_user_id: string }>(`
          INSERT INTO admission_ui_mappings (identity_id, ui_user_id)
          VALUES (${sql(mapping.identityId)}::uuid, ${sql(mapping.uiUserId)}::uuid)
          ON CONFLICT (identity_id) DO UPDATE SET ui_user_id = EXCLUDED.ui_user_id
            WHERE admission_ui_mappings.ui_user_id = EXCLUDED.ui_user_id RETURNING ui_user_id::text`);
        if (!bound.length) throw new Error('Immutable principal mapping conflict');
      }
      await rows(`UPDATE admission_outbox SET acknowledged_revision = ${sql(policy.revision)}, last_error = NULL
        WHERE installation_id = ${sql(policy.installationId)}::uuid AND revision = ${sql(policy.revision)}
        RETURNING installation_id`);
    } catch {
      await rows(`UPDATE admission_outbox SET last_error = 'UI projection pending', updated_at = now()
        WHERE installation_id = ${sql(policy.installationId)}::uuid AND revision = ${sql(policy.revision)}
        RETURNING installation_id`);
    }
  }
}
export async function admissionReconciliationState(appId?: string): Promise<'applied' | 'pending'> {
  await ensureIdentitySchema();
  const pending = await rows<{ app_id: string }>(`
    SELECT p.app_id FROM admission_outbox o JOIN admission_policies p USING (installation_id)
    WHERE o.acknowledged_revision <> o.revision ${appId ? `AND p.app_id = ${sql(appId)}` : ''}`);
  return pending.length ? 'pending' : 'applied';
}
export function startAdmissionProjectionLoop() {
  const run = () => void reconcileAdmissionProjections().catch(() => {
    console.warn('[admission] UI projection pending; unknown and expired leases deny locally');
  });
  run();
  return setInterval(run, 20_000);
}
