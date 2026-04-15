/**
 * UI Bridge: Per-app Backup & Restore
 *
 * GET  /api/ui-bridge/backup/app/[appId] — get backup history for a specific app
 * POST /api/ui-bridge/backup/app/[appId] — trigger a per-app backup
 *
 * Validates X-UI-Bridge-Token header.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import { readInstallMetadata } from '@/lib/market/metadata';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { appId } = await params;

  try {
    // Verify app exists
    const meta = await readInstallMetadata(appId);
    if (!meta) {
      return NextResponse.json({ error: 'App not found' }, { status: 404 });
    }

    // Get backup history for this app
    let backups: unknown[] = [];
    try {
      const index = await spineClient.getBackupList('app', appId);
      backups = index.apps?.[appId] || [];
    } catch {
      backups = [];
    }

    return NextResponse.json({
      appId,
      metadata: {
        subdomain: meta.subdomain,
        domain: meta.domain,
        installedVersion: meta.installedVersion,
        containers: meta.containers,
      },
      backups,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch app backup data: ${err}` },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { appId } = await params;

  let body: { targetPath?: string; passphrase?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.targetPath || !body.passphrase) {
    return NextResponse.json(
      { error: 'Missing required fields: targetPath, passphrase' },
      { status: 400 }
    );
  }

  // Verify app exists
  const meta = await readInstallMetadata(appId);
  if (!meta) {
    return NextResponse.json({ error: 'App not found' }, { status: 404 });
  }

  // Redirect to the SSE backup endpoint — the UI should connect to
  // /api/backup/app/{appId} directly for SSE streaming.
  // This POST just validates and returns the endpoint URL.
  return NextResponse.json({
    status: 'ok',
    stream_url: `/api/backup/app/${appId}`,
    message: 'Use the stream_url endpoint with POST for SSE backup progress',
  });
}
