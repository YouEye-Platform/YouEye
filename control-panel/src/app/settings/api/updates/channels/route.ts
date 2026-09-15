/**
 * CP-guaranteed `/settings/api/updates/channels` proxy for the release-channels
 * route. Root-domain `/api/*` is Caddy-routed to the UI container, so the
 * Settings surface reaches the Control Panel's channel endpoints via the
 * reliably-CP-routed `/settings/api/*` prefix. Re-exports the same admin
 * handlers (GET reads channels; PUT proxies channel edits to Spine).
 */
export { GET, PUT } from "@/app/api/updates/channels/route";
