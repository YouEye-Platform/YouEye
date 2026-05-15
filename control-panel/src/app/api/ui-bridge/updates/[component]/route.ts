/**
 * UI Bridge: Trigger Component Update
 *
 * POST /api/ui-bridge/updates/[component]
 *
 * Triggers an update for a specific component.
 * UI updates are handled directly by the Control Panel via lxd-updater.
 * Spine-managed components (spine, control, incus, system) go through Spine API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { updateMarketplaceApp } from '@/lib/market/updater';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ component: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { component } = await params;

  try {
    await startUpdate(component, '').catch(() => {});

    // Check if this is an LXD native app (UI, Search, Cinema, Weather, etc.)
    const appDef = getAppDefinition(component);
    if (appDef?.lxdConfig) {
      let lastMessage = '';
      await updateLXDApp(appDef, (event) => {
        lastMessage = event.message;
        const stageToStatus: Record<string, string> = {
          starting: 'checking', snapshot: 'downloading', stopping: 'installing',
          rebuilding: 'downloading', 'starting-container': 'restarting',
          verifying: 'verifying', completed: 'completed', failed: 'failed',
        };
        const status = (stageToStatus[event.stage] || 'installing') as Parameters<typeof writeStatus>[1];
        writeStatus(component, status, event.progress ?? 0, event.message).catch(() => {});
      });
      await completeUpdate(component, '', '').catch(() => {});
      return NextResponse.json({
        status: 'success',
        message: lastMessage || `${appDef.displayName} updated`,
      });
    }

    // Check if this is a marketplace-installed app (native apps like Weather, Notes, etc.)
    const installedApp = await getInstalledApp(component);
    if (installedApp) {
      let lastMessage = '';
      const result = await updateMarketplaceApp(
        { appId: component, force: true },
        (event) => {
          lastMessage = event.message;
          const progress = event.totalSteps > 0
            ? Math.round((event.step / event.totalSteps) * 100)
            : 0;
          const status = event.status === 'error'
            ? 'failed' as const
            : 'installing' as const;
          writeStatus(component, status, progress, event.message).catch(() => {});
        }
      );
      const newVer = result.newVersion || '';
      if (result.success) {
        await completeUpdate(component, '', newVer).catch(() => {});
      } else {
        await failUpdate(component, '', result.error || 'Update failed').catch(() => {});
      }
      return NextResponse.json({
        status: result.success ? 'success' : 'error',
        message: lastMessage || `${component} updated to v${newVer}`,
        previous_version: result.previousVersion,
        new_version: newVer,
      });
    }

    let result;

    switch (component) {
      case 'spine':
        await writeStatus(component, 'downloading', 20, 'Downloading Spine update...').catch(() => {});
        result = await spineClient.updateSelf();
        break;
      case 'control':
        await writeStatus(component, 'downloading', 20, 'Downloading Control Panel update...').catch(() => {});
        result = await spineClient.updateControl();
        break;
      case 'incus':
        await writeStatus(component, 'installing', 30, 'Updating Incus...').catch(() => {});
        result = await spineClient.updateIncus();
        break;
      case 'system':
      case 'host-system':
        await writeStatus(component, 'installing', 30, 'Updating system packages...').catch(() => {});
        result = await spineClient.updateSystem();
        break;
      default:
        await writeStatus(component, 'installing', 30, `Updating ${component}...`).catch(() => {});
        result = await spineClient.updateApp(component);
        break;
    }

    if (!['spine', 'control'].includes(component)) {
      const newVer = result.new_version || '';
      await completeUpdate(component, '', newVer).catch(() => {});
    }

    return NextResponse.json(result);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    await failUpdate(component, '', errMsg).catch(() => {});

    console.error(`[UI Bridge] Failed to update ${component}:`, error);
    return NextResponse.json(
      { error: `Failed to update ${component}: ${errMsg}` },
      { status: 500 }
    );
  }
}
