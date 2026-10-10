import { createHash } from "node:crypto";
import { isCanonicalAppId, parseAppBearer } from "../../../../shared/app-service-credential";
import {
  isActiveAppCredential, parseAppCredentialProjection,
} from "../../../../shared/app-service-credential";

export interface AppBearerRegistration {
  appId: string;
  enabled: boolean | null;
  projection?: unknown;
  ready?: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The registration lookup receives a verifier hash only. No lookup failure,
 * disabled registration or ambiguous match may authenticate an application.
 * Generation/admission enforcement remains a separate lifecycle integration.
 */
export async function validateRegisteredAppBearer(
  headers: Headers,
  lookup: (verifierHash: string) => Promise<AppBearerRegistration[]>,
  purpose: 'service' | 'probe' = 'service',
): Promise<{ appId: string } | null> {
  if (headers.has('x-ui-bridge-token') || headers.has('x-app-slug')) return null;
  const token = parseAppBearer(headers);
  if (!token) return null;
  try {
    const matches = await lookup(hashToken(token));
    if (matches.length !== 1 || matches[0].enabled !== true
      || !isCanonicalAppId(matches[0].appId)) return null;
    const credential = parseAppCredentialProjection(matches[0].projection);
    if (credential.appId !== matches[0].appId
      || (headers.has('x-youeye-app') && headers.get('x-youeye-app') !== credential.appId)
      || credential.verifierHash !== hashToken(token)
      || !isActiveAppCredential(credential)
      || (purpose === 'service' && matches[0].ready !== true)) return null;
    return { appId: credential.appId };
  } catch {
    return null;
  }
}
