import type { ContainerMeta } from '@/lib/market/types';

export type ContainerRole = NonNullable<ContainerMeta['role']>;

export interface ContainerTarget {
  name: string;
  role: ContainerRole;
  primary: boolean;
  order: number;
}

/**
 * Roles read from a sidecar's own name (its manifest name, the part after `app-<id>-`), never from the app id: an app
 * whose id holds "db" or "job" must not turn its main container into a database or a worker.
 */
const NAME_ROLES: Array<[ContainerRole, RegExp]> = [
  ['database', /(postgres|mysql|mariadb|mongo|database|\bdb\b)/],
  ['cache', /(redis|valkey|keydb|memcached|cache)/],
  ['worker', /(worker|queue|cron|scheduler|job)/],
];

function inferRole(container: ContainerMeta, primary: boolean): ContainerRole {
  if (container.role) return container.role;
  // The main container is the app, whatever its name.
  if (primary) return 'app';
  const name = (container.name ?? '').toLowerCase();
  return NAME_ROLES.find(([, pattern]) => pattern.test(name))?.[0] ?? 'sidecar';
}

/** An app's containers with the role that orders their start and stop. */
export function containerTargets(containers: ContainerMeta[] | undefined): ContainerTarget[] {
  const raw = containers ?? [];
  const primaryIndex = raw.findIndex((c) => c.primary);

  return raw
    .map((entry, index) => {
      const primary = entry.primary === true || (primaryIndex === -1 && index === 0);
      return {
        name: entry.containerName,
        role: inferRole(entry, primary),
        primary,
        order: index,
      };
    })
    .filter((container) => !!container.name);
}

/** The role of the app container `containerName` (undefined when the app has no such container). */
export function containerRole(containers: ContainerMeta[] | undefined, containerName: string): ContainerRole | undefined {
  return containerTargets(containers).find(container => container.name === containerName)?.role;
}

/** Start: database, cache, sidecar, worker, app. Stop: the reverse, so a database loses its clients first. */
export function orderContainers(containers: ContainerTarget[], action: 'start' | 'stop'): ContainerTarget[] {
  const startRank: Record<ContainerRole, number> = {
    database: 0,
    cache: 1,
    sidecar: 2,
    worker: 3,
    app: 4,
  };
  const stopRank: Record<ContainerRole, number> = {
    app: 0,
    worker: 1,
    sidecar: 2,
    cache: 3,
    database: 4,
  };
  const ranks = action === 'start' ? startRank : stopRank;
  return [...containers].sort((a, b) => {
    const byRole = ranks[a.role] - ranks[b.role];
    if (byRole !== 0) return byRole;
    return action === 'start' ? a.order - b.order : b.order - a.order;
  });
}
