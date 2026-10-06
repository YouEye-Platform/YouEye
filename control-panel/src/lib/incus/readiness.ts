import { incusRequest } from './server';

/** Keep transport diagnostics useful without exposing URLs, credentials or response bodies. */
export function safeIncusFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = message.match(/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOENT|EACCES)\b/)?.[1];
  if (code) return code;
  if (/timeout|timed out/i.test(message)) return 'TIMEOUT';
  if (/untrusted|unauthori[sz]ed|forbidden/i.test(message)) return 'AUTHENTICATION';
  return 'API_UNAVAILABLE_OR_INVALID_RESPONSE';
}

export async function waitForIncusReady(
  options: { timeoutMs?: number; retryMs?: number; probeTimeoutMs?: number } = {},
  probe: (timeout: number) => Promise<void> = async (timeout) => {
    const response = await incusRequest<{ auth?: string }>('GET', '/1.0', undefined, { timeout, deadlineMs: timeout });
    if (response.type !== 'sync' || response.metadata?.auth !== 'trusted') {
      throw new Error('Incus transport is untrusted');
    }
  },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const retryMs = options.retryMs ?? 2_000;
  let reason = 'API_UNAVAILABLE_OR_INVALID_RESPONSE';
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = Math.min(options.probeTimeoutMs ?? 5_000, remaining);
      await Promise.race([
        probe(timeout),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Incus readiness probe timeout')), timeout);
        }),
      ]);
      return;
    } catch (error) {
      reason = safeIncusFailure(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const delay = Math.min(retryMs, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  } while (Date.now() < deadline);
  throw new Error(`Incus authenticated API readiness exhausted (${reason}); check Incus and retry reconciliation`);
}
