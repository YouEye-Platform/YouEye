/**
 * CP-guaranteed `/settings/api/telemetry/export` proxy.
 * Root-domain `/api/telemetry/*` is routed to the UI by Caddy from the Settings
 * surface; re-export the CP handlers under the reliable `/settings/api/*` prefix.
 */
export { GET, DELETE } from "@/app/api/telemetry/export/route";
