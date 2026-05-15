import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp } from '@/lib/apps/lxd-updater';

// POST /api/updates/[component] - Trigger update for a component
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ component: string }> }
) {
  // Authentication check
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // CSRF token verification
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json(
      { error: 'Invalid CSRF token' },
      { status: 403 }
    );
  }

  // Admin check - only admins can trigger updates
  if (!session.isAdmin) {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    );
  }

  const { component } = await params;

  try {
    await startUpdate(component, '').catch(() => {});

    // UI is an LXD app updated by the Control Panel directly
    if (component === 'ui') {
      const appDef = getAppDefinition('ui');
      if (!appDef) {
        return NextResponse.json({ error: 'UI app definition not found' }, { status: 500 });
      }
      let lastEvent: { message?: string } = {};
      await updateLXDApp(appDef, (event) => { lastEvent = event; });
      await completeUpdate(component, '', '').catch(() => {});
      return NextResponse.json({
        status: 'success',
        message: lastEvent.message || 'UI updated',
      });
    }

    let result;

    switch (component) {
      case 'spine':
        result = await spineClient.updateSelf();
        break;
      case 'control':
        result = await spineClient.updateControl();
        break;
      case 'incus':
        await writeStatus(component, 'installing', 50, 'Updating Incus...').catch(() => {});
        result = await spineClient.updateIncus();
        break;
      case 'system':
        await writeStatus(component, 'installing', 50, 'Updating system packages...').catch(() => {});
        result = await spineClient.updateSystem();
        break;
      default:
        await writeStatus(component, 'installing', 50, `Updating ${component}...`).catch(() => {});
        result = await spineClient.updateApp(component);
        break;
    }

    // For non-Spine-managed updates, mark completed in DB
    if (!['spine', 'control'].includes(component)) {
      const newVer = result.new_version || '';
      await completeUpdate(component, '', newVer).catch(() => {});
    }

    return NextResponse.json(result);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    await failUpdate(component, '', errMsg).catch(() => {});

    console.error(`Failed to update ${component}:`, error);
    return NextResponse.json(
      { error: `Failed to update ${component}: ${errMsg}` },
      { status: 500 }
    );
  }
}
