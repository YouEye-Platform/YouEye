import { CADDY_APP_ACL } from './app-network-caddy-nic';
import { integrationAclName } from './connection-nic';

/**
 * Keep every container's default route on its own network (`eth0`), never on a side NIC (YE-198).
 *
 * Side NICs are a consumer's connection NICs (`net-<peer>` with its grant's ACL, `grantBridgeAccess`) and Caddy's
 * app NICs (`net-<app>` with `CADDY_APP_ACL`, `planCaddyAppNIC`). Each sits on another app's bridge, whose DHCP
 * lease carries that bridge's gateway.
 *
 * When an OCI container starts, Incus runs its own DHCP client on every NIC at once (`forknet dhcp`). Each client,
 * once it has a lease, lists the default routes and then replaces the default with its own gateway unless a NIC with
 * a smaller name already holds it (`installDefaultRouteV4`). Side NICs are named `eth-…`, which sorts before `eth0`
 * (`-` < `0`), so a side lease that lands after eth0's always takes the default; when two leases land together, both
 * see an empty table and the last `replace` wins. Either way the side NIC can end up with it: on a box, 3 of 7
 * restarts of a connected Sonarr did, and 5 of 8 with names sorting after `eth0`, so no naming fixes it. Renewals
 * never touch routes again, so one repair after each start holds until the next start.
 *
 * So after every start (Incus lifecycle events, `default-route-watch.ts`), once the container's NICs hold their
 * addresses, the guard removes any default route through a side NIC and, when none is left, puts one back through
 * `eth0` via the gateway of the container's own bridge. The repair never touches a route through `eth0`, never
 * leaves a container without a default route it had (it acts only while `eth0` holds an address and its gateway is
 * known), and is idempotent: run on a container whose routes are right, it changes nothing.
 */

type Device = Record<string, string>;

export interface GuardInstance {
  name: string;
  type?: string;
  status?: string;
  config?: Record<string, string>;
  devices?: Record<string, Device>;
  expanded_devices?: Record<string, Device>;
}

interface IncusEnvelope<T> { type?: string; status_code?: number; error?: string; metadata?: T }

