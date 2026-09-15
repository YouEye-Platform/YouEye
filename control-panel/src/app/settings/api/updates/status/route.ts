/**
 * CP-guaranteed Settings progress endpoint. Root-domain `/api/*` requests are
 * normally routed to the UI container, while `/settings/api/*` is guaranteed
 * to reach Control Panel. Reuse the same authenticated admin handler.
 */
export { GET } from '@/app/api/updates/status/route';
