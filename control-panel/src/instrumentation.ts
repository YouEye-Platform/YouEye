/**
 * Next.js Instrumentation — Control Panel
 *
 * Owns startup of ALL server-side background jobs. Modules must never
 * self-start via import side effects (that pattern put a second health
 * monitor and a second update-queue worker inside youeye-id.service).
 *
 * Two runtime modes share this codebase:
 *  - Control Panel   (youeye-control.service, port 3000) — runs everything.
 *  - Identity service (youeye-id.service, port 3001, IDENTITY_SERVICE=true)
 *    — serves identity/OIDC only; platform jobs (health monitor / watchdog,
 *    DNS provider maintenance, update queue, market version/health checkers)
 *    must NOT run there. Running them twice means two watchdogs restarting
 *    containers, two queue workers racing the same update store, and two
 *    version-checkers racing the installed-apps.json atomic rename.
 */

export async function register() {
  const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
  if (process.env.NEXT_RUNTIME !== "nodejs" || isProductionBuild) {
    return;
  }

  // Import tracker to initialize it (starts flush interval)
  await import("@/lib/telemetry/tracker");

  const isIdentityService = process.env.IDENTITY_SERVICE === "true";
  if (isIdentityService) {
    console.log("[instrumentation] identity service mode — platform background jobs skipped");
    return;
  }

  // The app-network pool is a deployment-time fact because Incus chooses its
  // system bridge independently. Persist the bounded, collision-free plan
  // before any health loop or app reconciliation can initialize IPAM state.
  try {
    const { ensureAppNetworkBootstrapConfig } = await import("@/lib/incus/app-network");
    const result = await ensureAppNetworkBootstrapConfig();
    if (result.changed) {
      console.log(`[instrumentation] app-network bootstrap selected ${result.selectedPools.join(", ")}`);
    }
  } catch {
    console.error("[instrumentation] app-network bootstrap could not be proved; reconciliation will fail closed");
  }

  const { startDnsProviderMaintenanceLoop } = await import("@/lib/dns-providers/maintenance");
  startDnsProviderMaintenanceLoop();
  const { startNamesMaintenanceLoop } = await import("@/lib/youeye-names/maintenance");
  startNamesMaintenanceLoop();
  const { startHealthMonitor } = await import("@/lib/health/monitor");
  startHealthMonitor();
  const { startWorker } = await import("@/lib/updates/queue");
  startWorker();
  const { startVersionChecker } = await import("@/lib/market/version-checker");
  startVersionChecker();
  const { startHealthChecker } = await import("@/lib/market/health-checker");
  startHealthChecker();
  const { startSystemUpdateChecker } = await import("@/lib/appliance/system-update-checker");
  startSystemUpdateChecker();
  const { startBackupScheduler } = await import("@/lib/backup/scheduler");
  startBackupScheduler();

  // Reconcile durable install/network ownership immediately at Control Panel
  // startup. The periodic Health pass remains the long-running owner, while
  // this first pass closes interrupted operations and raises blocking critical
  // issues before ordinary app-management traffic can proceed.
  const { reconcileApps } = await import("@/lib/market/reconciler");
  void reconcileApps().catch(() => {
    console.error("[instrumentation] startup app reconciliation failed; see System Health for safe diagnostics");
  });

  // Self-heal the root-domain CP-surface routes (/settings, /market + the
  // Referer-gated support route) so path-allowlist additions in the generator
  // reach existing installs on the next CP restart — without this, new
  // CP endpoints called from the root-domain Settings surface 404 against the
  // UI container forever (found via /api/setup/reconfigure, 0407-urlchange).
  void (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 15_000));
        const { settingsService } = await import("@/lib/settings");
        const raw = await settingsService.getRaw();
        if (!raw.setup_completed || !raw.domain) return;
        const caddy = await import("@/lib/caddy/client");
        if (!(await caddy.checkHealth())) continue;
        await caddy.ensureControlSettingsRoute(raw.domain);
        await caddy.ensurePointerInferenceRoutes(raw.domain);
        console.log("[instrumentation] control and AI inference routes reconciled for", raw.domain);
        return;
      } catch (err) {
        console.warn(`[instrumentation] control-route reconcile attempt ${attempt + 1} failed:`, err);
      }
    }
    console.error("[instrumentation] control-route reconcile gave up after 5 attempts");
  })();
}
