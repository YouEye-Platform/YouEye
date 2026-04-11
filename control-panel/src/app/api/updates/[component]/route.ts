import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';

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
    // Write initial status to DB (Spine-managed components also get written
    // so the DB has a record — Spine's own status file is source of truth
    // for spine/control/ui, but we track the intent here)
    await startUpdate(component, '').catch(() => {});

    let result;

    switch (component) {
      case 'spine':
        result = await spineClient.updateSelf();
        break;
      case 'control':
        result = await spineClient.updateControl();
        break;
      case 'ui':
        result = await spineClient.updateUI();
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
        // Treat unknown components as app names (e.g., "caddy", "pihole")
        await writeStatus(component, 'installing', 50, `Updating ${component}...`).catch(() => {});
        result = await spineClient.updateApp(component);
        break;
    }

    // For non-Spine-managed updates (incus, system, apps), mark completed in DB
    if (!['spine', 'control', 'ui'].includes(component)) {
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
