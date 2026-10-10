import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';

/** Old toggles cannot remove the household admission boundary. */
export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  return NextResponse.json({
    error: 'Use app access settings with the current policy revision. Public exposure is an explicit administrator setting.',
  }, { status: 409 });
}
