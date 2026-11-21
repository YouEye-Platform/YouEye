import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { lifecycleRefusalResponse } from '@/lib/http/lifecycle-busy';
import { updateSystemContainerApp } from '@/lib/apps/system-container-update';
import { CriticalIssueBlockedError } from '@/lib/health/issues';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { handleMarketUpdate } from '@/lib/market/update-http';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';

async function recordStatus(
  component: string,
  status: Parameters<typeof writeStatus>[1],
  progress: number,
  message: string,
) {
  try {
    await writeStatus(component, status, progress, message);
  } catch (error) {
    console.warn(`[settings-app-update] Failed to write update status for ${component}:`, error);
  }
}

async function markStarted(component: string) {
  try {
    await startUpdate(component, '');
  } catch (error) {
    console.warn(`[settings-app-update] Failed to start update status for ${component}:`, error);
  }
}

async function markCompleted(component: string, versionAfter = '') {
  try {
    await completeUpdate(component, '', versionAfter);
  } catch (error) {
    console.warn(`[settings-app-update] Failed to complete update status for ${component}:`, error);
  }
}

async function markFailed(component: string, message: string) {
  try {
    await failUpdate(component, '', message);
  } catch (error) {
    console.warn(`[settings-app-update] Failed to fail update status for ${component}:`, error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const { appId } = await params;
  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  if (!getAppDefinition(appId)?.lxdConfig && await getInstalledApp(appId)) {
    return handleMarketUpdate(request, appId, 'json');
  }

  const appDef = getAppDefinition(appId);
  // Spine, the Control Panel, the UI and the host (Incus, packages) update with the System release (Settings →
  // System): refused before anything is recorded as started.
  if (appDef?.updatedBy !== 'control-panel') {
    return NextResponse.json({ error: `No update handler for ${appId}` }, { status: 404 });
  }
  const component = appId;

  try {
    await markStarted(component);

    if (appDef?.lxdConfig) {
      let lastMessage = '';
      await withUserOperationLockWait(() => updateLXDApp(appDef, (event) => {
        lastMessage = event.message;
        const stageToStatus: Record<string, Parameters<typeof writeStatus>[1]> = {
          starting: 'checking',
          snapshot: 'downloading',
          stopping: 'installing',
          rebuilding: 'downloading',
          'starting-container': 'restarting',
          verifying: 'verifying',
          completed: 'completed',
          failed: 'failed',
        };
        recordStatus(
          component,
          stageToStatus[event.stage] || 'installing',
          event.progress ?? 0,
          event.message,
        );
      }));
      await markCompleted(component);
      return NextResponse.json({ status: 'success', message: lastMessage || `${appDef.displayName} updated` });
    }

    // Caddy, Pi-Hole and PostgreSQL move to the image pinned by this release
    // (lib/infrastructure/system-images), never a moving tag. Confirmations
    // come from the client dialog; the guards in the shared action are a safety net.
    if (appDef?.systemImageId) {
      const body = await request.json().catch(() => ({} as Record<string, unknown>));
      const result = await updateSystemContainerApp(appDef, body, (event) => {
        const progress = event.totalSteps > 0 ? Math.round((event.step / event.totalSteps) * 100) : 0;
        recordStatus(
          component,
          event.status === 'error' ? 'failed' : event.status === 'success' ? 'completed' : 'installing',
          progress,
          event.message,
        );
      });
      if (result.success) {
        await markCompleted(component, result.newVersion || '');
      } else {
        await markFailed(component, result.error || result.message);
      }
      return NextResponse.json(
        { status: result.success ? 'success' : 'error', message: result.message, new_version: result.newVersion },
        { status: result.success ? 200 : 400 },
      );
    }

    return NextResponse.json({ error: `No update handler for ${appId}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(component, message);
    // Refused for an open critical issue, as the system-updates route answers it.
    if (error instanceof CriticalIssueBlockedError) return NextResponse.json({ error: message, code: error.code }, { status: 423 });
    const refused = lifecycleRefusalResponse(error);
    if (refused) return refused;
    console.error(`[settings-app-update] Failed to update ${appId}:`, error);
    return NextResponse.json({ error: `Failed to update ${appId}: ${message}` }, { status: 500 });
  }
}
