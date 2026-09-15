import { getInstanceState, updateInstanceState } from '@/lib/incus/server';
import { readHealthRegistry, writeHealthRegistry } from '@/lib/health/issue-store';

export type IssueSeverity = 'info' | 'warning' | 'error' | 'critical';
export type IssueState = 'open' | 'ignored' | 'resolved';

export interface HealthIssue {
  id: string;
  severity: IssueSeverity;
  source: string;
  title: string;
  body: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  fixable: boolean;
  repairFn?: string | null;
  learnMore?: string | null;
  state: IssueState;
  ignoredReason?: string | null;
  resolvedAt?: string | null;
}

export interface IssueStore {
  issues: Record<string, HealthIssue>;
  debounce: Record<string, { count: number; lastSeen: string }>;
}

const DEFAULT_DEBOUNCE_THRESHOLD = 2;
const RESTARTABLE_SERVICE_CONTAINERS: Record<string, string> = {
  pihole: 'youeye-pihole',
  caddy: 'youeye-caddy',
  postgres: 'youeye-postgres',
  pointer: 'youeye-pointer',
};

let mutationTail: Promise<void> = Promise.resolve();

async function loadStore(): Promise<IssueStore> {
  const store = await readHealthRegistry<IssueStore>() ?? { issues: {}, debounce: {} };
  store.issues ??= {};
  store.debounce ??= {};
  return store;
}

async function mutateStore<T>(mutation: (store: IssueStore) => T | Promise<T>): Promise<T> {
  const operation = mutationTail.then(async () => {
    const store = await loadStore();
    const result = await mutation(store);
    await writeHealthRegistry(store);
    return result;
  });
  mutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function listIssues(includeResolved = false): Promise<HealthIssue[]> {
  const s = await loadStore();
  return Object.values(s.issues)
    .filter((issue) => includeResolved || issue.state !== 'resolved')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.lastSeen.localeCompare(a.lastSeen));
}

export async function observeIssue(input: {
  id: string;
  severity: IssueSeverity;
  source: string;
  title: string;
  body: string;
  fixable?: boolean;
  repairFn?: string | null;
  learnMore?: string | null;
  debounce?: number;
}): Promise<HealthIssue | null> {
  return mutateStore((store) => applyObservation(store, input, new Date().toISOString()));
}

export async function resolveIssue(id: string): Promise<void> {
  await mutateStore((store) => applyResolution(store, id, new Date().toISOString()));
}

export async function ignoreIssue(id: string, reason: string): Promise<HealthIssue | null> {
  return mutateStore((store) => applyIgnore(store, id, reason, new Date().toISOString()));
}

export async function recordTimelineEvent(input: {
  id: string;
  source: string;
  title: string;
  body: string;
  learnMore?: string | null;
}): Promise<HealthIssue> {
  const issue = await observeIssue({
    id: input.id,
    severity: 'info',
    source: input.source,
    title: input.title,
    body: input.body,
    fixable: false,
    learnMore: input.learnMore ?? null,
    debounce: 1,
  });
  return issue!;
}

export async function hasOpenCriticalIssue(): Promise<HealthIssue | null> {
  const issues = await listIssues(false);
  return findOpenCriticalIssue(issues);
}

export async function assertNoCriticalIssues(operation: string): Promise<void> {
  const issue = await hasOpenCriticalIssue();
  if (issue) {
    throw new Error(`${operation} blocked while critical health issue is open: ${issue.title}`);
  }
}

