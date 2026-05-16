/**
 * Next.js Instrumentation — Control Panel
 *
 * Initializes the telemetry tracker on server startup.
 * The tracker persists route usage data to disk for dead code detection.
 *
 * Temporary — will be removed after beta period.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import tracker to initialize it (starts flush interval)
    await import("@/lib/telemetry/tracker");
  }
}
