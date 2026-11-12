import { sanitizeDeploymentDetail } from '@/lib/infrastructure/deployment-safety';

const MAX_REASON_LENGTH = 200;

/**
 * A short, operator-safe reason for a failed setup step: the first line of the
 * error, with credentials (key=value secrets, bearer tokens, URL userinfo)
 * redacted and the length bounded. The full error goes to the service log.
 */
export function setupStepReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const reason = sanitizeDeploymentDetail(firstLine.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1<redacted>@'));
  if (!reason) return 'unknown error';
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

export type SetupStepErrors = Record<string, string>;

/**
 * Next persisted `setup_step_errors` block: a failed step records its reason,
 * any other state clears it. Returns null when no reasons remain so the
 * foreign youeye.yaml block is deleted instead of kept empty.
 */
export function nextSetupStepErrors(
  current: SetupStepErrors,
  stepId: string,
  state: 'pending' | 'done' | 'error',
  reason?: string,
): SetupStepErrors | null {
  const next = { ...current };
  if (state === 'error' && reason) next[stepId] = reason;
  else delete next[stepId];
  return Object.keys(next).length ? next : null;
}
