/**
 * CP-guaranteed `/settings/api/updates/[component]` proxy for the component
 * update route. Root-domain `/api/*` is Caddy-routed to the UI container, so the
 * Settings surface triggers component updates (incl. confirm_switch channel
 * switches) through the reliably-CP-routed `/settings/api/*` prefix.
 */
export { POST } from "@/app/api/updates/[component]/route";
