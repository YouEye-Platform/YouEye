/**
 * Sign-in limits (YE-134; YE-136 keyed them on the real client; YE-149 made the per-username limit a slow-down, so
 * that nobody who can reach a sign-in form can keep a user out).
 *
 * Each scope has its own counts: YouEye ID's sign-in (`id-login`), the Control Panel's PAM login (`cp-login`), the
 * appliance claim (`appliance-claim`) and the owner reset form (`owner-reset`, whose username is always the owner).
 *
 * The source of an attempt is its client address from `requestClientAddress` (`lib/auth/client-address.ts`): the TCP
 * peer, or Caddy's `X-Forwarded-For` when the peer is Caddy. An IPv6 address counts by its /64 (one host usually
 * holds a whole /64). With no client address (loopback, the host's shared NAT address that every NATing app's doorway
 * arrives from, an unknown peer) the source is the one source `shared`.
 *
 * - **Per (username, source):** 10 failures in 15 minutes lock that pair until the window ends. Only for a real
 *   address: the shared source is never locked.
 * - **Per source address:** 30 failures in 15 minutes across usernames stop that address (password spraying). Only for
 *   a real address. An IPv6 address also counts toward its /56 (100 failures) and /48 (300): a network holds many
 *   /64s, and each would otherwise be a fresh source. Past a limit the whole prefix waits for every username; IPv4
 *   has no wider limit (many homes can share one carrier-grade NAT range).
 * - **Per username, a slow-down that never locks:** the username's first 5 failures in the window (from anywhere) cost
 *   nothing. After that, a source that has just failed on the username waits before its next attempt on it is checked:
 *   2^(n-5) seconds, at most 60, where n is the username's failures from all sources. A source with no failure on the
 *   username in the window is checked at once, so failures elsewhere never stop the right password from another
 *   address, and nobody can use up another source's turn. The shared source gets this slow-down only.
 *
 * Only failures count: a success clears its pair (count and wait) and gives the username and the address their
 * attempt back. It does not reset the username's count, so the owner signing in does not lift the slow-down for
 * whoever is guessing. A refused attempt counts against nothing. Unknown usernames are counted, slowed down and
 * answered exactly like real ones, so no limit tells whether a user exists.
 *
 * The counts live in this process's memory (a restart clears them), at most `SIGN_IN_STORE_LIMIT` entries. When the
 * store is full, expired entries go first, then the least recently used ones that have no effect; an entry that locks
 * a pair, stops an address, or makes a source wait is never dropped, so a flood of random usernames cannot free an
 * attacker. Usernames and pairs may not use the last `SIGN_IN_STORE_RESERVE` entries: those keep the address limit on
 * a new address and the slow-down on the shared source. With no room for a username, a pair waits the full cap; with
 * no room even in the reserve, a source that would otherwise have no limit is refused for now (fail closed).
 */

export const SIGN_IN_WINDOW_SECONDS = 15 * 60;
/** Failures per (username, address) before that pair is locked for the window. */
export const SIGN_IN_PAIR_ATTEMPTS = 10;
export const SIGN_IN_ADDRESS_ATTEMPTS = 30;
/** Failures per IPv6 /56 and per /48 across usernames: one network holds many /64s, each a fresh source. */
export const SIGN_IN_PREFIX56_ATTEMPTS = 100;
export const SIGN_IN_PREFIX48_ATTEMPTS = 300;
/** Failures per username, from all sources, before the slow-down starts. */
export const SIGN_IN_FREE_FAILURES = 5;
export const SIGN_IN_MAX_DELAY_SECONDS = 60;
export const SIGN_IN_STORE_LIMIT = 50_000;
/** The part of the store only address entries and the shared source's pairs may use (see `makeRoom`). */
export const SIGN_IN_STORE_RESERVE = 5_000;
/** The source of attempts with no client address. */
export const SHARED_SOURCE = 'shared';

export type SignInScope = 'id-login' | 'cp-login' | 'appliance-claim' | 'owner-reset';

export interface SignInAttempt {
  allowed: boolean;
  /** Why a refused attempt was refused: its pair or address is locked, or its source must wait. */
  refusal?: 'locked' | 'wait';
  /** When the attempt may be made again (ms since the epoch); 0 when allowed. */
  retryAt: number;
  /** Failures left before a lock, the smaller of the pair's and the address's; undefined for the shared source. */
  remaining?: number;
  /** Set once a success or a non-guess has settled the attempt; a second settlement does nothing. */
  settled?: boolean;
  /** @internal what `begin` counted, so that a settlement can give it back */
  counted?: { userKey: string | null; pairKey: string | null; addressKeys: string[]; waitBefore: number; waitSet: number };
}

interface Entry {
  count: number;
  resetAt: number;
  /** Pairs only: no attempt from this source on this username is checked before this time. */
  waitUntil: number;
  /** What the entry counts; `active` says which have an effect. */
  kind: 'user' | 'pair' | 'shared-pair' | 'address';
  /** The last failure counted on it: an eviction drops the least recently used first. */
  touchedAt: number;
  /** Address entries: the failures that stop the address or prefix. */
  limit: number;
}

