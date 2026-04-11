/**
 * Unified App Market uninstall API.
 * Removes an installed app (marketplace or native) and all its resources.
 *
 * POST /api/market/uninstall
 * Body: { appId, keepData?: boolean }
 *
 * keepData = true (default):  removes container, Caddy route, Authentik, DNS
 *                              but preserves volume data for reinstall
 * keepData = false:            removes everything including data volumes and shared DB
 */

import { NextRequest, NextResponse } from 'next/server';
import { uninstallApp } from '@/lib/market/uninstaller';

export async function POST(request: NextRequest) {
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
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, errors: [String(err)] },
      { status: 500 }
    );
  }
}
