import postgres from 'postgres';

type Pool = ReturnType<typeof postgres>;
export interface PlatformDatabaseCredentials { host: string; port: string; user: string; password: string; database: string }

export interface PlatformDatabaseOptions {
  /** Callers queued behind the one connection before new ones are refused. */
  maxQueue?: number;
  /** How long a queued caller waits for the connection before failing. */
  waitTimeoutMs?: number;
  /** Driver factory; tests substitute a fake. */
  driver?: (options: postgres.Options<Record<string, never>>) => Pool;
}

/** Plenty for a browser burst (one forward-auth check per asset) on top of normal traffic. */
export const PLATFORM_DATABASE_MAX_QUEUE = 4096;
export const PLATFORM_DATABASE_WAIT_TIMEOUT_MS = 15_000;

/**
 * Each process owns exactly one connection (CP and ID: two in total), so callers
 * are serialised and queue for it. Multi-statement commands rely on running whole
 * on that one connection. The queue is deep enough for bursts; a caller that cannot
 * get the connection within the wait timeout fails with a clear error instead of
 * queueing forever. Failures never replay a command.
 */
export function createPlatformDatabase(
  credentials: () => Promise<PlatformDatabaseCredentials>,
  options: PlatformDatabaseOptions = {},
) {
  const maxQueue = options.maxQueue ?? PLATFORM_DATABASE_MAX_QUEUE;
  const waitTimeoutMs = options.waitTimeoutMs ?? PLATFORM_DATABASE_WAIT_TIMEOUT_MS;
  const driver = options.driver ?? postgres;
  const state: { pool?: Promise<Pool>; active: number; waiting: Array<() => void> } = { active: 0, waiting: [] };
  async function admit(): Promise<() => void> {
    if (state.active >= 1) {
      if (state.waiting.length >= maxQueue) {
        throw new Error(`Platform database is busy (${state.waiting.length} commands already queued)`);
      }
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = state.waiting.indexOf(ready);
          if (index >= 0) state.waiting.splice(index, 1);
          reject(new Error(`Platform database wait timed out after ${waitTimeoutMs / 1000} s `
            + `(${state.waiting.length} commands still queued)`));
        }, waitTimeoutMs);
        state.waiting.push(ready);
      });
    } else {
      state.active++;
    }
    return () => {
      const next = state.waiting.shift();
      if (next) next(); else state.active--;
    };
  }

  async function pool(): Promise<Pool> {
    if (!state.pool) {
      const pending = credentials().then(credentials => driver({
        host: credentials.host, port: Number(credentials.port),
        username: credentials.user, password: credentials.password, database: credentials.database,
        max: 1, idle_timeout: 300, connect_timeout: 10, max_lifetime: 1800,
        prepare: false, onnotice: () => {},
        connection: {
          application_name: 'youeye-platform', statement_timeout: 15000,
          idle_in_transaction_session_timeout: 15000, standard_conforming_strings: 'on',
        },
      }));
      state.pool = pending;
      void pending.catch(() => { if (state.pool === pending) state.pool = undefined; });
    }
    return state.pool;
  }

  /** Execute a trusted platform SQL command. Values must use bound parameters
   * or the identity SQL quoting helpers. Never pass user-authored SQL here.
   * Existing multi-statement migrations retain the single admitted connection. Failed
   * commands are never retried: their commit outcome may be uncertain. */
  async function command(command: string): Promise<string> {
    const release = await admit();
    let database: Pool | undefined;
    try {
      database = await pool();
      const result = await database.unsafe(command).simple().raw();
      // Simple protocol returns one result per statement. raw() preserves the
      // previous psql text contract, including JSON, dates and large integers.
      const sets = 'columns' in result ? [result] : result;
      return sets.flatMap(set => Array.from(set, row => row.map(value => value?.toString() ?? '').join('|'))).join('\n').trim();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      const disconnected = !/^[0-9A-Z]{5}$/.test(code) || /^(08|28|57)/.test(code);
      if (database && !disconnected) {
        try { await database.unsafe('ROLLBACK').simple(); } catch { /* disconnected */ }
      }
      // Refresh credentials/address on the next call after transport/auth failure.
      // Draining the old pool avoids overlapping generations and excess slots.
      if (database && disconnected) {
        const current = state.pool;
        if (current && await current === database) {
          await database.end({ timeout: 1 });
          if (state.pool === current) state.pool = undefined;
        }
      }
      // Driver errors can contain SQL values and connection details.
      throw new Error(`Platform database command failed${/^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ''}`);
    } finally {
      release();
    }
  }

  return { command, async close() { const current = state.pool; state.pool = undefined; if (current) await (await current).end({ timeout: 20 }); } };
}
