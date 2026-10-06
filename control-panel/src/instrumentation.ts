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
    const { deliverDueLogouts } = await import('@/lib/identity/backchannel-logout');
    const run = () => void deliverDueLogouts().catch(() => undefined);
    setTimeout(run, 5_000);
    setInterval(run, 30_000);
    console.log("[instrumentation] identity service mode — platform background jobs skipped");
    return;
  }

  // The app-network pool is a deployment-time fact because Incus chooses its
  // system bridge independently. Persist the bounded, collision-free plan
  // before any health loop or app reconciliation can initialize IPAM state.
  try {
    const { waitForIncusReady } = await import("@/lib/incus/readiness");
    await waitForIncusReady();
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
  const { runStartupReconciliation } = await import("@/lib/incus/startup-reconciliation");
  void runStartupReconciliation().catch(() => {
    console.error("[instrumentation] startup reconciliation exhausted; see System Health for repair");
  });
}
