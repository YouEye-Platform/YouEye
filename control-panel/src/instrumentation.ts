/**
 * Next.js Instrumentation — Control Panel
 *
 * Owns startup of ALL server-side background jobs. Modules must never
 * self-start via import side effects (that pattern put a second health
 * monitor inside youeye-id.service).
 *
 * Two runtime modes share this codebase:
 *  - Control Panel   (youeye-control.service, port 3000) — runs everything.
 *  - Identity service (youeye-id.service, port 3001, IDENTITY_SERVICE=true)
 *    — serves identity/OIDC only; platform jobs (health monitor / watchdog,
 *    DNS provider maintenance, market version/health checkers)
 *    must NOT run there. Running them twice means two watchdogs restarting
 *    containers and two version-checkers racing the installed-apps.json atomic rename.
 */

export async function register() {
  // Keep Node-only imports inside a positive literal runtime branch so
  // Next can remove them from its Edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
    if (isProductionBuild) {
      return;
    }
  
    const { deferCoreStartup } = await import('@/lib/updates/core-startup');
    if (deferCoreStartup(register)) return;
  
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

    // A container's default route belongs on its own network, never on a connection NIC or one of Caddy's app NICs
    // (YE-198): repaired after every container start, and at this start for every running container. Started first:
    // after a reboot Incus has started the apps before this process, and their routes stay wrong until this runs.
    // It waits for Incus by itself and never blocks the startup steps below.
    const { startDefaultRouteWatch } = await import("@/lib/incus/default-route-watch");
    void startDefaultRouteWatch().catch((error) => {
      console.error(`[instrumentation] default route watch did not start: ${error instanceof Error ? error.message : String(error)}`);
    });

    // Console access: Spine's admin accounts follow YouEye ID's admins. Every
    // identity change syncs; this startup and periodic pass repairs a missed one.
    const { startConsoleAccessSync } = await import('@/lib/console-access');
    startConsoleAccessSync();

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
  
    // Port 80 on the live Caddy: the setup server (and no Caddy redirects) or Caddy's own
    // redirects, never neither. Non-fatal; retries while Caddy is not up.
    const { startSetupHttpServerConvergence } = await import("@/lib/caddy/setup-http-startup");
    void startSetupHttpServerConvergence();

    // Pi-hole's own update check stays off on a container created before it was turned off at deploy.
    void (async () => {
      const { containerExists } = await import("@/lib/infrastructure/oci-deployer");
      if (!await containerExists("youeye-pihole")) return;
      const { turnOffPiholeUpdateCheck } = await import("@/lib/infrastructure/pihole-update-check");
      if (await turnOffPiholeUpdateCheck() === 'changed') console.log("[instrumentation] Pi-hole's own update check turned off");
    })().catch((error) => console.error("[instrumentation] Pi-hole's update check could not be turned off:", error));

    // Durable update recovery must precede watchdog, queue and install reconciliation.
    try {
      const { reconcileAppUpdateOperations } = await import("@/lib/market/update-operations");
      await reconcileAppUpdateOperations();
    } catch (error) {
      console.error("[instrumentation] app-update journals could not be inspected; platform reconciliation remains stopped:", error);
      return;
    }

    // An app never has a host port on every address of the box (YE-189): one the Market's native deploy used to add
    // is removed here, after update recovery and before the reconciler starts apps. A failure leaves the device.
    try {
      const { removeAppHostPorts } = await import("@/lib/infrastructure/security-posture");
      const removed = await removeAppHostPorts();
      if (removed.length > 0) console.log(`[instrumentation] removed ${removed.length} app host port(s): ${removed.join(", ")}`);
    } catch (error) {
      console.error(`[instrumentation] app host ports could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  
    // Connection suggestions an installed app no longer asks for (an update before 0.6.15 kept them). Checked once
    // per start, in the background: nothing waits for it, and an app whose installed copy cannot be read is skipped.
    void (async () => {
      const { dropSuggestionsOfDroppedWants } = await import("@/lib/bridges/suggestions");
      const dropped = await dropSuggestionsOfDroppedWants();
      if (dropped > 0) console.log(`[instrumentation] dropped ${dropped} connection suggestion(s) their apps no longer ask for`);
    })().catch((error) => console.error("[instrumentation] connection suggestions could not be checked:", error));

    const { startDnsProviderMaintenanceLoop } = await import("@/lib/dns-providers/maintenance");
    startDnsProviderMaintenanceLoop();
    const { startNamesMaintenanceLoop } = await import("@/lib/youeye-names/maintenance");
    startNamesMaintenanceLoop();
    // Before the watchdog and the prober: they only observe app containers; this queue restarts them.
    const { startAppReconciler } = await import("@/lib/apps/app-reconciler");
    startAppReconciler();
    const { startHealthMonitor } = await import("@/lib/health/monitor");
    startHealthMonitor();
    const { startBackgroundChecks } = await import("@/lib/apps/update-cache");
    startBackgroundChecks();
    // The UI reports the installed release (it cannot read State); republished whenever the accepted release changes.
    const { startUIReleasePublisher } = await import("@/lib/releases/installed-release");
    startUIReleasePublisher();
    const { startVersionChecker } = await import("@/lib/market/version-checker");
    startVersionChecker();
    const { startHealthChecker } = await import("@/lib/market/health-checker");
    startHealthChecker();
    // App starts that asked for their connections to be wired again, served without the reconcile round (YE-224).
    const { startRewireWatch } = await import("@/lib/bridges/manager");
    startRewireWatch();
    const { startBackupScheduler } = await import("@/lib/backup/scheduler");
    startBackupScheduler();
    const { reconcileInstalledAdmission } = await import('@/lib/admission/lifecycle');
    const { startAdmissionProjectionLoop } = await import('@/lib/admission/projection');
    const { getIdentityIssuerOrigin } = await import('@/lib/identity/config');
    let admissionAwaitsSetup = false;
    const reconcileAdmission = () => {
      void (async () => {
        // Before setup the box has no domain: no app is installed and there is no sign-in address to gate a
        // route with. That is not a failure; say so once and look again.
        if (!await getIdentityIssuerOrigin()) {
          if (!admissionAwaitsSetup) console.log('[admission] The box has no domain yet; app admission starts after setup');
          admissionAwaitsSetup = true;
          setTimeout(reconcileAdmission, 20_000);
          return;
        }
        await reconcileInstalledAdmission();
        startAdmissionProjectionLoop();
      })().catch(() => {
        console.error('[admission] Installation ownership or ingress reconciliation failed; admission remains pending');
        // A transient startup failure must not permanently disable lease refresh.
        // Only the complete ownership and gateway proof starts the projection loop.
        setTimeout(reconcileAdmission, 20_000);
      });
    };
    reconcileAdmission();
  
    // Reconcile durable install/network ownership immediately at Control Panel
    // startup. The periodic Health pass remains the long-running owner, while
    // this first pass closes interrupted operations and raises blocking critical
    // issues before ordinary app-management traffic can proceed.
    const { runStartupReconciliation } = await import("@/lib/incus/startup-reconciliation");
    void runStartupReconciliation().catch(() => {
      console.error("[instrumentation] startup reconciliation exhausted; see System Health for repair");
    });
  }
}
