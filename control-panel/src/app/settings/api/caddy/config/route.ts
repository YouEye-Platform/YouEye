// Re-export the raw Caddy config handler under the CP-guaranteed /settings/api/*
// prefix (root /api/caddy/* 404s → UI from the Settings surface). Read-only (GET)
// for the Routes tab's collapsed advanced view.
export { GET } from "@/app/api/caddy/config/route";
