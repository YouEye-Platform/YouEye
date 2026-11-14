/** /reset-owner is the short address; the page lives under /settings, which every host routes to the Control Panel. */
export function GET() {
  return new Response(null, { status: 307, headers: { Location: '/settings/reset-owner' } });
}
