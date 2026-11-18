/**
 * One Caddy read-modify-write at a time for setup work that runs side by side
 * (parallel provisioning steps and the background YouEye Names job). Caddy
 * rejects a write whose revision moved (HTTP 412), so two concurrent writers
 * would fail rather than lose updates; serialising them avoids that failure.
 *
 * The queue lives on globalThis so route bundles and instrumentation share it.
 */
const registry = globalThis as typeof globalThis & { __youeyeCaddyMutationTail?: Promise<void> };

export function withCaddyMutation<T>(work: () => Promise<T>): Promise<T> {
  const previous = registry.__youeyeCaddyMutationTail ?? Promise.resolve();
  const run = previous.then(work);
  registry.__youeyeCaddyMutationTail = run.then(() => undefined, () => undefined);
  return run;
}
