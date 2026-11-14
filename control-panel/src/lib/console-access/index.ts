/**
 * Console access: every active YouEye ID admin has a host account on the box,
 * so a dead Control Panel never locks the owner out (Spine owns the accounts;
 * see spine/internal/consoleaccess).
 *
 * The Control Panel keeps Spine's admin set equal to YouEye ID's after every
 * identity change, at startup and periodically, and sends an admin's password
 * once when it is set (Spine stores only a hash). A Spine failure never undoes
 * an identity change: it is logged and the next sync repairs the admin set.
 * Off a sealed appliance Spine answers 409 appliance_required and this is a
 * no-op. The plaintext password is never stored or logged here.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeJsonAtomically } from '@/lib/bridges/atomic-json-store';
import { listIdentityUsers, type IdentityUser } from '@/lib/identity/store';
import { isIdentityAdmin } from '@/lib/identity/tokens';
import { SpineAPIError, spineClient, type SpineClient, type SpineConsoleStatus } from '@/lib/spine/client';

export interface ConsoleAdmin {
  user_id: string;
  username: string;
}

export interface ConsoleAccessDeps {
  listUsers: () => Promise<IdentityUser[]>;
  spine: Pick<SpineClient, 'consoleStatus' | 'syncConsoleAdmins' | 'setConsolePassword'>;
  log: (message: string) => void;
  /**
   * Users whose new password could not be delivered: their console password
   * is cleared at the next successful sync, so an old one never keeps
   * working. Only user ids are kept, never a password.
   */
  stale: { add(userId: string): Promise<void>; list(): Promise<string[]>; remove(userId: string): Promise<void> };
}

const SYNC_INTERVAL_MS = 10 * 60_000;
const STARTUP_RETRY_MS = 60_000;

/** The active YouEye ID admins, as Spine's sync expects them. */
export function consoleAdmins(users: IdentityUser[]): ConsoleAdmin[] {
  return users
    .filter(user => user.is_active && isIdentityAdmin(user))
    .map(user => ({ user_id: user.id, username: user.username }))
    .sort((a, b) => a.user_id.localeCompare(b.user_id));
}

function sameAdminSet(status: SpineConsoleStatus, admins: ConsoleAdmin[]): boolean {
  const current = status.accounts.filter(account => account.admin).map(account => account.user_id).sort();
  const wanted = admins.map(admin => admin.user_id);
  return current.length === wanted.length && current.every((id, index) => id === wanted[index]);
}

function notAppliance(error: unknown): boolean {
  return error instanceof SpineAPIError && error.statusCode === 409 && error.code === 'appliance_required';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function createConsoleAccess(deps: ConsoleAccessDeps) {
  // One sync at a time, in call order, so an older admin set never lands after a newer one.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  /** Makes Spine's admin set equal YouEye ID's. Returns the admins, or null off a sealed appliance. Throws on failure. */
  async function syncAdmins(): Promise<ConsoleAdmin[] | null> {
    let status: SpineConsoleStatus;
    try {
      status = await deps.spine.consoleStatus();
    } catch (error) {
      if (notAppliance(error)) return null;
      throw error;
    }
    const admins = consoleAdmins(await deps.listUsers());
    if (!sameAdminSet(status, admins)) await deps.spine.syncConsoleAdmins(admins);
    return admins;
  }

  /** Clears the console passwords that are out of date (Spine "" = clear and lock). */
  async function clearStale(): Promise<void> {
    for (const userId of await deps.stale.list()) {
      await deps.spine.setConsolePassword(userId, '');
      await deps.stale.remove(userId);
    }
  }

  async function markStale(userId: string): Promise<void> {
    await deps.stale.add(userId).catch(error => deps.log(`[console-access] Could not record an out-of-date console password: ${reason(error)}`));
  }

  /** Never throws; returns whether Spine's admin set is known to be current (true off an appliance). */
  function syncConsoleAdmins(): Promise<boolean> {
    return serial(async () => {
      try {
        if (await syncAdmins()) await clearStale();
        return true;
      } catch (error) {
        deps.log(`[console-access] Admin accounts were not synced; the next sync retries: ${reason(error)}`);
        return false;
      }
    });
  }

  /**
   * After a committed identity change: sync the admin set, then, when a
   * password was set for a user who is an admin now, send it as the console
   * password. Never throws.
   */
  function afterIdentityChange(change: { userId: string; password?: string }): Promise<void> {
    return serial(async () => {
      let admins: ConsoleAdmin[] | null;
      try {
        admins = await syncAdmins();
      } catch (error) {
        deps.log(`[console-access] Admin accounts were not synced; the next sync retries: ${reason(error)}`);
        if (change.password !== undefined) {
          await markStale(change.userId);
          deps.log(`[console-access] The console password for user ${change.userId} was not sent; it is cleared at the next sync and the admin can set one in Settings.`);
        }
        return;
      }
      if (!admins || change.password === undefined || !admins.some(admin => admin.user_id === change.userId)) return;
      try {
        await deps.spine.setConsolePassword(change.userId, change.password);
        await deps.stale.remove(change.userId).catch(() => undefined);
      } catch (error) {
        // The old console password must not keep working: clear it now if
        // Spine answers, else at the next sync.
        await markStale(change.userId);
        await deps.spine.setConsolePassword(change.userId, '').then(() => deps.stale.remove(change.userId)).catch(() => undefined);
        deps.log(`[console-access] The console password for user ${change.userId} was not sent (${reason(error)}); the old one was cleared and the admin can set one in Settings.`);
      }
    });
  }

  /** Startup sync (retried until it succeeds once), then a periodic one that repairs any missed change. */
  function startConsoleAccessSync(): void {
    const startup = () => void syncConsoleAdmins().then(ok => {
      if (!ok) setTimeout(startup, STARTUP_RETRY_MS).unref?.();
    });
    startup();
    setInterval(() => void syncConsoleAdmins(), SYNC_INTERVAL_MS).unref?.();
  }

  return { syncConsoleAdmins, afterIdentityChange, startConsoleAccessSync };
}

const STALE_FILE = '/var/lib/youeye/state/console-access/stale-passwords.json';

async function readStale(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(STALE_FILE, 'utf8')) as { user_ids?: unknown };
    return Array.isArray(parsed.user_ids) ? parsed.user_ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const fileStale: ConsoleAccessDeps['stale'] = {
  add: async userId => {
    const ids = new Set(await readStale());
    ids.add(userId);
    await mkdir(dirname(STALE_FILE), { recursive: true, mode: 0o700 });
    await writeJsonAtomically(STALE_FILE, { user_ids: [...ids].sort() });
  },
  list: readStale,
  remove: async userId => {
    const ids = await readStale();
    if (!ids.includes(userId)) return;
    await writeJsonAtomically(STALE_FILE, { user_ids: ids.filter(id => id !== userId) });
  },
};

const consoleAccess = createConsoleAccess({
  listUsers: () => listIdentityUsers(),
  spine: spineClient,
  log: message => console.error(message),
  stale: fileStale,
});

export const { syncConsoleAdmins, afterIdentityChange, startConsoleAccessSync } = consoleAccess;

/** Spine's rule for console passwords (root and admins): 8 to 1024 characters on one line. */
export function consolePasswordError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024 || /[\0\r\n]/.test(password)) {
    return 'The password must be 8 to 1024 characters on one line.';
  }
  return null;
}
