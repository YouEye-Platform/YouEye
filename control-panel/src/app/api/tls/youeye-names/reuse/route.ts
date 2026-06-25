/**
 * GET /api/tls/youeye-names/reuse
 *
 * Reports whether a YouEye Names reuse bundle has been staged for import
 * (placed by the installer's --names-bundle flag). The setup screen uses this
 * to lock the address to the existing name instead of generating a new one.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStagedBundle } from '@/lib/youeye-names/bundle';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const bundle = await getStagedBundle();
  return NextResponse.json({ reuse: !!bundle, name: bundle?.name ?? null });
}
