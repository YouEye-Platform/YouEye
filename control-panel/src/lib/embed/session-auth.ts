/**
 * Embed Session Authentication
 *
 * Replaces HMAC-signed URL tokens with session-based auth.
 * Embeds now use the same SSO session as the main CP.
 *
 * Benefits:
 * - YE-UI doesn't need the bridge token (one-way bridge)
 * - User's own permissions apply (RBAC)
 * - No token expiration issues within iframe
 */

import { getSession, type SessionPayload } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/rbac";

export interface EmbedAuthResult {
  authenticated: boolean;
  authorized: boolean;
  session: SessionPayload | null;
  reason?: string;
}

/**
 * Validate embed access using session cookie
 *
 * @param requiredRole - 'admin' for admin-only embeds, 'user' for any authenticated user
 */
export async function validateEmbedSession(
  requiredRole: Role = "admin"
): Promise<EmbedAuthResult> {
  const session = await getSession();

  if (!session) {
    return {
      authenticated: false,
      authorized: false,
      session: null,
      reason: "Sign in to YouEye to view this panel",
    };
  }

  if (requiredRole === "admin" && !session.isAdmin) {
    return {
      authenticated: true,
      authorized: false,
      session,
      reason: "Administrator access required",
    };
  }

  return {
    authenticated: true,
    authorized: true,
    session,
  };
}

/**
 * Get control panel base URL for SSO redirect
 */
export function getControlPanelUrl(): string {
  return process.env.CONTROL_EXTERNAL_URL || "";
}
