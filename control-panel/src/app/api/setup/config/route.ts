/**
 * Setup Config API
 * 
 * GET /api/setup/config - Read youeye.yaml config from Spine
 * PUT /api/setup/config - Write youeye.yaml config to Spine
 * PATCH /api/setup/config - Partially update youeye.yaml config
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { settingsService } from '@/lib/settings';

export async function GET() {
  // Public endpoint - no auth required
  // Used by setup wizard to check if setup is completed
  try {
    const config = await settingsService.getRaw();
    return NextResponse.json(config);
  } catch {
    // Return defaults if Spine config endpoint not available
    return NextResponse.json({
      site_name: 'YouEye',
      domain: '',
      subdomains: { control: 'control', auth: 'auth', dns: 'dns' },
      setup_completed: false,
    });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    // BUG-003 fix: use patchConfig instead of setConfig to preserve other fields
    await settingsService.setRaw(body);
    const result = await settingsService.getRaw();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save config' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    await settingsService.setRaw(body);
    const result = await settingsService.getRaw();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update config' },
      { status: 500 }
    );
  }
}
