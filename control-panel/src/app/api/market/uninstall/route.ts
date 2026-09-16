/**
 * Unified Market uninstall API.
 * Removes an installed app (Market-installed or native) and all its resources.
 *
 * POST /api/market/uninstall
 * Body: { appId, keepData?: boolean }
 *
 * keepData = true (default): removes container, Caddy route, identity provider entries, DNS
 *                              but preserves volume data for reinstall
 * keepData = false:            removes everything including data volumes and shared DB
 */

import { NextRequest, NextResponse } from 'next/server';
import { uninstallApp } from '@/lib/market/uninstaller';
import { emitEvent } from '@/lib/events/emitter';
import { requireAdmin } from '@/lib/auth/rbac';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  let body: { appId?: string; keepData?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.appId) {
    return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
  }

  try {
    const keepData = body.keepData ?? true;

    // Determine if we should drop shared database
    let dropSharedDatabase = false;
    if (!keepData) {
      try {
        const { fetchManifest } = await import('@/lib/market/catalog');
        const manifest = await fetchManifest(body.appId);
        dropSharedDatabase = manifest.uninstall?.dropSharedDatabase ?? false;
      } catch {
        // Manifest fetch failed — proceed without dropping shared DB
      }
    }

    const result = await uninstallApp(body.appId, {
      dropSharedDatabase,
      keepData,
    });
    if (result.success) {
      emitEvent('app.uninstalled', { appId: body.appId, keepData });
    }
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch (err) {
    return NextResponse.json(
      { success: false, errors: [String(err)] },
      { status: 500 }
    );
  }
}
