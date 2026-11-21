/**
 * The update action of a system container (Caddy, Pi-hole, PostgreSQL): a rebuild on the image pinned by this
 * release (lib/infrastructure/system-images), never a moving tag. Shared by `POST /api/apps/<id>/update` (stream,
 * the `youeye` CLI) and `POST /settings/api/apps/<id>/update` (JSON, Settings → Apps and the dashboard's Apps page),
 * so both ask for the same acknowledgements and hold the same locks.
 */

import { type AppDefinition } from './definitions';
import { assertNoCriticalIssues } from '@/lib/health/issues';
import { updateSystemContainer, type SystemUpdateResult } from '@/lib/infrastructure/system-updater';
import type { DeploymentEvent } from '@/lib/infrastructure/types';
import { withPlatformLifecycle, withUserOperationLockWait } from '@/lib/market/update-admission';

export async function updateSystemContainerApp(
  appDef: AppDefinition,
  body: Record<string, unknown>,
  onEvent: (event: DeploymentEvent) => void,
): Promise<SystemUpdateResult> {
  const systemId = appDef.systemImageId;
  if (!systemId) throw new Error(`${appDef.displayName} is not a system container`);
  // The update may repair the container itself: its own "down" (or crash-loop) issue does not block it.
  await assertNoCriticalIssues('Pool/system operation', undefined, [
    `service.${appDef.id}.down`, ...appDef.containers.map((container) => `container.${container.name}.crash-loop`),
  ]);
  // A rebuild stops and recreates a critical container: it holds the platform lifecycle, so a System update and
  // Spine's Control Panel restart wait for it instead of cutting it off midway. The acknowledgements come from the
  // caller (the client's dialog); updateSystemContainer refuses without them.
  return withUserOperationLockWait(() => withPlatformLifecycle(() => updateSystemContainer(
    {
      systemId,
      hostIP: process.env.HOST_IP || '',
      confirmMaintenanceWindow: body.confirmMaintenanceWindow === true,
      confirmContainerName:
        typeof body.confirmContainerName === 'string' ? body.confirmContainerName : undefined,
      allowDatabaseUpdate: body.allowDatabaseUpdate === true,
    },
    onEvent,
  )));
}
