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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ component: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

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