export async function runIssueRepair(id: string): Promise<{ ok: boolean; message: string }> {
  const s = await loadStore();
  const issue = s.issues[id];
  if (!issue || issue.state === 'resolved') return { ok: true, message: 'Issue is already resolved' };
  if (!issue.fixable || !issue.repairFn) return { ok: false, message: 'Issue is not marked fixable' };

  switch (issue.repairFn) {
    case issue.repairFn?.startsWith('restart-service:') ? issue.repairFn : '': {
      const slug = issue.repairFn.slice('restart-service:'.length);
      const container = RESTARTABLE_SERVICE_CONTAINERS[slug];
      if (!container) return { ok: false, message: `Unknown restartable service: ${slug}` };

      const before = await getInstanceState(container);
      const wasRunning = (before.metadata as { status?: string } | undefined)?.status === 'Running';
      await updateInstanceState(container, wasRunning ? 'restart' : 'start');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await getInstanceState(container);
      const running = (after.metadata as { status?: string } | undefined)?.status === 'Running';
      if (running) {
        await resolveIssue(id);
        return { ok: true, message: `${slug} ${wasRunning ? 'restarted' : 'started'} successfully` };
      }
      return { ok: false, message: `${slug} did not return to Running after repair` };
    }
    case 'reconcile-apps': {
      const { reconcileApps } = await import('@/lib/market/reconciler');
      const result = await reconcileApps();
      if (result.unresolved.length === 0) {
        await resolveIssue(id);
      }
      return { ok: result.unresolved.length === 0, message: `Reconcile repaired ${result.repaired.length} divergence(s)` };
    }
    case 'repair-empty-app-network': {
      const { repairEmptyAppNetworkBootstrap } = await import('@/lib/incus/app-network');
      const repaired = await repairEmptyAppNetworkBootstrap();
      if (!repaired.eligible || !repaired.changed) {
        return { ok: false, message: `Guarded app-network repair refused: ${repaired.reason}` };
      }
      const { reconcileApps } = await import('@/lib/market/reconciler');
      const reconciled = await reconcileApps();
      if (reconciled.unresolved.length === 0) await resolveIssue(id);
      return {
        ok: reconciled.unresolved.length === 0,
        message: reconciled.unresolved.length === 0
          ? `App network pool ${repaired.selectedPools.join(', ')} was persisted and verified`
          : 'App network pool was persisted, but strict reconciliation still reports unresolved state',
      };
    }
    default:
      return { ok: false, message: `Unknown repair function: ${issue.repairFn}` };
  }
}

function severityRank(severity: IssueSeverity): number {
  switch (severity) {
    case 'critical': return 4;
    case 'error': return 3;
    case 'warning': return 2;
    case 'info': return 1;
  }
}

export function findOpenCriticalIssue(issues: HealthIssue[]): HealthIssue | null {
  return issues.find((issue) => issue.state === 'open' && issue.severity === 'critical') ?? null;
}

export function applyObservation(
  store: IssueStore,
  input: {
    id: string;
    severity: IssueSeverity;
    source: string;
    title: string;
    body: string;
    fixable?: boolean;
    repairFn?: string | null;
    learnMore?: string | null;
    debounce?: number;
  },
  now: string,
): HealthIssue | null {
  const threshold = input.debounce ?? DEFAULT_DEBOUNCE_THRESHOLD;
  const existing = store.issues[input.id];

  if (!existing || existing.state === 'resolved') {
    const pending = store.debounce[input.id] ?? { count: 0, lastSeen: now };
    pending.count += 1;
    pending.lastSeen = now;
    store.debounce[input.id] = pending;
    if (pending.count < threshold) return null;
  }

  const issue: HealthIssue = existing && existing.state !== 'resolved'
    ? {
        ...existing,
        severity: input.severity,
        source: input.source,
        title: input.title,
        body: input.body,
        lastSeen: now,
        count: existing.count + 1,
        fixable: input.fixable ?? false,
        repairFn: input.repairFn ?? null,
        learnMore: input.learnMore ?? existing.learnMore ?? null,
      }
    : {
        id: input.id,
        severity: input.severity,
        source: input.source,
        title: input.title,
        body: input.body,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        fixable: input.fixable ?? false,
        repairFn: input.repairFn ?? null,
        learnMore: input.learnMore ?? null,
        state: 'open',
      };

  store.issues[input.id] = issue;
  delete store.debounce[input.id];
  return issue;
}

export function applyResolution(store: IssueStore, id: string, now: string): void {
  delete store.debounce[id];
  const issue = store.issues[id];
  if (issue && issue.state !== 'resolved') {
    issue.state = 'resolved';
    issue.resolvedAt = now;
    issue.lastSeen = now;
  }
}

export function applyIgnore(store: IssueStore, id: string, reason: string, now: string): HealthIssue | null {
  const issue = store.issues[id];
  if (!issue) return null;
  issue.state = 'ignored';
  issue.ignoredReason = reason.trim() || 'No reason provided';
  issue.lastSeen = now;
  return issue;
}
