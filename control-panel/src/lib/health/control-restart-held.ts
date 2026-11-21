/**
 * A Control Panel restart never cuts a platform backup or restore off (Spine, internal/api/control_restart.go): it
 * waits for the end, however long that takes. One that hangs therefore keeps the restart waiting for ever, and what
 * asked for the restart (a new address, new sign-in clients) is not in effect meanwhile. Spine says since when a
 * restart has waited past its longest wait (six hours) under a backup or restore; the health monitor turns that
 * into an issue the owner sees, and resolves it when the restart is made or the backup has ended.
 *
 * This runs in the Control Panel's process, which is the one that holds the backup: it is alive while one hangs.
 */

export const CONTROL_RESTART_HELD_ISSUE = 'control-panel.restart.held-by-backup';

export interface ControlRestartStatus {
  waiting?: boolean;
  waiting_since?: string;
  backup_held_since?: string;
}

interface Issues {
  observeIssue(input: {
    id: string; severity: 'warning'; source: string; title: string; body: string; fixable: boolean; debounce: number;
  }): Promise<unknown>;
  resolveIssue(id: string): Promise<void>;
}

/** What the owner reads. */
export const CONTROL_RESTART_HELD_COPY = {
  title: 'A backup or restore has not finished',
  body: 'The Control Panel has to restart to apply a change, and for more than six hours it has waited for a backup or restore that is still running. '
    + 'The change (for example a new address or new sign-in settings) is not in effect until then. '
    + 'If no backup or restore should be running any more, restart the box: the Control Panel then restarts and applies the change.',
};

/**
 * Raises or resolves the issue from Spine's answer. A Spine that cannot be asked (or is older than the route's GET)
 * changes nothing: the issue is neither raised nor resolved on no evidence.
 */
export async function syncControlRestartHeldIssue(
  readStatus: () => Promise<ControlRestartStatus>,
  issues?: Issues,
): Promise<void> {
  let status: ControlRestartStatus;
  try {
    status = await readStatus();
  } catch {
    return;
  }
  if (!status || typeof status !== 'object' || typeof status.waiting !== 'boolean') return;
  const { observeIssue, resolveIssue } = issues ?? await import('./issues');
  if (status.waiting && typeof status.backup_held_since === 'string' && status.backup_held_since !== '') {
    await observeIssue({
      id: CONTROL_RESTART_HELD_ISSUE, severity: 'warning', source: 'health-monitor',
      ...CONTROL_RESTART_HELD_COPY, fixable: false, debounce: 1,
    });
  } else {
    await resolveIssue(CONTROL_RESTART_HELD_ISSUE);
  }
}
