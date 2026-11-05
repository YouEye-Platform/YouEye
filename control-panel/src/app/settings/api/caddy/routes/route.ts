// Re-export the Caddy routes handler under the CP-guaranteed /settings/api/* prefix.
// Root /api/caddy/* is not routed to CP from the Settings surface (404 → UI), the
// same reason /settings/api/settings exists. Read-only (GET) for the Routes tab.
export { GET } from "@/app/api/caddy/routes/route";
