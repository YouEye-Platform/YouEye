/** Who may call the CP's /api/ui-bridge/* routes (see `requireEmbedAdmin` in ./auth). */

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface EmbedBridgeRefusal {
  status: 401 | 403;
  error: string;
}

/** The decision alone, without request plumbing (tested directly). */
export function embedBridgeDecision(input: {
  method: string;
  session: { isAdmin?: boolean; authMethod?: string } | null;
  csrfValid: boolean;
}): EmbedBridgeRefusal | null {
  if (!input.session) return { status: 401, error: 'Sign in required' };
  // A setup session is restricted to onboarding; the middleware also refuses it.
  if (input.session.authMethod === 'setup') return { status: 403, error: 'Not available during setup' };
  if (input.session.isAdmin !== true) return { status: 403, error: 'Admin access required' };
  if (!SAFE_METHODS.has(input.method.toUpperCase()) && !input.csrfValid) {
    return { status: 403, error: 'Invalid CSRF token' };
  }
  return null;
}
