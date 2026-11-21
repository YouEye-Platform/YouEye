/**
 * The platform lifecycle helpers of `@/lib/market/update-admission` for route tests that mock it: nothing holds or
 * waits (tests/platform-lifecycle-hold.spec.ts covers the real ones).
 */
export const freeLifecycle = {
  withUserOperationLockWait: <T>(work: () => T | Promise<T>) => Promise.resolve().then(work),
  withPlatformLifecycle: <T>(work: () => T | Promise<T>) => Promise.resolve().then(work),
  holdPlatformLifecycle: async () => ({
    run: <T>(work: () => T | Promise<T>) => Promise.resolve().then(work),
    release() {},
  }),
};
