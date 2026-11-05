import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!session.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!(await verifyCSRFToken(csrfToken ?? ''))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { name } = await params;
    if (!/^[a-z0-9-]+$/.test(name)) {
      return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });
    }
    const body = await request.json().catch(() => null);
    if (typeof body?.autoRestart !== 'boolean') {
      return NextResponse.json({ error: 'autoRestart must be a boolean' }, { status: 400 });
    }

    const metadata = await readInstallMetadata(name);
    if (!metadata) return NextResponse.json({ error: 'Installed app not found' }, { status: 404 });
    metadata.autoRestart = body.autoRestart;
    await saveInstallMetadata(metadata);
    return NextResponse.json({ appId: name, autoRestart: metadata.autoRestart });
  } catch (error) {
    console.error('[health-policy] Failed to update app recovery policy:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update automatic recovery' },
      { status: 500 },
    );
  }
}
