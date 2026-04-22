/**
 * Auth Provider Queries
 *
 * Manages auth providers (OAuth2, shared API keys) and user tokens.
 * Auth providers enable credential reuse across multiple connectors —
 * e.g., one Google login serves Maps, Photos, and Drive connectors.
 */

import { db, ensureSchema } from "@/db";
import { authProviders, userAuthTokens, userConnectorSecrets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";

const ENCRYPTION_KEY = process.env.CONNECTOR_ENCRYPTION_KEY || "youeye-dev-key-32bytes-padding!";

function getKey(): Buffer {
  return Buffer.from(ENCRYPTION_KEY.padEnd(32, "!").slice(0, 32));
}

function encrypt(value: string): { encrypted: string; nonce: string } {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, authTag]).toString("base64"),
    nonce: iv.toString("base64"),
  };
}

function decrypt(encrypted: string, nonce: string): string {
  try {
    const key = getKey();
    const iv = Buffer.from(nonce, "base64");
    const data = Buffer.from(encrypted, "base64");
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  } catch {
    return "";
  }
}

// ─── Provider CRUD ───────────────────────────────────

export async function listProviders() {
  await ensureSchema();
  return db.select().from(authProviders);
}

export async function getProvider(slug: string) {
  await ensureSchema();
  const [p] = await db.select().from(authProviders).where(eq(authProviders.slug, slug)).limit(1);
  return p ?? null;
}

export async function getProviderById(id: string) {
  await ensureSchema();
  const [p] = await db.select().from(authProviders).where(eq(authProviders.id, id)).limit(1);
  return p ?? null;
}

export async function createProvider(data: {
  slug: string;
  name: string;
  type: string;
  clientId?: string;
  clientSecret?: string;
  authUrl?: string;
  tokenUrl?: string;
  defaultScopes?: string;
  config?: Record<string, unknown>;
}) {
  await ensureSchema();
  let clientSecretEncrypted: string | null = null;
  let clientSecretNonce: string | null = null;

  if (data.clientSecret) {
    const enc = encrypt(data.clientSecret);
    clientSecretEncrypted = enc.encrypted;
    clientSecretNonce = enc.nonce;
  }

  const [provider] = await db
    .insert(authProviders)
    .values({
      slug: data.slug,
      name: data.name,
      type: data.type,
      clientId: data.clientId ?? null,
      clientSecretEncrypted,
      clientSecretNonce,
      authUrl: data.authUrl ?? null,
      tokenUrl: data.tokenUrl ?? null,
      defaultScopes: data.defaultScopes ?? null,
      config: data.config ?? {},
    })
    .returning();

  return provider;
}

export async function updateProvider(
  id: string,
  data: Partial<{
    name: string;
    clientId: string;
    clientSecret: string;
    authUrl: string;
    tokenUrl: string;
    defaultScopes: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>
) {
  await ensureSchema();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (data.name !== undefined) updates.name = data.name;
  if (data.clientId !== undefined) updates.clientId = data.clientId;
  if (data.authUrl !== undefined) updates.authUrl = data.authUrl;
  if (data.tokenUrl !== undefined) updates.tokenUrl = data.tokenUrl;
  if (data.defaultScopes !== undefined) updates.defaultScopes = data.defaultScopes;
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.config !== undefined) updates.config = data.config;

  if (data.clientSecret !== undefined) {
    const enc = encrypt(data.clientSecret);
    updates.clientSecretEncrypted = enc.encrypted;
    updates.clientSecretNonce = enc.nonce;
  }

  await db.update(authProviders).set(updates).where(eq(authProviders.id, id));
}

export async function deleteProvider(id: string) {
  await ensureSchema();
  await db.delete(authProviders).where(eq(authProviders.id, id));
}

// ─── User Tokens ─────────────────────────────────────

export async function getUserToken(userId: string, providerId: string) {
  await ensureSchema();
  const [token] = await db
    .select()
    .from(userAuthTokens)
    .where(
      and(eq(userAuthTokens.userId, userId), eq(userAuthTokens.providerId, providerId))
    )
    .limit(1);
  return token ?? null;
}

export async function getDecryptedUserToken(userId: string, providerId: string) {
  const token = await getUserToken(userId, providerId);
  if (!token) return null;

  return {
    accessToken: decrypt(token.accessTokenEncrypted, token.accessTokenNonce),
    refreshToken: token.refreshTokenEncrypted && token.refreshTokenNonce
      ? decrypt(token.refreshTokenEncrypted, token.refreshTokenNonce)
      : null,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    boundHosts: token.boundHosts,
  };
}

