/**
 * Resource Policy — sets OOM scores and CPU priority on Incus containers.
 *
 * Two priority levels:
 *   critical — infrastructure (CP, Authentik, Caddy, PG, Pi-Hole, UI)
 *   normal   — all user-installed apps (native and marketplace)
 *
 * Under CPU contention, critical containers get ~2x the CPU share.
 * Under OOM pressure, the kernel kills normal containers first.
 */

import { incusRequest } from '../incus/server';

type Priority = 'critical' | 'normal';

const PRIORITY_MAP = {
  critical: { cpuPriority: '10', oomScore: '-999' },
  normal:   { cpuPriority: '5',  oomScore: '0' },
} as const;

export async function applyResourcePolicy(
  containerName: string,
  priority: Priority
): Promise<void> {
  const p = PRIORITY_MAP[priority];
  await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
    config: {
      'limits.cpu.priority': p.cpuPriority,
      'raw.lxc': `lxc.init.oom_score_adj = ${p.oomScore}`,
    },
  });
}
