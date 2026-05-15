/**
 * Per-App Update Check
 *
 * POST /api/apps/[name]/check-update
 *
 * Triggers a fresh digest check for a single app and returns the result.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getAppDefinition } from '@/lib/apps/definitions';
import { refreshAppUpdate } from '@/lib/apps/update-cache';
import { checkLxdAppUpdate, clearLxdUpdateCache } from '@/lib/apps/lxd-updates';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  const appDef = getAppDefinition(name);
  if (!appDef) {
    return NextResponse.json({ error: 'App not found' }, { status: 404 });
  }

  try {
    // LXD apps: check via Gitea releases
    if (appDef.lxdConfig && appDef.containers.length > 0) {
      clearLxdUpdateCache(name); // force fresh check
      const result = await checkLxdAppUpdate(appDef);
      return NextResponse.json(result);
    }

    // OCI apps: check via digest comparison
    if (appDef.imageRef) {
      const result = await refreshAppUpdate(name);
      return NextResponse.json(result);
    }

    return NextResponse.json({ appId: name, hasUpdate: false, message: 'No update mechanism for this app' });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Check failed' },
      { status: 502 }
    );
  }
}
