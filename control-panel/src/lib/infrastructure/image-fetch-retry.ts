/**
 * Retry for remote OCI image fetches (Incus `protocol: oci` → skopeo).
 *
 * A box's LAN resolver can time out for a moment; Incus then fails the whole
 * create/rebuild with a skopeo error even though an immediate retry succeeds.
 * Only network-shaped failures are retried. Registry answers that will not
 * change (unknown manifest, auth refusals, not found, digest mismatch) fail at once.
 */

/**
 * Delays before attempts 2–6 (about 3 minutes in all). A home resolver can stay slow for over a minute;
 * three retries in 50 s still failed installs on a test box with flaky LAN DNS.
 */
export const IMAGE_FETCH_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000] as const;

const PERMANENT_PATTERNS: RegExp[] = [
  /manifest unknown/i,
  /\bMANIFEST_UNKNOWN\b/,
  /\bNAME_UNKNOWN\b/,
  /\bunauthorized\b/i,
  /\bdenied\b/i,
  /\bforbidden\b/i,
  /repository does not exist/i,
  /\bnot found\b/i,
  /\b40[134]\b/,
  /digest (?:mismatch|did not match|does not match)/i,
  /does not match (?:the )?(?:expected )?digest/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /i\/o timeout/i,
  /\blookup\s+\S+.*?(?:timeout|timed out|no such host|server misbehaving|temporary failure)/i,
  /temporary failure in name resolution/i,
  /server misbehaving/i,
  /connection reset/i,
  /connection refused/i,
  /network is unreachable/i,
  // A registry address over IPv6 on a box without IPv6 connectivity; the next attempt usually picks IPv4.
  /cannot assign requested address/i,
  /no route to host/i,
  /TLS handshake timeout/i,
  /unexpected EOF/i,
  /context deadline exceeded/i,
  /Client\.Timeout exceeded/i,
  /\btoomanyrequests\b/i,
  /too many requests/i,
  /\b429\b/,
  /\b50[0234]\b/,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /internal server error/i,
];

/** Text of an error and all of its causes, outermost first. */
export function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ');
}

/** True for network/DNS/registry-availability failures worth another attempt. */
export function isTransientImageFetchError(error: unknown): boolean {
  // Digests are hex and may contain runs that look like status codes.
  const text = errorChainText(error).replace(/sha256:[0-9a-f]{64}/gi, 'sha256:<digest>');
  if (PERMANENT_PATTERNS.some(pattern => pattern.test(text))) return false;
  return TRANSIENT_PATTERNS.some(pattern => pattern.test(text));
}

/** Registry refused the image for a reason a retry cannot fix. */
export function isUnavailableImageError(error: unknown): boolean {
  const text = errorChainText(error).replace(/sha256:[0-9a-f]{64}/gi, 'sha256:<digest>');
  return PERMANENT_PATTERNS.some(pattern => pattern.test(text));
}

export class ImageFetchCancelledError extends Error {
  constructor(cause: unknown) {
    super('Cancelled while waiting to retry the app image download', { cause });
    this.name = 'ImageFetchCancelledError';
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ImageFetchRetryOptions {
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  /** Called before each retry; return false to stop retrying (e.g. state changed). */
  beforeRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  label?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `attempt` up to `delaysMs.length + 1` times, retrying only transient
 * image-fetch failures. The abort signal stops both waiting and further attempts.
 */
export async function retryImageFetch<T>(
  attempt: () => Promise<T>,
  options: ImageFetchRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? IMAGE_FETCH_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let index = 0; ; index++) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= delays.length || !isTransientImageFetchError(error)) throw error;
      if (options.signal?.aborted) throw new ImageFetchCancelledError(error);
      if (options.beforeRetry && !(await options.beforeRetry(error, index + 1))) throw error;
      // Innermost cause carries the network detail; signed URL queries are dropped.
      const reason = errorChainText(error).split(' <- ').pop()!.replace(/\?[^\s"'<>]*/g, '').slice(-600);
      console.warn(`[image-fetch] ${options.label ?? 'Image fetch'} failed transiently `
        + `(attempt ${index + 1}/${delays.length + 1}); retrying in ${Math.round(delays[index] / 1000)}s: ${reason}`);
      try {
        await sleep(delays[index], options.signal);
      } catch {
        throw new ImageFetchCancelledError(error);
      }
      if (options.signal?.aborted) throw new ImageFetchCancelledError(error);
    }
  }
}
