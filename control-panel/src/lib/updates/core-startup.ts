import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

const reservationPath = '/var/lib/youeye/state/app-updates/core-reservation.json';

/** A malformed/unavailable retained reservation is maintenance, never ready. */
export function coreStartupHeld(filename = reservationPath): boolean {
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return true;
    // Presence itself holds startup. Parse only to reject malformed documents
    // consistently; no stale timestamp or PID can authorize background writers.
    JSON.parse(readFileSync(fd, 'utf8'));
    return true;
  } catch { return true; }
  finally { closeSync(fd); }
}

const startupKey = Symbol.for('youeye.core-startup-deferred');
const state = globalThis as typeof globalThis & { [startupKey]?: boolean };

/** Serve native health while mutation-producing background jobs stay deferred.
 * Successful commit/recovery removes the host-owned hold; startup then runs once.
 * This does not clear reservations or repeat an update/migration operation. */
export function deferCoreStartup(start: () => Promise<void>): boolean {
  if (!coreStartupHeld()) return false;
  if (!state[startupKey]) {
    state[startupKey] = true;
    const timer = setInterval(() => {
      if (coreStartupHeld()) return;
      clearInterval(timer);
      state[startupKey] = false;
      void start().catch(() => console.error('[startup] Deferred platform startup failed; retained lifecycle evidence is unchanged'));
    }, 2000);
    timer.unref();
  }
  return true;
}