const store = new Map<string, Entry>();
let evictionFailedAt = 0;

/** The delay after the username's n-th failure in the window. */
export function signInDelaySeconds(failures: number): number {
  if (failures < SIGN_IN_FREE_FAILURES) return 0;
  return Math.min(2 ** (failures - SIGN_IN_FREE_FAILURES), SIGN_IN_MAX_DELAY_SECONDS);
}

/** An IPv4 address as it is; an IPv6 address as its /64 ("2001:db8:0:1::/64"). */
export function signInSourceOf(address: string | null): string {
  if (!address) return SHARED_SOURCE;
  if (!address.includes(':')) return address;
  const groups = expandIPv6(address);
  return groups ? `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64` : address;
}

/** An IPv6 address's /56 and /48 with their failure limits; none for IPv4 and the shared source. */
export function signInPrefixes(address: string | null): Array<{ prefix: string; limit: number }> {
  if (!address || !address.includes(':')) return [];
  const groups = expandIPv6(address);
  if (!groups) return [];
  const short = (group: string) => group.replace(/^0+(?=.)/, '');
  const head = groups.slice(0, 3).map(short).join(':');
  const fourth = (parseInt(groups[3], 16) & 0xff00).toString(16);
  return [
    { prefix: `${head}:${fourth}::/56`, limit: SIGN_IN_PREFIX56_ATTEMPTS },
    { prefix: `${head}::/48`, limit: SIGN_IN_PREFIX48_ATTEMPTS },
  ];
}

function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase().replace(/%.*$/, '');
  // An embedded IPv4 tail ("::ffff:1.2.3.4", "64:ff9b::1.2.3.4") becomes two groups.
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = text.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.every(group => /^[0-9a-f]{1,4}$/.test(group)) ? groups : null;
}

function normalizedUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, 256);
}

function live(key: string, now: number): Entry | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.resetAt <= now && entry.waitUntil <= now) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function active(entry: Entry, now: number): boolean {
  if (entry.waitUntil > now) return true;
  if (entry.resetAt <= now) return false;
  switch (entry.kind) {
    case 'pair': return entry.count >= SIGN_IN_PAIR_ATTEMPTS;
    case 'address': return entry.count >= entry.limit;
    // A username's count only sets the next wait; the waits themselves are on the pairs, and the least recently
    // used order keeps a username under attack (it is touched by every guess).
    default: return false;
  }
}

/**
 * Make room for one more entry; false when the store is full of entries that have an effect. Usernames and pairs
 * may fill the store only up to its reserve; the reserve is for the entries that keep a limit on a source that has
 * none yet, its address count and the shared source's pairs, so filling the store with usernames does not free a new
 * source of every limit.
 */
function makeRoom(now: number, reserved: boolean): boolean {
  const limit = reserved ? SIGN_IN_STORE_LIMIT : SIGN_IN_STORE_LIMIT - SIGN_IN_STORE_RESERVE;
  if (store.size < limit) return true;
  // A store that one pass could not bring down to its target is mostly live effects, and they last: don't scan it
  // again on every request, at most once a second.
  if (now - evictionFailedAt < 1000) return false;
  const target = SIGN_IN_STORE_LIMIT - SIGN_IN_STORE_RESERVE * 2;
  const idle: Array<[string, number]> = [];
  for (const [key, entry] of store) {
    if (entry.resetAt <= now && entry.waitUntil <= now) store.delete(key);
    else if (!active(entry, now)) idle.push([key, entry.touchedAt]);
  }
  // Least recently used first: a username under attack is touched by every guess, so it stays.
  idle.sort((a, b) => a[1] - b[1]);
  for (const [key] of idle) {
    if (store.size <= target) break;
    store.delete(key);
  }
  if (store.size > target) evictionFailedAt = now;
  return store.size < limit;
}

/** Count one failure on `key`, creating its entry when there is room; null when there is none. */
function count(key: string, kind: Entry['kind'], now: number, limit = 0): Entry | null {
  let entry = live(key, now);
  if (entry && entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + SIGN_IN_WINDOW_SECONDS * 1000;
  }
  if (!entry) {
    if (!makeRoom(now, kind === 'address' || kind === 'shared-pair')) return null;
    entry = { count: 0, resetAt: now + SIGN_IN_WINDOW_SECONDS * 1000, waitUntil: 0, kind, touchedAt: now, limit };
    store.set(key, entry);
  }
  entry.count++;
  entry.touchedAt = now;
  return entry;
}

function giveBack(key: string | null, now: number): void {
  if (!key) return;
  const entry = live(key, now);
  if (entry && entry.resetAt > now) entry.count = Math.max(0, entry.count - 1);
}

