/**
 * Short in-process caches for Caddy forward-auth.
 *
 * A browser opening an app fires one forward-auth check per asset, often more
 * than a hundred at once. Without these caches every check ran several platform
 * database queries on the process's single connection. Entries live for 10 s at
 * most and are bounded (LRU). Concurrent misses for the same key share one load;
 * failed loads are never cached.
 *
 * Invalidation: session revocation, sign-out-everywhere and admission policy
 * changes call clearForwardAuthCaches() in the process that performs them. A
 * change made by another process (or anything else, such as deactivating a user)
 * takes effect when the entry expires, so within FORWARD_AUTH_CACHE_TTL_MS.
 *
 * This module has no dependencies so identity and admission stores can import it.
 */

export const FORWARD_AUTH_CACHE_TTL_MS = 10_000;
export const FORWARD_AUTH_CACHE_MAX_ENTRIES = 5_000;

interface Entry<V> { value?: V; pending?: Promise<V>; expires: number }

export class TtlLruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private generation = 0;

  constructor(
    private readonly maxEntries = FORWARD_AUTH_CACHE_MAX_ENTRIES,
    private readonly ttlMs = FORWARD_AUTH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number { return this.entries.size; }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing?.pending) return existing.pending;
    if (existing && existing.expires > this.now()) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value as V;
    }
    if (existing) this.entries.delete(key);

    const generation = this.generation;
    const entry: Entry<V> = { expires: Number.POSITIVE_INFINITY };
    entry.pending = (async () => {
      try {
        const value = await load();
        // A clear() during the load means the value may predate a revocation.
        if (this.entries.get(key) === entry && this.generation === generation) {
          entry.value = value;
          entry.expires = this.now() + this.ttlMs;
          entry.pending = undefined;
        } else if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        return value;
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    })();
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return entry.pending;
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
  }
}

export interface ForwardAuthCaches {
  /** host → its admission routes with their policies */
  hostRoutes: TtlLruCache<unknown>;
  /** installation|host → machine callback "METHOD path" set */
  callbacks: TtlLruCache<unknown>;
  /** appId → public access projection applied */
  publicApplied: TtlLruCache<unknown>;
  /** session-cookie hash|host|installation:revision → final decision */
  decisions: TtlLruCache<unknown>;
}

export function createForwardAuthCaches(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): ForwardAuthCaches {
  const make = () => new TtlLruCache<unknown>(options.maxEntries, options.ttlMs, options.now);
  return { hostRoutes: make(), callbacks: make(), publicApplied: make(), decisions: make() };
}

// Next may bundle this module more than once in a process; share one set.
const key = Symbol.for('youeye.forward-auth-caches');
const holder = globalThis as typeof globalThis & { [key]?: ForwardAuthCaches };

export function forwardAuthCaches(): ForwardAuthCaches {
  return holder[key] ??= createForwardAuthCaches();
}

/** Drop every cached route, policy and decision in this process. */
export function clearForwardAuthCaches(): void {
  const caches = holder[key];
  if (!caches) return;
  for (const cache of Object.values(caches)) (cache as TtlLruCache<unknown>).clear();
}
