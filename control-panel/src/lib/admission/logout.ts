import { ensureIdentitySchema, identityRows as rows, identitySql as sql, enqueueLogoutDelivery } from '@/lib/identity/store';
import { createLogoutToken } from '@/lib/identity/tokens';
export async function reconcileAdmissionLogouts() {
  await ensureIdentitySchema();
  const pending = await rows<{ client_id: string; user_id: string; session_id: string; revision: number; uri: string | null; issued_at: number }>(`
    SELECT o.*, c.backchannel_logout_uri AS uri,
      floor(extract(epoch FROM cutoff.revoked_before))::bigint AS issued_at
    FROM admission_logout_outbox o
    LEFT JOIN identity_clients c USING (client_id)
    JOIN admission_client_cutoffs cutoff USING (client_id, user_id) WHERE NOT o.queued LIMIT 100`);
  for (const record of pending) {
    if (record.uri) {
      // Delivery time is not revocation time: a delayed notification must not
      // invalidate a newer authorization established after the access regrant.
      const token = await createLogoutToken(record.client_id, record.user_id, record.session_id, Number(record.issued_at));
      await enqueueLogoutDelivery({ sessionId: record.session_id, clientId: record.client_id, uri: record.uri, token,
        eventKey: `admission:${record.client_id}:${record.user_id}:${record.session_id}:${record.revision}` });
    }
    await rows(`UPDATE admission_logout_outbox SET queued = true
      WHERE client_id = ${sql(record.client_id)} AND user_id = ${sql(record.user_id)}::uuid
        AND session_id = ${sql(record.session_id)}::uuid AND revision = ${sql(record.revision)}
      RETURNING client_id`);
  }
}