/** Check the limits and, when the attempt may go ahead, count it as a failure until it is settled otherwise. */
export function beginSignInAttempt(
  username: string,
  address: string | null,
  scope: SignInScope = 'id-login',
): SignInAttempt {
  const now = Date.now();
  const source = signInSourceOf(address);
  const shared = source === SHARED_SOURCE;
  const user = normalizedUsername(username);
  const userKey = `${scope}|user|${user}`;
  const pairKey = `${scope}|pair|${source}|${user}`;
  // The address itself first: its entry is the one a new source must get (fail closed below).
  const addressLimits = shared ? [] : [
    { key: `${scope}|address|${source}`, limit: SIGN_IN_ADDRESS_ATTEMPTS },
    ...signInPrefixes(address).map(({ prefix, limit }) => ({ key: `${scope}|address|${prefix}`, limit })),
  ];

  const pair = live(pairKey, now);
  const locks = [
    ...(!shared && pair && pair.resetAt > now && pair.count >= SIGN_IN_PAIR_ATTEMPTS ? [pair.resetAt] : []),
    ...addressLimits.flatMap(({ key, limit }) => {
      const entry = live(key, now);
      return entry && entry.resetAt > now && entry.count >= limit ? [entry.resetAt] : [];
    }),
  ];
  if (locks.length > 0) return { allowed: false, refusal: 'locked', retryAt: Math.max(...locks), remaining: 0 };
  if (pair && pair.waitUntil > now) return { allowed: false, refusal: 'wait', retryAt: pair.waitUntil, remaining: undefined };

  const waitBefore = pair?.waitUntil ?? 0;
  const addressEntries = addressLimits.map(({ key, limit }) => count(key, 'address', now, limit));
  const addressEntry = addressEntries[0] ?? null;
  const addressKeys = addressLimits.filter((_, i) => addressEntries[i]).map(({ key }) => key);
  const userEntry = count(userKey, 'user', now);
  const pairEntry = count(pairKey, shared ? 'shared-pair' : 'pair', now);
  // A store full of live effects even in its reserve: a source that has no limit kept on it here (the shared
  // source's pair, a real source's address) is refused for now rather than let through unlimited (fail closed).
  if (shared ? !pairEntry : !addressEntry) {
    for (const key of addressKeys) giveBack(key, now);
    giveBack(userEntry ? userKey : null, now);
    giveBack(pairEntry ? pairKey : null, now);
    return { allowed: false, refusal: 'wait', retryAt: now + SIGN_IN_MAX_DELAY_SECONDS * 1000, remaining: undefined };
  }
  if (pairEntry) {
    // Without the username's count (no room for it), the slow-down is at its cap.
    const delay = userEntry ? signInDelaySeconds(userEntry.count) : SIGN_IN_MAX_DELAY_SECONDS;
    if (delay > 0) pairEntry.waitUntil = now + delay * 1000;
  }
  const remaining = shared
    ? undefined
    : Math.min(
      pairEntry ? SIGN_IN_PAIR_ATTEMPTS - pairEntry.count : SIGN_IN_PAIR_ATTEMPTS,
      ...addressLimits.map(({ limit }, i) => limit - (addressEntries[i]?.count ?? 0)),
    );
  return {
    allowed: true,
    retryAt: 0,
    remaining,
    counted: {
      userKey: userEntry ? userKey : null,
      pairKey: pairEntry ? pairKey : null,
      addressKeys,
      waitBefore,
      waitSet: pairEntry?.waitUntil ?? 0,
    },
  };
}

/** Seconds until a refused attempt may be made again (at least 1), for Retry-After. */
export function signInRetryAfterSeconds(attempt: SignInAttempt): number {
  return Math.max(1, Math.ceil((attempt.retryAt - Date.now()) / 1000));
}

/**
 * After a successful sign-in: the pair starts over and its source waits no more; the username and the address get
 * this attempt back. The username's other failures stay, and so does its slow-down for the other sources.
 */
export function signInSucceeded(attempt: SignInAttempt): void {
  if (!attempt.allowed || attempt.settled || !attempt.counted) return;
  attempt.settled = true;
  const now = Date.now();
  const { userKey, pairKey, addressKeys } = attempt.counted;
  if (pairKey) store.delete(pairKey);
  giveBack(userKey, now);
  for (const key of addressKeys) giveBack(key, now);
}

/** An attempt that was no guess (a form error found before any password was checked): it counts against nothing. */
export function signInNotCounted(attempt: SignInAttempt): void {
  if (!attempt.allowed || attempt.settled || !attempt.counted) return;
  attempt.settled = true;
  const now = Date.now();
  const { userKey, pairKey, addressKeys, waitBefore, waitSet } = attempt.counted;
  giveBack(userKey, now);
  for (const key of addressKeys) giveBack(key, now);
  if (pairKey) {
    giveBack(pairKey, now);
    // Only the wait this attempt set: a parallel attempt's later wait stays.
    const pair = store.get(pairKey);
    if (pair && pair.waitUntil === waitSet) pair.waitUntil = waitBefore;
  }
}

/** Forget every count (tests, and an administrator's reset); returns how many entries there were. */
export function resetSignInLimits(): number {
  const entries = store.size;
  store.clear();
  evictionFailedAt = 0;
  return entries;
}

/** The number of entries held (tests). */
export function signInLimitEntries(): number {
  return store.size;
}
