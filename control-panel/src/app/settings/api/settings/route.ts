/**
 * CP-guaranteed `/settings/api/settings` proxy for the platform settings route.
 *
 * `/api/settings` exists but is NOT reachable from the root-domain Settings
 * surface — Caddy routes most root-domain `/api/*` to the UI container, so
 * `lemon.app/api/settings` 404s. The `/settings/api/*` prefix is reliably
 * routed to Control Panel (same as `/settings/api/settings/system`). Re-export
 * the same admin handlers here so the System page's Core Update Source card can
 * load and save (System core / Server interface / dashboard release source).
 */
export { GET, PATCH } from "@/app/api/settings/route";
