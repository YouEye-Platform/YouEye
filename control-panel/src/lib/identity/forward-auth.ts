/**
 * Caddy forward-auth decision with short in-process caching (see forward-auth-cache.ts).
 * The route supplies the database-backed lookups; this module decides and caches.
 */
import { createHash } from 'node:crypto';
import type { AdmissionDecision, AdmissionPolicy } from '../../../../shared/admission';
import { forwardAuthCaches, type ForwardAuthCaches } from './forward-auth-cache';

export interface ForwardAuthIdentity { userId: string; headers: Record<string, string> }

export interface ForwardAuthDeps {
  /** Every admission route on this host, with its app's policy. */
  hostRoutes(host: string): Promise<Array<{ pathPrefix: string; policy: AdmissionPolicy }>>;
  /** Exact machine callbacks for an installation on this host. */
  machineCallbacks(installationId: string, host: string): Promise<Array<{ method: string; path: string }>>;
  /** Whether the app's public-access projection is applied. */
  publicAccessApplied(appId: string): Promise<boolean>;
  /** Verify the identity session cookie; null when it is not a live session. */
  identify(token: string): Promise<ForwardAuthIdentity | null>;
  evaluate(appId: string, userId: string): Promise<AdmissionDecision>;
}

export type ForwardAuthResult =
  | { kind: 'unknown_route' }
  | { kind: 'pass' }
  | { kind: 'login' }
  | { kind: 'deny'; pending: boolean }
  | { kind: 'allow'; headers: Record<string, string> };

/** Same rule as the SQL route match: exact, '/' or a whole-segment prefix; longest wins. */
export function matchAdmissionRoute<T extends { pathPrefix: string }>(routes: T[], path: string): T | null {
  let best: T | null = null;
  for (const route of routes) {
    const prefix = route.pathPrefix;
    const matches = path === prefix || prefix === '/' || path.startsWith(`${prefix}/`);
    if (matches && (!best || prefix.length > best.pathPrefix.length)) best = route;
  }
  return best;
}

type SessionDecision = { kind: 'login' } | { kind: 'deny'; pending: boolean } | { kind: 'allow'; headers: Record<string, string> };

export async function checkForwardAuth(
  input: { host: string; path: string; method: string; sessionToken?: string | null },
  deps: ForwardAuthDeps,
  caches: ForwardAuthCaches = forwardAuthCaches(),
): Promise<ForwardAuthResult> {
  const { host, path, method } = input;
  if (!/^[a-z0-9.-]+$/.test(host) || !path.startsWith('/')) return { kind: 'unknown_route' };

  const routes = await caches.hostRoutes.getOrLoad(host, () => deps.hostRoutes(host)) as
    Array<{ pathPrefix: string; policy: AdmissionPolicy }>;
  const policy = matchAdmissionRoute(routes, path)?.policy;
  if (!policy) return { kind: 'unknown_route' };

  // Exact native signed-logout transport authenticates itself; no identity
  // headers or browser admission are supplied for machine callbacks.
  if (policy.state === 'ready') {
    const callbacks = await caches.callbacks.getOrLoad(`${policy.installationId}|${host}`, async () =>
      new Set((await deps.machineCallbacks(policy.installationId, host)).map(c => `${c.method} ${c.path}`))) as Set<string>;
    if (callbacks.has(`${method} ${path}`)) return { kind: 'pass' };
  }
  if (policy.publicAccess && policy.state === 'ready'
    && await caches.publicApplied.getOrLoad(policy.appId, () => deps.publicAccessApplied(policy.appId))) {
    return { kind: 'pass' };
  }

  const token = input.sessionToken;
  if (!token) return { kind: 'login' };
  // The raw cookie never becomes a map key; the policy revision keys out stale grants.
  const sessionKey = createHash('sha256').update(token).digest('hex');
  try {
    return await caches.decisions.getOrLoad(
      `${sessionKey}|${host}|${policy.installationId}:${policy.revision}`,
      async (): Promise<SessionDecision> => {
        const identity = await deps.identify(token);
        // Token verification folds lookup failures into "no session", so this
        // outcome is shared with concurrent waiters but never cached.
        if (!identity) throw new UncachedLogin();
        const admission = await deps.evaluate(policy.appId, identity.userId);
        if (!admission.allowed) return { kind: 'deny', pending: admission.reason === 'policy_pending' };
        return { kind: 'allow', headers: identity.headers };
      },
    ) as SessionDecision;
  } catch (error) {
    if (error instanceof UncachedLogin) return { kind: 'login' };
    throw error;
  }
}

class UncachedLogin extends Error {}
