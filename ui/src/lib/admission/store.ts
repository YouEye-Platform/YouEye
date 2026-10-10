import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { db, ensureSchema } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { AdmissionLeaseStore, type AdmissionDecision } from '../../../../shared/admission';

// Route bundles share one authority per process. Nothing is restored as an
// active lease from disk; CP must push against this boot's challenge.
const runtime = globalThis as typeof globalThis & { youeyeAdmissionLeases?: AdmissionLeaseStore };
export const admissionLeases = runtime.youeyeAdmissionLeases ??=
  new AdmissionLeaseStore(randomUUID(), () => performance.now());

export function evaluateLocalAdmission(appId: string, identityUserId: string): AdmissionDecision {
  return admissionLeases.evaluate(appId, identityUserId);
}
export async function evaluateUiUserAdmission(appId: string, uiUserId: string): Promise<AdmissionDecision> {
  await ensureSchema();
  const [user] = await db.select({ identityId: users.identityId }).from(users).where(eq(users.id, uiUserId)).limit(1);
  return evaluateLocalAdmission(appId, user?.identityId ?? '');
}
