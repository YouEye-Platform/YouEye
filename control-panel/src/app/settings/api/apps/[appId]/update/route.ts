import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { spineClient } from '@/lib/spine/client';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { updateOCIApp } from '@/lib/apps/updater';
import { updateSystemFromMarket } from '@/lib/infrastructure/system-updater';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { updateMarketplaceApp } from '@/lib/market/updater';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';

function statusComponentFor(appId: string): string {
  if (appId === 'control-panel') return 'control';
  if (appId === 'host-system') return 'system';
  return appId;
}

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

  const component = statusComponentFor(appId);

  try {
    await markStarted(component);

    const appDef = getAppDefinition(appId);
    if (appDef?.lxdConfig) {
      let lastMessage = '';
      await updateLXDApp(appDef, (event) => {
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
      });
      await markCompleted(component);
      return NextResponse.json({ status: 'success', message: lastMessage || `${appDef.displayName} updated` });
    }

    const installedApp = await getInstalledApp(appId);
    if (installedApp) {
      let lastMessage = '';
      const result = await updateMarketplaceApp({ appId, force: true }, (event) => {
        lastMessage = event.message;
        const progress = event.totalSteps > 0
          ? Math.round((event.step / event.totalSteps) * 100)
          : 0;
        recordStatus(
          component,
          event.status === 'error' ? 'failed' : 'installing',
          progress,
          event.message,
        );
      });
      if (result.success) {
        await markCompleted(component, result.newVersion || '');
      } else {
        await markFailed(component, result.error || 'Update failed');
      }
      return NextResponse.json({
        status: result.success ? 'success' : 'error',
        message: lastMessage || (result.success ? `${appId} updated` : result.error || 'Update failed'),
        previous_version: result.previousVersion,
        new_version: result.newVersion,
      }, { status: result.success ? 200 : 500 });
    }

    // Market system apps (Caddy/Pi-Hole/Postgres) update through the pinned
    // Market system manifests, NOT the moving-tag OCI rebuild. Confirmations
    // come from the client dialog; the guards below are a safety net.
    if (appDef?.marketSystemId) {
      const body = await request.json().catch(() => ({} as Record<string, unknown>));
      let lastMessage = '';
      const result = await updateSystemFromMarket(
        {
          systemId: appDef.marketSystemId,
          hostIP: process.env.HOST_IP || '',
          confirmMaintenanceWindow: body.confirmMaintenanceWindow === true,
          confirmContainerName:
            typeof body.confirmContainerName === 'string' ? body.confirmContainerName : undefined,
          allowDatabaseUpdate: body.allowDatabaseUpdate === true,
        },
        (event) => {
          lastMessage = event.message;
          const progress = event.totalSteps > 0 ? Math.round((event.step / event.totalSteps) * 100) : 0;
          recordStatus(
            component,
            event.status === 'error' ? 'failed' : event.status === 'success' ? 'completed' : 'installing',
            progress,
            event.message,
          );
        },
      );
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

    if (appDef?.updatedBy === 'control-panel') {
      let lastMessage = '';
      await updateOCIApp(appDef, (event) => {
        lastMessage = event.message;
        recordStatus(
          component,
          event.stage === 'failed' ? 'failed' : event.stage === 'completed' ? 'completed' : 'installing',
          event.progress ?? 0,
          event.message,
        );
      });
      await markCompleted(component);
      return NextResponse.json({ status: 'success', message: lastMessage || `${appDef.displayName} updated` });
    }

    let result;
    switch (appId) {
      case 'spine':
        await recordStatus(component, 'downloading', 20, 'Downloading Spine update...');
        result = await spineClient.updateSelf();
        break;
      case 'control-panel':
        await recordStatus(component, 'downloading', 20, 'Downloading Control Panel update...');
        result = await spineClient.updateControl();
        break;
      case 'incus':
        await recordStatus(component, 'installing', 30, 'Updating Incus...');
        result = await spineClient.updateIncus();
        break;
      case 'host-system':
        await recordStatus(component, 'installing', 30, 'Updating system packages...');
        result = await spineClient.updateSystem();
        break;
      default:
        return NextResponse.json({ error: `No update handler for ${appId}` }, { status: 404 });
    }

    if (!['spine', 'control'].includes(component)) {
      await markCompleted(component, result.new_version || '');
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(component, message);
    console.error(`[settings-app-update] Failed to update ${appId}:`, error);
    return NextResponse.json({ error: `Failed to update ${appId}: ${message}` }, { status: 500 });
  }
}
