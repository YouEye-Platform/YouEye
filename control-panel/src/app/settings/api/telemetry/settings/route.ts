/**
 * CP-guaranteed `/settings/api/telemetry/settings` proxy.
 * Root-domain `/api/telemetry/*` is routed to the UI by Caddy from the Settings
 * surface; re-export the CP handlers under the reliable `/settings/api/*` prefix
 * (same pattern as `/settings/api/settings` and `/settings/api/caddy/*`).
 */
export { GET, PATCH } from "@/app/api/telemetry/settings/route";
