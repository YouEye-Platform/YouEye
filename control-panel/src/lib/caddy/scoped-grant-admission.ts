import type { CaddyRoute, RouteHandler } from './types';

/** Machine grants retain their exact token/host/path/method matcher. Browser
 * admission must neither replace it nor add a login redirect to this route. */
export function scopedGrantHandlers(route: CaddyRoute): RouteHandler[] | null {
  if (!route['@id']?.startsWith('app-grant-') || route['@id'] === 'app-grant-token-deny') return null;
  const match = route.match?.[0] as (NonNullable<CaddyRoute['match']>[number] & {
    header?: Record<string, string[]>;
  }) | undefined;
  const tokens = match?.header?.['X-Youeye-App-Token'];
  if (route.match?.length !== 1 || match?.host?.length !== 1 || !match.path?.length
    || !match.method?.length || tokens?.length !== 1 || !tokens[0] || tokens[0] === '*'
    || route.terminal !== true) throw new Error('Invalid scoped app grant; preserve fail-closed routing');
  const handlers = route.handle.filter(handler => {
    const h = handler as Record<string, unknown>;
    const request = h.request as { delete?: string[] } | undefined;
    const rewrite = h.rewrite as { uri?: string } | undefined;
    return !(h.handler === 'headers' && request?.delete?.includes('X-YouEye-User'))
      && !(h.handler === 'reverse_proxy' && rewrite?.uri === '/forward-auth/caddy');
  });
  if (handlers.length !== 1 || handlers[0].handler !== 'reverse_proxy'
    || !('upstreams' in handlers[0]) || 'handle_response' in handlers[0]) {
    throw new Error('Unexpected scoped app grant handlers; preserve fail-closed routing');
  }
  return handlers;
}
