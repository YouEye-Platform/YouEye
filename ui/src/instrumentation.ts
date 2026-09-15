/**
 * Next.js Instrumentation — YouEye UI
 *
 * Process-start runtime configuration + telemetry tracker init.
 * The tracker persists route usage data to disk for dead code detection
 * (temporary — will be removed after beta period).
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Happy-eyeballs fix for dual-stack hosts without a working IPv6 route:
    // Node 22's default autoSelectFamily attempt timeout (250 ms) is too
    // short for the IPv6 attempt to fail over to IPv4, so upstream fetches
    // from the app internet gateway (/api/apps/v1/internet) died with
    // ETIMEDOUT (~340 ms) — observed live as "Weather location search
    // returns no results". 2000 ms was validated in-container on clone .80
    // and matches the earlier Weather app runtime fix.
    const net = await import("net");
    net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

    // Import tracker to initialize it (starts flush interval)
    await import("@/lib/telemetry/tracker");
  }
}
