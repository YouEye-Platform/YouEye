import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getBridgeToken } from '@/lib/admin/bridge-client';
import { admissionLeases } from '@/lib/admission/store';
import { db, ensureSchema } from '@/db';
import { users, admissionProjections, identityDeletions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { isAdmissionPolicy, isAdmissionPrincipal, type AdmissionProjection } from '../../../../../../shared/admission';

export const dynamic = 'force-dynamic';
function authenticated(request: NextRequest): boolean {
  const expected = getBridgeToken();
  const supplied = request.headers.get('X-UI-Bridge-Token');
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function GET(request: NextRequest) {
  if (!authenticated(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ schemaVersion: 1, challenge: admissionLeases.challenge }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  if (!authenticated(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const payload: AdmissionProjection = await request.json();
  if (!isAdmissionPolicy(payload?.policy) || !Array.isArray(payload.principals)
    || !payload.principals.every(isAdmissionPrincipal)) {
    return NextResponse.json({ error: 'invalid_projection' }, { status: 400 });
  }
  await ensureSchema();
  const tombstones = await db.select().from(identityDeletions);
  if (payload.principals.some(p => !p.deleted && tombstones.some(t => t.identityId === p.id))) {
    return NextResponse.json({ error: 'deleted_identity_reuse' }, { status: 409 });
  }
  // Exact subject mapping only. Display names/email cannot adopt another
  // identity's UI data. Deleted identities remain in the projection as tombstones.
  const mappings = await db.select({ id: users.id, identityId: users.identityId }).from(users);
  if (payload.principals.some(principal => principal.uiUserId
    && mappings.find(user => user.identityId === principal.id)?.id !== principal.uiUserId)) {
    return NextResponse.json({ error: 'immutable_ui_mapping_conflict' }, { status: 409 });
  }
  payload.principals = payload.principals.map(principal => ({
    ...principal, uiUserId: mappings.find(user => user.identityId === principal.id)?.id ?? null,
  }));
  if (!admissionLeases.apply(payload)) {
    return NextResponse.json({ error: 'stale_or_invalid_lease', challenge: admissionLeases.challenge }, { status: 409 });
  }
  const deleted = payload.principals.filter(p => p.deleted).map(p => ({ identityId: p.id }));
  if (deleted.length) await db.insert(identityDeletions).values(deleted).onConflictDoNothing();
  await db.insert(admissionProjections).values({
    appId: payload.policy.appId, installationId: payload.policy.installationId,
    revision: String(payload.policy.revision), snapshot: payload,
  }).onConflictDoUpdate({ target: admissionProjections.appId, set: {
    installationId: payload.policy.installationId, revision: String(payload.policy.revision), snapshot: payload,
  } });
  return NextResponse.json({
    installationId: payload.policy.installationId, revision: payload.policy.revision,
    sequence: payload.sequence, challenge: admissionLeases.challenge,
    mappings: payload.principals.filter(u => u.uiUserId).map(u => ({ identityId: u.id, uiUserId: u.uiUserId })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
