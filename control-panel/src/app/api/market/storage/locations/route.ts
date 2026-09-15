import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { listStorageLocations } from '@/lib/market/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const locations = await listStorageLocations();
    if (locations.length === 0) {
      return NextResponse.json({ error: 'No app storage location is available' }, { status: 503 });
    }
    return NextResponse.json({ locations, defaultPool: locations.find((item) => item.internal)?.id ?? locations[0].id });
  } catch {
    return NextResponse.json({ error: 'Storage locations are unavailable' }, { status: 503 });
  }
}
