/** Ids of the Market's own app routes, so they can be told apart from platform and hand-made routes. */
const APP_ROUTE_ID = /^app-route-([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])-\d+-[a-z0-9]+$/;

/** The id of an app's own route. Only these routes are ever offered as orphans (lib/market/orphan-detector.ts). */
export function appRouteId(appId: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(appId)) throw new Error(`Invalid app id for a route: ${appId}`);
  return `app-route-${appId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** The app an app route belongs to, or null for any other route (platform, hand-made, or created before 0.6.8). */
export function appIdFromRouteId(id: string): string | null {
  return APP_ROUTE_ID.exec(id)?.[1] ?? null;
}
