/**
 * Persist required route failures as retryable setup errors. The caller uses
 * the returned flag to prevent marking the appliance setup complete.
 */
export async function recordSetupRouteResult(
  errors: string[],
  successMessage: string,
  report: (state: 'done' | 'error', message: string) => void,
  persist: (state: 'done' | 'error') => Promise<void>,
): Promise<boolean> {
  const failed = errors.length > 0;
  const state = failed ? 'error' : 'done';
  await persist(state);
  report(state, failed ? `Required route reconciliation failed: ${errors.join('; ')}` : successMessage);
  return failed;
}