export interface GuardDeps {
  incus<T>(method: string, path: string): Promise<IncusEnvelope<T>>;
  exec(container: string, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /**
   * True while an operation of this process holds the container's app (an update being finished or rolled back at
   * start, an install, a connection): the guard waits instead of acting on a container that may be replaced.
   */
  busy?(instance: GuardInstance): boolean;
}

/** Side NIC names safe to put in a shell script: `eth-` and hex (never `eth0`, which has no dash). */
const SIDE_NAME = /^eth-[0-9a-f]{1,11}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
/** Exit codes of the repair script: no `ip` command; `eth0` has no address yet; the eth0 default could not be added. */
export const NO_IP_TOOL = 3;
export const ETH0_UNADDRESSED = 4;
export const RESTORE_FAILED = 5;
/**
 * The gateway of eth0's network is not reached through eth0: its bridge was recreated on another subnet while the
 * container still holds a lease from the old one (YE-211). Nothing is changed: removing the side default would leave
 * no default route at all, since the eth0 one could not be added.
 */
export const GATEWAY_OFF_ETH0 = 6;
/** How long a start's repair waits for the side NICs' leases once `eth0` has its own (YE-223). */
export const SIDE_LEASE_WAIT_MS = 10_000;
/**
 * When a side NIC still had no lease after that wait, one more check this long after the late one (YE-224): Incus's
 * DHCP clients try for 30 s, so the last repair comes after a very late lease could have set a side default.
 */
export const LATE_LEASE_CHECK_MS = 30_000;
/** Retries of a repair that failed (an exec timeout at a busy boot, `eth0` still without its lease). */
const RETRIES = 3;
const RETRY_MS = 30_000;
/**
 * Waits for an app operation to end, polled every 2 s for at most 10 minutes. A restart holds the app while it
 * starts the container, so the repair follows as soon as the restart call returns.
 */
const BUSY_POLL_MS = 2_000;
const BUSY_WAITS = 300;

/** The interfaces of `instance` that must never hold its default route. */
export function sideInterfaces(instance: GuardInstance): string[] {
  const names: string[] = [];
  for (const [key, device] of Object.entries(instance.expanded_devices ?? instance.devices ?? {})) {
    const peer = /^net-(.+)$/.exec(key)?.[1];
    if (!peer || device.type !== 'nic' || !device.name || !SIDE_NAME.test(device.name)) continue;
    const acl = device['security.acls'];
    if (acl === CADDY_APP_ACL || acl === integrationAclName(instance.name, peer)) names.push(device.name);
  }
  return names.sort();
}

/**
 * The repair, as a POSIX shell script for busybox and iproute2 alike. Prints one line per change. Exits 0 when the
 * routes are right afterwards, `NO_IP_TOOL` without `ip`, `ETH0_UNADDRESSED` (changing nothing) while `eth0` has no
 * IPv4 address, `GATEWAY_OFF_ETH0` (changing nothing) when the gateway is not reached through `eth0`, and
 * `RESTORE_FAILED` when no default route is left and the one through `eth0` could not be added.
 */
export function defaultRouteRepairScript(sideNames: string[], eth0Gateway: string): string {
  for (const name of sideNames) {
    if (!SIDE_NAME.test(name)) throw new Error('Invalid side interface name');
  }
  if (!IPV4.test(eth0Gateway)) throw new Error('Invalid gateway address');
  const lines = [
    `command -v ip >/dev/null 2>&1 || exit ${NO_IP_TOOL}`,
    // Without its own address eth0 can't carry the default: leave a side default (better than none) for the retry.
    `ip -4 addr show dev eth0 2>/dev/null | grep -q 'inet ' || exit ${ETH0_UNADDRESSED}`,
    // Remove nothing unless the gateway is reached through eth0, so its default can be added afterwards (YE-211;
    // busybox and iproute2 both have `route get`).
    `ip -4 route get '${eth0Gateway}' 2>/dev/null | grep -qE ' dev eth0( |$)' || exit ${GATEWAY_OFF_ETH0}`,
  ];
  for (const name of sideNames) {
    // Selector-free listing: busybox `ip route show` takes fewer selectors than iproute2.
    lines.push(
      `while ip -4 route show 2>/dev/null | grep -qE '^default .*dev ${name}( |$)'; do ` +
      `ip -4 route del default dev '${name}' 2>/dev/null || break; echo 'removed the default route through ${name}'; done`,
    );
  }
  lines.push(
    `ip -4 route show 2>/dev/null | grep -q '^default ' || ` +
    `{ ip -4 route add default via '${eth0Gateway}' dev eth0 2>/dev/null && echo 'restored the default route through eth0' || ` +
    // Another repair of the same start may have added it meanwhile (YE-223: the late check and the guard's own one).
    `ip -4 route show 2>/dev/null | grep -qE '^default .*dev eth0( |$)' || ` +
    `{ echo 'could not restore the default route through eth0'; exit ${RESTORE_FAILED}; }; }`,
    'exit 0',
  );
  return lines.join('\n');
}

/** `left`: the routes were left as they are on purpose (`GATEWAY_OFF_ETH0`); tried again at the next start. */
export type RepairOutcome = 'unchanged' | 'repaired' | 'no-ip' | 'left' | 'failed' | 'skipped';

export function createDefaultRouteGuard(deps: GuardDeps) {
  const pending = new Map<string, { again: boolean; done: Promise<void> }>();
  /** Init pid per container at its last finished repair: a different pid means it started again. */
  const lastPid = new Map<string, number>();
  const unsupportedLogged = new Set<string>();
  /** Container and gateway already reported as off eth0's network (one line until either changes). */
  const offNetworkLogged = new Set<string>();

  async function readInstance(name: string): Promise<GuardInstance | undefined> {
    const read = await deps.incus<GuardInstance>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
    return read.type === 'error' || !read.metadata ? undefined : read.metadata;
  }

  /** Read each time: app bridges are recreated with the same name and another subnet. */
  async function eth0Gateway(instance: GuardInstance): Promise<string | undefined> {
    const eth0 = Object.values(instance.expanded_devices ?? instance.devices ?? {})
      .find((device) => device.type === 'nic' && device.name === 'eth0');
    const network = eth0?.network;
    if (!network) return undefined;
    const read = await deps.incus<{ config?: Record<string, string> }>('GET', `/1.0/networks/${encodeURIComponent(network)}`);
    const gateway = read.type === 'error' ? undefined : read.metadata?.config?.['ipv4.address']?.split('/')[0];
    return gateway && IPV4.test(gateway) ? gateway : undefined;
  }

  /** One repair of a running container, now. */
  async function repairOnce(instance: GuardInstance, sides: string[], reason: string): Promise<RepairOutcome> {
    try {
      const gateway = await eth0Gateway(instance);
      if (!gateway) throw new Error("no IPv4 gateway for eth0's network");
      const result = await deps.exec(instance.name, defaultRouteRepairScript(sides, gateway));
      // 126/127: the shell itself is missing or not runnable (a distroless image).
      if (result.exitCode === NO_IP_TOOL || result.exitCode === 126 || result.exitCode === 127) {
        if (!unsupportedLogged.has(instance.name)) {
          unsupportedLogged.add(instance.name);
          deps.log(`${instance.name} has no ${result.exitCode === NO_IP_TOOL ? 'ip command' : 'shell'}; its default route is not checked`);
        }
        return 'no-ip';
      }
      if (result.exitCode === GATEWAY_OFF_ETH0) {
        const key = `${instance.name}\0${gateway}`;
        if (!offNetworkLogged.has(key)) {
          offNetworkLogged.add(key);
          deps.log(`${instance.name}: the gateway ${gateway} of its own network is not reached through eth0 (a lease `
            + 'from before its network changed); its routes are left as they are until it starts again');
        }
        return 'left';
      }
      const changes = result.stdout.trim();
      if (changes) deps.log(`${instance.name} (${reason}): ${changes.split('\n').join('; ')}`);
      if (result.exitCode === ETH0_UNADDRESSED) throw new Error('eth0 has no IPv4 address yet');
      if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
      return changes ? 'repaired' : 'unchanged';
    } catch (error) {
      deps.log(`could not check the default route of ${instance.name}: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  async function startState(name: string): Promise<{ pid?: number; addressed: Set<string> }> {
    const read = await deps.incus<{ pid?: number; network?: Record<string, { addresses?: Array<{ family?: string; address?: string }> }> | null }>(
      'GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
    const state = read.type === 'error' ? undefined : read.metadata;
    const addressed = new Set(Object.entries(state?.network ?? {})
      .filter(([, nic]) => (nic.addresses ?? []).some((address) => address.family === 'inet' && address.address))
      .map(([ifName]) => ifName));
    return { pid: state?.pid, addressed };
  }

  /**
   * After a start: wait until `eth0` and every side NIC hold an IPv4 address (Incus's DHCP clients give up after
   * 30 s), then repair, and once more a little later in case a lease landed late. A repair that fails is tried
   * again, `RETRIES` times; the container's pid is recorded only once a repair went through, so a later sweep
   * tries again too.
   */
  async function settleAndRepair(name: string, reason: string): Promise<RepairOutcome> {
    let instance = await readInstance(name);
    for (let waits = 0; instance && deps.busy?.(instance); waits++) {
      if (waits >= BUSY_WAITS) {
        deps.log(`${name} stayed busy with an app operation; its default route is checked at its next start`);
        return 'skipped';
      }
      await deps.sleep(BUSY_POLL_MS);
      instance = await readInstance(name);
    }
    if (!instance || instance.type !== 'container' || instance.status !== 'Running') return 'skipped';
    const sides = sideInterfaces(instance);
    if (!sides.length) return 'skipped';
    const { pid, leased } = await waitForLeases(name, sides);
    let repaired = false;
    let outcome: RepairOutcome = 'failed';
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await deps.sleep(RETRY_MS);
      // An operation that took the app meanwhile may be replacing the container: leave it to that operation's start.
      if (deps.busy?.(instance)) return 'skipped';
      outcome = await repairOnce(instance, sides, reason);
      if (outcome !== 'failed') break;
    }
    repaired = outcome === 'repaired';
    if (outcome === 'failed') return outcome;
    if (outcome !== 'no-ip' && outcome !== 'left') {
      for (const pause of leased ? [15_000] : [15_000, LATE_LEASE_CHECK_MS]) {
        await deps.sleep(pause);
        if (deps.busy?.(instance)) return 'skipped';
        const late = await repairOnce(instance, sides, reason);
        repaired ||= late === 'repaired';
        if (late === 'failed') return late;
      }
    }
    if (pid) lastPid.set(name, pid);
    return outcome === 'no-ip' || outcome === 'left' ? outcome : repaired ? 'repaired' : 'unchanged';
  }

  /**
   * Wait until `eth0` and every side NIC hold an IPv4 address (Incus's DHCP clients give up after 30 s), then a
   * second: each client sets its default route right after its address. Returns the container's init pid.
   */
  async function waitForLeases(name: string, sides: string[]): Promise<{ pid?: number; leased: boolean }> {
    let pid: number | undefined;
    let eth0At: number | undefined;
    let leased = false;
    for (let waited = 0; ; waited += 1_000) {
      const state = await startState(name);
      pid = state.pid;
      leased = ['eth0', ...sides].every((ifName) => state.addressed.has(ifName));
      if (leased || waited >= 40_000) break;
      // A side NIC that gets no lease soon after eth0 (YE-223) is not waited for longer: it carries no default route
      // yet, and the late check (or the next start's repair) handles a lease it gets later.
      if (state.addressed.has('eth0')) {
        eth0At ??= waited;
        if (waited - eth0At >= SIDE_LEASE_WAIT_MS) break;
      }
      await deps.sleep(1_000);
    }
    await deps.sleep(1_000);
    return { pid, leased };
  }

  /**
   * The repair for an app operation's own start (YE-220): an update's first start, a rollback's and a recovery's
   * restart. The operation holds the app, so the guard's own repair after the start event waits for the hold to end,
   * which is after the operation's health check: a connected app whose start needs the internet (Bazarr) failed its
   * health on the connection NIC's default route and rolled back. The holder calls this right after the start and
   * before its health wait: the leases are waited for, the routes repaired once, the start recorded, and the usual
   * late check runs 15 s later in the background, only while the container still runs the same start (same init pid),
   * so a container the operation replaced meanwhile is never touched. One attempt, no retries: the operation's health
   * check decides; a failure is logged. The same repair as every other start: eth0's default is never removed.
   */
  async function repairAfterOperationStart(name: string, reason: string): Promise<RepairOutcome> {
    const instance = await readInstance(name);
    if (!instance || instance.type !== 'container' || instance.status !== 'Running') return 'skipped';
    const sides = sideInterfaces(instance);
    if (!sides.length) return 'skipped';
    const { pid, leased } = await waitForLeases(name, sides);
    const outcome = await repairOnce(instance, sides, reason);
    if (outcome === 'failed') return outcome;
    if (pid) lastPid.set(name, pid);
    if (outcome !== 'no-ip' && outcome !== 'left') {
      void (async () => {
        for (const pause of leased ? [15_000] : [15_000, LATE_LEASE_CHECK_MS]) {
          await deps.sleep(pause);
          const now = await startState(name);
          if (!pid || now.pid !== pid) return;
          await repairOnce(instance, sides, `${reason}, late check`);
        }
      })().catch(() => undefined);
    }
    return outcome;
  }

  /** Repair `name` after a start; calls for the same container while one runs are folded into one more round. */
  function schedule(name: string, reason: string): Promise<void> {
    const running = pending.get(name);
    if (running) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await settleAndRepair(name, reason).catch((error) => {
            deps.log(`default route check of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        } while (entry.again);
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, entry);
    return entry.done;
  }

  /**
   * Every running container with side NICs whose init pid changed since its last repair (all of them the first
   * time): run when the event stream (re)connects and, while it is down, every 30 s.
   */
  async function sweep(reason = 'sweep'): Promise<void> {
    const list = await deps.incus<GuardInstance[]>('GET', '/1.0/instances?recursion=1');
    if (list.type === 'error' || !Array.isArray(list.metadata)) throw new Error(list.error || 'could not list instances');
    const due: Promise<void>[] = [];
    for (const instance of list.metadata) {
      if (instance.type !== 'container' || instance.status !== 'Running' || !sideInterfaces(instance).length) continue;
      // A repair already under way (an event, or an earlier sweep) covers this start.
      if (pending.has(instance.name)) continue;
      const { pid } = await startState(instance.name);
      if (pid && lastPid.get(instance.name) === pid) continue;
      due.push(schedule(instance.name, reason));
    }
    await Promise.all(due);
  }

  /** Right now, without waiting for leases: after a NIC was hot-plugged and brought up (`grantBridgeAccess`). */
  async function repairNow(name: string, reason: string): Promise<RepairOutcome> {
    const instance = await readInstance(name);
    if (!instance || instance.status !== 'Running') return 'skipped';
    const sides = sideInterfaces(instance);
    return sides.length ? repairOnce(instance, sides, reason) : 'skipped';
  }

  return { schedule, sweep, repairNow, repairAfterOperationStart, settleAndRepair };
}
