/**
 * Server-side API route tracking helper.
 *
 * Import and call at the top of API route handlers to track usage.
 * This runs in the Node.js runtime (not Edge), so it can access the tracker directly.
 *
 * Usage:
 *   import { trackApi } from "@/lib/telemetry/track-api";
 *   export async function GET(request: NextRequest) {
 *     trackApi("/api/v1/widgets");
 *     // ... handler logic
 *   }
 */

import { trackRoute, trackError } from "./tracker";

export function trackApi(route: string): void {
  trackRoute(route);
}

export function trackApiError(route: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  trackError(route, message);
}
