import { waitForIncusReady } from './readiness';

export const STARTUP_RECONCILIATION_ISSUE = 'platform.startup-reconciliation';
let inFlight: Promise<void> | null = null;
let outcome: 'pending' | 'failed' | 'healthy' = 'pending';

export interface StartupReconciliationDependencies {
  ready: () => Promise<void>;
  bootstrap: () => Promise<unknown>;
  apps: () => Promise<{ unresolved: string[] }>;
  routes: () => Promise<void>;
}

/** One bounded coordinator; imports never start workers in the identity process. */
export function runStartupReconciliation(
  overrides: Partial<StartupReconciliationDependencies> = {},
  options: { attempts?: number; retryMs?: number } = {},
): Promise<void> {
  if (inFlight) return inFlight;
  const dependencies: StartupReconciliationDependencies = {
    ready: () => waitForIncusReady(),
    bootstrap: async () => (await import('./app-network')).ensureAppNetworkBootstrapConfig(),
    apps: async () => (await import('@/lib/market/reconciler')).reconcileApps(),
    routes: async () => {
      const raw = await (await import('@/lib/settings')).settingsService.getRaw();
      if (!raw.setup_completed || !raw.domain) return;
      await (await import('@/lib/caddy/client')).reconcileManagedRoutes(raw.domain);
    },
    ...overrides,
  };
  outcome = 'pending';
  inFlight = (async () => {
    for (let attempt = 0; attempt < (options.attempts ?? 5); attempt++) {
      try {
        await dependencies.ready();
        let appFailure: unknown;
        try {
          await dependencies.bootstrap();
          const result = await dependencies.apps();
          if (result.unresolved.length > 0) throw new Error('App reconciliation has unresolved divergences');
        } catch (error) {
          appFailure = error;
        }
        // App divergence must not prevent repairing Settings/Market access.
        await dependencies.routes();
        if (appFailure) throw appFailure;
        outcome = 'healthy';
        console.log('[instrumentation] authenticated Incus startup and managed routes verified');
        return;
      } catch {
        console.warn(`[instrumentation] startup reconciliation attempt ${attempt + 1} failed; working routes retained`);
      }
      if (attempt + 1 < (options.attempts ?? 5)) {
        await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2_000));
      }
    }
    outcome = 'failed';
    throw new Error('Startup reconciliation exhausted; check Incus and use System Health repair');
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The existing health loop persists this once its Incus-backed store is available. */
export async function syncStartupReconciliationIssue(): Promise<void> {
  const { observeIssue, resolveIssue } = await import('@/lib/health/issues');
  if (outcome === 'failed') {
    await observeIssue({
      id: STARTUP_RECONCILIATION_ISSUE, severity: 'error', source: 'startup-reconciliation',
      title: 'Startup reconciliation needs repair',
      body: 'Authenticated Incus readiness or app/proxy reconciliation exhausted its retries. Check Incus, then run this repair. Existing proxy routes were retained where discovery failed.',
      fixable: true, repairFn: 'reconcile-startup', debounce: 1,
    });
  } else if (outcome === 'healthy') {
    await resolveIssue(STARTUP_RECONCILIATION_ISSUE);
  }
}