export async function saveUserToken(
  userId: string,
  providerId: string,
  data: {
    accessToken: string;
    refreshToken?: string;
    scopes?: string;
    expiresAt?: Date;
    boundHosts?: string;
  }
) {
  await ensureSchema();

  const accessEnc = encrypt(data.accessToken);
  let refreshEnc: { encrypted: string; nonce: string } | null = null;
  if (data.refreshToken) {
    refreshEnc = encrypt(data.refreshToken);
  }

  const existing = await getUserToken(userId, providerId);

  if (existing) {
    await db
      .update(userAuthTokens)
      .set({
        accessTokenEncrypted: accessEnc.encrypted,
        accessTokenNonce: accessEnc.nonce,
        refreshTokenEncrypted: refreshEnc?.encrypted ?? null,
        refreshTokenNonce: refreshEnc?.nonce ?? null,
        scopes: data.scopes ?? null,
        expiresAt: data.expiresAt ?? null,
        boundHosts: data.boundHosts ?? null,
        updatedAt: new Date(),
      })
      .where(eq(userAuthTokens.id, existing.id));
  } else {
    await db.insert(userAuthTokens).values({
      userId,
      providerId,
      accessTokenEncrypted: accessEnc.encrypted,
      accessTokenNonce: accessEnc.nonce,
      refreshTokenEncrypted: refreshEnc?.encrypted ?? null,
      refreshTokenNonce: refreshEnc?.nonce ?? null,
      scopes: data.scopes ?? null,
      expiresAt: data.expiresAt ?? null,
      boundHosts: data.boundHosts ?? null,
    });
  }
}

export async function deleteUserToken(userId: string, providerId: string) {
  await ensureSchema();
  await db
    .delete(userAuthTokens)
    .where(
      and(eq(userAuthTokens.userId, userId), eq(userAuthTokens.providerId, providerId))
    );
}

/**
 * Check if a token is expired and needs refresh.
 */
export function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false; // no expiry = never expires (API keys)
  return new Date() >= expiresAt;
}

/**
 * Refresh an OAuth2 token using the refresh_token grant.
 * Returns the new token data or null if refresh fails.
 */
export async function refreshOAuth2Token(
  userId: string,
  providerId: string
): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
  const provider = await getProviderById(providerId);
  if (!provider || provider.type !== "oauth2" || !provider.tokenUrl) return null;

  const token = await getDecryptedUserToken(userId, providerId);
  if (!token?.refreshToken) return null;

  // Decrypt client secret
  let clientSecret = "";
  if (provider.clientSecretEncrypted && provider.clientSecretNonce) {
    clientSecret = decrypt(provider.clientSecretEncrypted, provider.clientSecretNonce);
  }

  try {
    const res = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: provider.clientId ?? "",
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

    await saveUserToken(userId, providerId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? token.refreshToken,
      scopes: data.scope ?? token.scopes,
      expiresAt,
      boundHosts: token.boundHosts,
    });

    return { accessToken: data.access_token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Get a valid access token for a provider, refreshing if needed.
 */
export async function getValidAccessToken(
  userId: string,
  providerId: string
): Promise<string | null> {
  const token = await getDecryptedUserToken(userId, providerId);
  if (!token) return null;

  if (isTokenExpired(token.expiresAt)) {
    const refreshed = await refreshOAuth2Token(userId, providerId);
    return refreshed?.accessToken ?? null;
  }

  return token.accessToken;
}

/**
 * Propagate auth provider credentials to connector secrets.
 * When a user authenticates with a provider, update all connectors
 * that reference this provider with the latest token.
 */
export async function propagateProviderCredentials(
  userId: string,
  providerId: string,
  accessToken: string,
  boundHosts?: string
) {
  await ensureSchema();

  // Find all connector secrets linked to this provider
  const linkedSecrets = await db
    .select()
    .from(userConnectorSecrets)
    .where(
      and(
        eq(userConnectorSecrets.userId, userId),
        eq(userConnectorSecrets.authProviderId, providerId)
      )
    );

  // Update each linked secret with the fresh token
  for (const secret of linkedSecrets) {
    const enc = encrypt(accessToken);
    await db
      .update(userConnectorSecrets)
      .set({
        encryptedValue: enc.encrypted,
        nonce: enc.nonce,
        boundHost: boundHosts?.split(",")[0] ?? secret.boundHost,
      })
      .where(eq(userConnectorSecrets.id, secret.id));
  }

  return linkedSecrets.length;
}
