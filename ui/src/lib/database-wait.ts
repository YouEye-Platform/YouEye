/**
 * Waiting for the database at process start.
 *
 * After a reboot the dashboard's container can start a few seconds before the Postgres container answers. A
 * start-up probe that fails once would fail the Next.js instrumentation hook, and Next.js then answers every
 * request with that error for the life of the process while the service still counts as running. So the probe is
 * repeated while the failure only says "not reachable yet", for a bounded time.
 */

/** Errors that mean the database cannot be reached yet (the network, the socket, or Postgres still starting). */
const UNREACHABLE = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED',
  '57P03', // cannot_connect_now: Postgres is starting up
]);

export function isDatabaseUnreachable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && UNREACHABLE.has(code)) return true;
    const errors = (current as { errors?: unknown }).errors; // AggregateError of a dual-stack connect
    if (Array.isArray(errors) && errors.some((inner) => isDatabaseUnreachable(inner))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface DatabaseWait {
  /** How long to keep trying (default 2 minutes). */
  deadlineMs?: number;
  /** Pause between attempts (default 2 s). */
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `probe` until it succeeds. A failure that says the database is not reachable yet is retried until the
 * deadline; any other failure, and the last unreachable one, is thrown as it is.
 */
export async function waitForDatabase(probe: () => Promise<unknown>, options: DatabaseWait = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? 120_000);
  for (;;) {
    try {
      await probe();
      return;
    } catch (error) {
      if (!isDatabaseUnreachable(error) || now() >= deadline) throw error;
      await sleep(options.pauseMs ?? 2_000);
    }
  }
}
