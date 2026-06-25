/**
 * Auth barrel export
 * Re-exports all auth utilities for convenient imports.
 */

export {
  getOAuthConfig,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  generateOAuthState,
  isSSOConfigured,
} from "./authentik";

export {
  createSession,
  verifySession,
  getSession,
  setSessionCookies,
  clearSessionCookies,
  generateCSRFToken,
  type SessionPayload,
} from "./session";

export { resolveServiceAuth } from "./service";
