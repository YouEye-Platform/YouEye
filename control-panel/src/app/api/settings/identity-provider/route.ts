/**
 * Identity Provider Settings API
 *
 * POST /api/settings/identity-provider — Update the Authentik display name.
 * Updates youeye.yaml and the Authentik brand title.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';
import { listBrands, updateBrand } from '@/lib/authentik/client';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const authentikName = body.authentik_name;

  if (!authentikName || typeof authentikName !== 'string' || authentikName.trim().length === 0) {
    return NextResponse.json({ error: 'authentik_name is required' }, { status: 400 });
  }

  // 1. Save to youeye.yaml
  await spineClient.patchConfig({ authentik_name: authentikName.trim() });

  // 2. Update Authentik brand title
  try {
    const brands = await listBrands();
    const defaultBrand = brands.results?.find(b => b.default) || brands.results?.[0];
    if (defaultBrand) {
      await updateBrand(defaultBrand.brand_uuid, {
        branding_title: authentikName.trim(),
      });
    }
  } catch (err) {
    console.error('Failed to update Authentik brand title:', err);
    // Non-fatal — config is saved, Authentik branding will catch up on next deploy
  }

  return NextResponse.json({ success: true });
}
