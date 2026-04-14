/**
 * Resource Policy — sets OOM scores and CPU priority on Incus containers.
 *
 * Two priority levels:
 *   critical — infrastructure (CP, Authentik, Caddy, PG, Pi-Hole, UI)
 *   normal   — all user-installed apps (native and marketplace)
 *
 * Under CPU contention, critical containers get ~2x the CPU share.
 * Under OOM pressure, the kernel kills normal containers first.
 *
 * OOM scores use /proc/1/oom_score_adj inside each container (0–1000).
 * Negative values require CAP_SYS_ADMIN which unprivileged containers lack.
 * Strategy: infrastructure at 0 (default, least likely killed),
 *           app containers at 500 (killed first under pressure).
 */

import { incusRequest } from '../incus/server';
import { execShell } from '../incus/server';

type Priority = 'critical' | 'normal';

const PRIORITY_MAP = {
  critical: { cpuPriority: '10', oomScore: '0' },
  normal:   { cpuPriority: '5',  oomScore: '500' },
} as const;

export async function applyResourcePolicy(
  containerName: string,
  priority: Priority
): Promise<void> {
  const p = PRIORITY_MAP[priority];

  // Set CPU priority via Incus config (works on all container types)
  await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
    config: {
      'limits.cpu.priority': p.cpuPriority,
    },
  });

  // Set OOM score by writing directly to /proc/1/oom_score_adj inside the container.
  // This bypasses the broken raw.lxc approach (lxc.init.oom_score_adj is not a valid
  // Incus 6.x config key). May fail on containers without a running init — best effort.
  try {
    await execShell(containerName, `echo ${p.oomScore} > /proc/1/oom_score_adj`, { timeout: 5_000 });
  } catch {
    // OOM score is best-effort — container may not support it
  }
}
